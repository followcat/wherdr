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
import { machineOf, sessionScopeOf } from '../../shared/ids'
import type { ChatItem, HerdrState, MachineInfo, Pane, SessionInfo } from '../../shared/types'
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
// Scope written in the IDs of a secondary session (primary keeps its historical unprefixed IDs).
export const sessionIdScope = (socketPath: string) => sha16(`session:${socketPath}`)

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
  enrich?: (entry: CoreEntry, state: HerdrState) => Promise<void> | void
  onAlert?: (entry: CoreEntry, machineKey: string, address: string, kind: CoreAlertKind) => void
  onEvent?: (entry: CoreEntry, event: CoreEvent, before: CoreTerminal | undefined, after: CoreTerminal | undefined) => void
  onChange?: (entry: CoreEntry, what: 'terminal' | 'doc' | 'snapshot') => void
  onStatus?: (entry: CoreEntry, connected: boolean) => void
  onPoll?: (entry: CoreEntry) => void
}

export interface CoreEntry {
  readonly primary: boolean
  readonly endpoint: string
  readonly localKey: string
  readonly sessionKey: string
  readonly sessionName: string
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
  void endpoint
  if (!address.includes('/')) return ''
  return hexKey(address.split('/')[0]!)
}

const STATUS_RANK: Record<MachineInfo['status'], number> = { offline: 0, connecting: 1, online: 2 }

function mergeSessionMachines(input: readonly { entry: CoreEntry, machines: readonly MachineInfo[] }[]): MachineInfo[] {
  const out = new Map<string, MachineInfo>()
  for (const { entry, machines } of input) {
    for (const machine of machines) {
      const key = machine.key
      const prev = out.get(key)
      const sessionInfo = { label: machine.label, status: machine.status, error: machine.error }
      if (!prev) {
        out.set(key, { ...machine, sessions: { [entry.sessionName]: sessionInfo } })
        continue
      }
      prev.sessions = { ...(prev.sessions ?? {}), [entry.sessionName]: sessionInfo }
      if (STATUS_RANK[machine.status] > STATUS_RANK[prev.status]) {
        prev.status = machine.status
        prev.error = machine.error
      } else if (prev.status === machine.status && prev.error === null) {
        prev.error = machine.error
      }
      if (!prev.label || (entry.primary && machine.label)) prev.label = machine.label
    }
  }
  return [...out.values()]
}

