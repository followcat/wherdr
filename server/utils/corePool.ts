import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { coreCall } from './core'
import { CoreSession } from './coreSession'
import { createCoreAlerts, type CoreAlertKind } from './coreAlerts'
import { createCoreReaper, shouldReapExited, type ReapCandidate } from './coreReap'
import { createCoreDocsReader } from './readCoreDocs'
import { clearBacklotDocs } from './backlotDocs'
import { coreState, type CoreMachine, type CoreStateOptions } from '../../shared/coreState'
import type { CoreEvent } from '../../shared/coreEvents'
import { liveTerminals } from '../../shared/coreEvents'
import type { CoreInventory, CoreTerminal } from '../../shared/coreInventory'
import type { CoreDocs } from '../../shared/coreLayout'
import { machineOf } from '../../shared/ids'
import type { ChatItem, HerdrState, MachineInfo, Pane } from '../../shared/types'
import type { ClaudeAsked } from './choices'

const MACHINES_MS = 4000
const DEFAULT_ALERT_SETTLE_MS = 500
const MAX_STATE_KEYS = 2000

const sha16 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)
const hexKey = (value: string) => Buffer.from(value, 'utf8').toString('hex')
const expandHome = (p: string, home = os.homedir()) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p)
const errorText = (e: unknown) => (e instanceof Error && e.message) || 'Cannot read herdr-core inventory'

export const secondaryLocalKey = (socketPath: string) => sha16(`local:${socketPath}`)
export const secondaryRemoteKey = (socketPath: string, machineName: string) => sha16(`remote:${socketPath}:${machineName}`)
export const hostBaseKey = (host: string) => sha16(`host:${host}`)

export function parseHcSocketsEnv(raw: string | undefined, home = os.homedir()): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const resolved = path.resolve(expandHome(trimmed, home))
    if (seen.has(resolved)) continue
    seen.add(resolved)
    out.push(resolved)
  }
  return out
}

export function resolveConfiguredSockets(input: {
  primary?: string
  envSockets?: string
  settingsSockets?: string[]
  home?: string
}): { primary: string; extra: string[] } {
  const home = input.home ?? os.homedir()
  const resolveOne = (s: string) => path.resolve(expandHome(s.trim(), home))
  const primary = input.primary?.trim() ? resolveOne(input.primary) : ''
  const seen = new Set<string>()
  if (primary) seen.add(primary)
  const extra: string[] = []
  const add = (p: string) => {
    if (!p || seen.has(p)) return
    seen.add(p)
    extra.push(p)
  }
  for (const s of parseHcSocketsEnv(input.envSockets, home)) add(s)
  for (const raw of input.settingsSockets ?? []) {
    const trimmed = typeof raw === 'string' ? raw.trim() : ''
    if (trimmed) add(resolveOne(trimmed))
  }
  return { primary, extra }
}

export interface CorePoolOptions {
  primary?: string
  extra?: string[]
  hostLabel?: () => string
  settleMs?: number
  callTimeoutMs?: number
  onAlert?: (machineKey: string, address: string, kind: CoreAlertKind) => void
  onEvent?: (entry: CoreEntry, event: CoreEvent, before: CoreTerminal | undefined, after: CoreTerminal | undefined) => void
  onChange?: (entry: CoreEntry, what: 'terminal' | 'doc' | 'snapshot') => void
  onStatus?: (entry: CoreEntry, connected: boolean) => void
  onPoll?: (entry: CoreEntry) => void
}

export interface CoreEntry {
  readonly primary: boolean
  readonly endpoint: string
  readonly localKey: string
  readonly sessionName: string | undefined
  readonly session: CoreSession
  call: <T>(method: string, params?: object, timeout?: number) => Promise<T>
  machines: () => CoreMachine[]
  snapshot: () => CoreTerminal[] | null
  state: () => HerdrState
  poll: () => Promise<HerdrState>
  staleDocs: () => void
  ownsMachine: (machineKey: string) => boolean
  start: () => void
  stop: () => void
}