export function createCorePool(opts: CorePoolOptions): CorePool {
  const hostLabel = opts.hostLabel ?? (() => os.hostname())
  let primaryMachinesRaw: CoreMachine[] = []
  let started = false
  let primaryEntry: CoreEntry | undefined
  let extraEntries: CoreEntry[] = []

  const makeEntry = (endpoint: string, primary: boolean): CoreEntry => {
    const localKey = ''
    const sessionKey = primary ? '' : sessionIdScope(endpoint)
    const sName = sessionLabel(endpoint)
    const idScope = primary ? undefined : sessionIdScope(endpoint)
    const docsReader = createCoreDocsReader()
    let generation = 0
    let reapedSnapshot = false
    let cache: { at: number; machines: CoreMachine[]; docs: CoreDocs } | null = null
    let lastTerminals: CoreTerminal[] = []
    let lastError: string | null = null
    let currentState: HerdrState = primary
      ? { ok: true, ready: false, workspaces: [], panes: [], machines: [{ key: '', label: hostLabel(), local: true, status: 'offline', error: null }] }
      : { ok: true, ready: true, workspaces: [], tabs: [], panes: [], machines: [{ key: localKey, label: hostLabel(), local: true, status: 'offline', error: null }] }

    const call = <T>(method: string, params: object = {}, timeout = opts.callTimeoutMs) => coreCall<T>(endpoint, method, params, timeout)

    const reaper = createCoreReaper({ call: (method, params, timeout) => call(method, params, timeout) })
    const reapExited = (list: CoreTerminal[]) => {
      const now = Date.now()
      for (const t of list) reaper.maybeReap(t, now)
    }

    const alerts = createCoreAlerts({
      settleMs: opts.settleMs ?? DEFAULT_ALERT_SETTLE_MS,
      current: address => session.get(address),
      send: (address, kind) => opts.onAlert?.(entry, machineKeyOfAddress(primary, endpoint, address), address, kind),
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

    // Canonical key of the real machine, shared by every session. A host match on
    // the primary session wins; otherwise the physical host key, falling back to
    // the machine name when core does not know the host.
    const canonicalRemoteKey = (m: CoreMachine) => {
      if (m.host) {
        const match = primaryMachinesRaw.find(pm => pm.host && pm.host === m.host)
        if (match) return hexKey(match.name)
        return hostBaseKey(m.host)
      }
      return hexKey(m.name)
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
          : coreState(terminals, machines, docs, hostLabel(), { session: sName })
      }
      const stateOpts: CoreStateOptions = {
        localKey,
        localStatus: offlineErr ? 'offline' : 'online',
        localError: offlineErr,
        session: sName,
        idScope,
        machineKey: name => canonicalRemoteKey(machines.find(x => x.name === name) ?? { name, state: '' }),
      }
      if (offlineErr) {
        return {
          ok: true,
          ready: true,
          workspaces: [],
          tabs: [],
          panes: [],
          machines: [
            { key: localKey, label: hostLabel(), local: true, status: 'offline', error: offlineErr },
            ...(cache?.machines ?? []).map((m): MachineInfo => ({
              key: canonicalRemoteKey(m),
              label: m.name,
              local: false,
              status: 'offline',
              error: m.why ?? null,
            })),
          ],
        }
      }
      return coreState(terminals, machines, docs, hostLabel(), stateOpts)
    }

    let inFlight: Promise<HerdrState> | null = null
    let pendingState: HerdrState | null = null
    const runPoll = async (): Promise<HerdrState> => {
      const gen = generation
      let candidate: HerdrState
      let ok = false
      try {
        const held = session.snapshot()
        if (held && !reapedSnapshot) { reapedSnapshot = true; reapExited(held) }
        const terminals = held ?? [...liveTerminals((await call<CoreInventory>('terminal.list')).terminals).values()]
        if (!held) reapExited(terminals)
        if (!cache || Date.now() - cache.at > MACHINES_MS || !held) {
          const machines = (await call<{ machines: CoreMachine[] }>('machine.list')).machines
          const docs = await docsReader.read((m, p) => call(m, p), machines)
          if (gen !== generation) return await runPoll()
          cache = { at: Date.now(), machines, docs }
        }
        lastTerminals = terminals
        lastError = null
        if (primary) primaryMachinesRaw = cache.machines
        candidate = computeState(terminals, cache.machines, cache.docs, null)
        ok = true
      } catch (e) {
        lastError = errorText(e)
        candidate = computeState(lastTerminals, cache?.machines ?? [], cache?.docs ?? {}, lastError)
      }
      // Enrich candidate before assigning currentState so concurrent polls or
      // broadcasts never see un-enriched panes. Skip when primary is offline
      // because its candidate reuses the previously enriched panes array.
      if (opts.enrich && (ok || candidate.ok !== false)) {
        pendingState = candidate
        try { await opts.enrich(entry, candidate) } catch { /* enrichment failure keeps candidate state */ } finally { pendingState = null }
      }
      currentState = candidate
      opts.onPoll?.(entry)
      if (ok && gen !== generation) return await runPoll()
      return refreshedState()
    }

    const poll = () => {
      if (inFlight) return inFlight
      inFlight = runPoll().finally(() => { inFlight = null })
      return inFlight
    }

    const refreshedState = (): HerdrState => currentState

    const ownsMachine = (mk: string) => {
      if (mk === '') return primary
      if (mk === localKey) return true
      if (cache?.machines.some(m => (primary ? hexKey(m.name) : canonicalRemoteKey(m)) === mk)) return true
      if (currentState.machines?.some(m => m.key === mk)) return true
      if (pendingState?.machines?.some(m => m.key === mk)) return true
      return currentState.panes.some(p => p.machine === mk) || Boolean(pendingState?.panes.some(p => p.machine === mk))
    }

    const entry: CoreEntry = {
      primary,
      endpoint,
      localKey,
      sessionKey,
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
    const workspaces = states.flatMap(s => s.workspaces)
    const tabs = states.flatMap(s => s.tabs ?? [])
    const panes = states.flatMap(s => s.panes)
    const machines = mergeSessionMachines(entries.map((entry, i) => ({ entry, machines: states[i]!.machines ?? [] })))
    const sessions: SessionInfo[] = entries.map((entry, i) => ({
      key: entry.sessionKey,
      name: entry.sessionName,
      primary: entry.primary,
      status: states[i]?.machines?.find(m => m.local)?.status ?? 'offline',
    }))
    return {
      ok: first.ok,
      ready: first.ready,
      ...(first.error ? { error: first.error } : {}),
      session: entries[0]?.sessionName,
      workspaces: workspaces.slice(0, MAX_STATE_KEYS),
      tabs,
      panes,
      machines,
      sessions,
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
    const scope = sessionScopeOf(paneId)
    if (scope) {
      const byScope = allEntries().find(e => !e.primary && `s${sessionIdScope(e.endpoint)}` === scope)
      if (byScope) return byScope
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