export interface CorePool {
  entries: () => CoreEntry[]
  primary: () => CoreEntry | undefined
  forPane: (paneId: unknown) => CoreEntry | undefined
  forMachine: (machineKey: unknown) => CoreEntry | undefined
  findPane: (paneId: string) => Pane | undefined
  state: () => HerdrState
  poll: () => Promise<HerdrState>
  settle: () => Promise<HerdrState>
  staleDocs: () => void
  reconfigure: (next: { primary?: string; extra: string[] }) => void
  start: () => void
  stop: () => void
}

const sessionLabel = (endpoint: string) => {
  const base = path.basename(endpoint).replace(/\.sock$/, '')
  return base || endpoint
}

function machineKeyOfAddress(primary: boolean, endpoint: string, address: string): string {
  if (!address.includes('/')) return primary ? '' : secondaryLocalKey(endpoint)
  const name = address.split('/')[0]!
  return primary ? hexKey(name) : secondaryRemoteKey(endpoint, name)
}

export function createCorePool(opts: CorePoolOptions): CorePool {
  const hostLabel = opts.hostLabel ?? (() => os.hostname())
  let primaryMachinesRaw: CoreMachine[] = []
  let started = false
  let primaryEntry: CoreEntry | undefined
  let extraEntries: CoreEntry[] = []

  const makeEntry = (endpoint: string, primary: boolean): CoreEntry => {
    const localKey = primary ? '' : secondaryLocalKey(endpoint)
    const sName = primary ? undefined : sessionLabel(endpoint)
    const docsReader = createCoreDocsReader()
    let generation = 0
    let reapedSnapshot = false
    let cache: { at: number; machines: CoreMachine[]; docs: CoreDocs } | null = null
    let lastTerminals: CoreTerminal[] = []
    let lastError: string | null = null
    let currentState: HerdrState = primary
      ? { ok: true, ready: false, workspaces: [], panes: [], machines: [{ key: '', label: hostLabel(), local: true, status: 'offline', error: null }] }
      : { ok: true, ready: true, workspaces: [], tabs: [], panes: [], machines: [{ key: localKey, baseKey: '', session: sName, label: hostLabel(), local: true, status: 'offline', error: null }] }

    const call = <T>(method: string, params: object = {}, timeout = opts.callTimeoutMs) => coreCall<T>(endpoint, method, params, timeout)

    const reaper = createCoreReaper({ call: (method, params, timeout) => call(method, params, timeout) })
    const reapExited = (list: CoreTerminal[]) => {
      const now = Date.now()
      for (const t of list) reaper.maybeReap(t, now)
    }

    const alerts = createCoreAlerts({
      settleMs: opts.settleMs ?? DEFAULT_ALERT_SETTLE_MS,
      current: address => session.get(address),
      send: (address, kind) => opts.onAlert?.(machineKeyOfAddress(primary, endpoint, address), address, kind),
    })

    const session = new CoreSession({
      endpoint,
      onEvent: (event, before, after) => {
        alerts.onEvent(event, before, after)
        if (event.type === 'finished' && event.terminal) reaper.maybeReap({ ...before, state: 'finished', ...(event.data ?? {}) } as ReapCandidate)
        opts.onEvent?.(entry, event, before, after)
      },
      onChange: (what) => {
        if (what === 'doc' || what === 'snapshot') staleDocs()
        opts.onChange?.(entry, what)
      },
      onStatus: (connected) => {
        if (!connected) reapedSnapshot = false
        opts.onStatus?.(entry, connected)
      },
    })

    const staleDocs = () => { generation++; cache = null; docsReader.clear(); clearBacklotDocs() }

    const remoteBaseKey = (m: CoreMachine) => {
      if (!m.host) return undefined
      const match = primaryMachinesRaw.find(pm => pm.host && pm.host === m.host)
      return match ? hexKey(match.name) : hostBaseKey(m.host)
    }

    const computeState = (terminals: CoreTerminal[], machines: CoreMachine[], docs: CoreDocs, offlineErr: string | null): HerdrState => {
      if (primary) {
        return offlineErr
          ? {
              ...currentState,
              ok: false,
              ready: true,
              error: offlineErr,
              machines: currentState.machines?.map(m => ({ ...m, status: 'offline' as const })),
            }
          : coreState(terminals, machines, docs, hostLabel())
      }
      const stateOpts: CoreStateOptions = {
        localKey,
        localBaseKey: '',
        localStatus: offlineErr ? 'offline' : 'online',
        localError: offlineErr,
        session: sName,
        machineKey: name => secondaryRemoteKey(endpoint, name),
        machineBaseKey: remoteBaseKey,
      }
      if (offlineErr) {
        return {
          ok: true,
          ready: true,
          workspaces: [],
          tabs: [],
          panes: [],
          machines: [
            { key: localKey, baseKey: '', ...(sName ? { session: sName } : {}), label: hostLabel(), local: true, status: 'offline', error: offlineErr },
            ...(cache?.machines ?? []).map((m): MachineInfo => {
              const baseKey = remoteBaseKey(m)
              return {
                key: secondaryRemoteKey(endpoint, m.name),
                ...(baseKey !== undefined ? { baseKey } : {}),
                ...(sName ? { session: sName } : {}),
                label: m.name,
                local: false,
                status: 'offline',
                error: m.why ?? null,
              }
            }),
          ],
        }
      }
      return coreState(terminals, machines, docs, hostLabel(), stateOpts)
    }

    let inFlight: Promise<HerdrState> | null = null
    const runPoll = async (): Promise<HerdrState> => {
      try {
        const held = session.snapshot()
        if (held && !reapedSnapshot) { reapedSnapshot = true; reapExited(held) }
        const terminals = held ?? [...liveTerminals((await call<CoreInventory>('terminal.list')).terminals).values()]
        if (!held) reapExited(terminals)
        const gen = generation
        if (!cache || Date.now() - cache.at > MACHINES_MS || !held) {
          const machines = (await call<{ machines: CoreMachine[] }>('machine.list')).machines
          const docs = await docsReader.read((m, p) => call(m, p), machines)
          if (gen !== generation) return await runPoll()
          cache = { at: Date.now(), machines, docs }
        }
        lastTerminals = terminals
        lastError = null
        if (primary) primaryMachinesRaw = cache.machines
        currentState = computeState(terminals, cache.machines, cache.docs, null)
        opts.onPoll?.(entry)
        return refreshedState()
      } catch (e) {
        lastError = errorText(e)
        currentState = computeState(lastTerminals, cache?.machines ?? [], cache?.docs ?? {}, lastError)
        opts.onPoll?.(entry)
        return refreshedState()
      }
    }

    const poll = () => {
      if (inFlight) return inFlight
      inFlight = runPoll().finally(() => { inFlight = null })
      return inFlight
    }

    const refreshedState = (): HerdrState => {
      if (!primary && cache && currentState.machines) {
        for (const rm of cache.machines) {
          const mk = secondaryRemoteKey(endpoint, rm.name)
          const mi = currentState.machines.find(x => x.key === mk)
          if (!mi) continue
          const baseKey = remoteBaseKey(rm)
          if (baseKey !== undefined) mi.baseKey = baseKey
          else delete mi.baseKey
        }
      }
      return currentState
    }

    const ownsMachine = (mk: string) => {
      if (mk === '') return primary
      if (mk === localKey) return true
      if (cache?.machines.some(m => (primary ? hexKey(m.name) : secondaryRemoteKey(endpoint, m.name)) === mk)) return true
      if (currentState.machines?.some(m => m.key === mk)) return true
      return currentState.panes.some(p => p.machine === mk)
    }

    const entry: CoreEntry = {
      primary,
      endpoint,
      localKey,
      sessionName: sName,
      session,
      call,
      machines: () => cache?.machines ?? [],
      snapshot: () => session.snapshot() ?? (lastTerminals.length ? lastTerminals : null),
      state: refreshedState,
      poll,
      staleDocs,
      ownsMachine,
      start: () => session.start(),
      stop: () => { session.stop(); alerts.stop(); docsReader.clear() },
    }
    return entry
  }

  const allEntries = (): CoreEntry[] => [...(primaryEntry ? [primaryEntry] : []), ...extraEntries]

  const syncConfig = (next: { primary?: string; extra: string[] }) => {
    const nextPrimary = next.primary?.trim() || ''
    if (!nextPrimary) {
      primaryEntry?.stop()
      primaryEntry = undefined
      primaryMachinesRaw = []
    } else if (!primaryEntry || primaryEntry.endpoint !== nextPrimary) {
      primaryEntry?.stop()
      primaryMachinesRaw = []
      primaryEntry = makeEntry(nextPrimary, true)
      if (started) primaryEntry.start()
    }

    const wanted = [...new Set(next.extra.map(s => s.trim()).filter(s => s && s !== nextPrimary))]
    const existingByEndpoint = new Map(extraEntries.map(e => [e.endpoint, e]))
    const nextExtras: CoreEntry[] = []
    for (const ep of wanted) {
      const kept = existingByEndpoint.get(ep)
      if (kept) {
        existingByEndpoint.delete(ep)
        nextExtras.push(kept)
      } else {
        const created = makeEntry(ep, false)
        if (started) created.start()
        nextExtras.push(created)
      }
    }
    for (const stale of existingByEndpoint.values()) stale.stop()
    extraEntries = nextExtras
  }

  syncConfig({ primary: opts.primary, extra: opts.extra ?? [] })

  const state = (): HerdrState => {
    const entries = allEntries()
    if (!entries.length) {
      return { ok: false, ready: true, error: 'Missing core endpoint', workspaces: [], panes: [], machines: [{ key: '', label: hostLabel(), local: true, status: 'offline', error: null }] }
    }
    const states = entries.map(e => e.state())
    const first = states[0]!
    if (states.length === 1) return first
    const workspaces = states.flatMap(s => s.workspaces)
    const tabs = states.flatMap(s => s.tabs ?? [])
    const panes = states.flatMap(s => s.panes)
    const machines = states.flatMap(s => s.machines ?? [])
    return {
      ok: first.ok,
      ready: first.ready,
      ...(first.error ? { error: first.error } : {}),
      workspaces: workspaces.slice(0, MAX_STATE_KEYS),
      tabs,
      panes,
      machines,
    }
  }

  const findPane = (paneId: string) => {
    for (const e of allEntries()) {
      const p = e.state().panes.find(x => x.id === paneId)
      if (p) return p
    }
    return undefined
  }

  const forMachine = (machineKey: unknown): CoreEntry | undefined => {
    const mk = typeof machineKey === 'string' ? machineKey : ''
    if (!mk) return primaryEntry
    return allEntries().find(e => e.ownsMachine(mk))
  }

  const forPane = (paneId: unknown): CoreEntry | undefined => {
    if (typeof paneId !== 'string' || !paneId) return undefined
    for (const e of allEntries()) {
      if (e.state().panes.some(p => p.id === paneId)) return e
    }
    const mk = machineOf(paneId)
    return mk === '' ? primaryEntry : forMachine(mk)
  }

  const staleDocs = () => { for (const e of allEntries()) e.staleDocs() }

  const poll = async (): Promise<HerdrState> => {
    await Promise.allSettled(allEntries().map(e => e.poll()))
    return state()
  }

  const settle = async (): Promise<HerdrState> => {
    staleDocs()
    return poll()
  }

  return {
    entries: allEntries,
    primary: () => primaryEntry,
    forPane,
    forMachine,
    findPane,
    state,
    poll,
    settle,
    staleDocs,
    reconfigure: syncConfig,
    start: () => { started = true; for (const e of allEntries()) e.start() },
    stop: () => { started = false; for (const e of allEntries()) e.stop() },
  }
}

export interface PoolRuntime {
  primary: () => CoreEntry | undefined
  forPane: (paneId: unknown) => CoreEntry | undefined
  forMachine: (machineKey: unknown) => CoreEntry | undefined
  findPane: (id: string | null | undefined) => Pane | undefined
  getState: () => HerdrState
  poll: () => Promise<unknown>
  wakeCorePoll: (paneOrMachine?: string) => void
  isViewed: (paneId: string) => boolean
  noteModelScreen: (p: Pane, text: string) => void
  pendingClaudeQuestions: (p: Pane) => Promise<ClaudeAsked[]>
  takeBack: (paneId: string, item: { text: string, ts?: string | null, images?: number }) => { text: string, lost: number }
  takeBackFromClaude: (p: Pane, io: { screen: () => Promise<string>, keys: (keys: string[]) => Promise<void> }) => Promise<ChatItem | null>
}

let activeRuntime: PoolRuntime | null = null
export function registerPoolRuntime(next: PoolRuntime) { activeRuntime = next }
export function getPoolRuntime(): PoolRuntime | null { return activeRuntime }
