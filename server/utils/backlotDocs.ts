// The "backlot" document of this core and of each connected machine, read only.
// Cached for a few seconds (a remote read goes over ssh); a missing, unreadable
// or invalid document counts as none, so a user without backlot sees nothing.
import crypto from 'node:crypto'
import type { BacklotMachineView, BacklotSummary } from '../../shared/backlot'
import { parseBacklotDoc } from '../../shared/backlot'
import type { CoreMachine } from '../../shared/coreState'
import type { CoreTerminal } from '../../shared/coreInventory'
import { isBacklotDaemonTerminal } from '../../shared/backlotDaemon'
import { localMachineLabel } from './machines'

const TTL = 4000
type Call = <T>(method: string, params: object, timeout?: number) => Promise<T>

const ended = (state: string) => state === 'finished' || state === 'lost'
const machineOf = (address: string) => (address.includes('/') ? address.split('/')[0]! : '')
const isStage = (t: CoreTerminal) => isBacklotDaemonTerminal(t)

const prefixRemoteTerminals = (doc: BacklotSummary, machine: string): BacklotSummary => !machine ? doc : {
  ...doc,
  studios: doc.studios.map(s => ({
    ...s,
    roles: s.roles.map(r => ({
      ...r,
      terminal: r.terminal && !r.terminal.includes('/') ? `${machine}/${r.terminal}` : r.terminal,
    })),
  })),
}

// A live terminal named backlot-stage / backlot-server, or carrying their role labels.
export function stageRunning(terminals: CoreTerminal[], machine: string): boolean {
  return terminals.some(t => Boolean(t) && !ended(t.state) && machineOf(t.address) === machine && isStage(t))
}

export function createBacklotDocsReader(hostLabel = localMachineLabel) {
  const cache = new Map<string, { at: number; doc: BacklotSummary | null }>()
  return {
    async read(call: Call, machines: CoreMachine[], terminals: CoreTerminal[], now = Date.now(), session = ''): Promise<BacklotMachineView[]> {
      const names = ['', ...machines.filter(m => m.state === 'connected').map(m => m.name)]
      for (const known of cache.keys()) if (!names.includes(known)) cache.delete(known)
      const docs = await Promise.all(names.map(async (name) => {
        const old = cache.get(name)
        if (old && now - old.at < TTL) return [name, old.doc] as const
        let doc: BacklotSummary | null = null
        try {
          const value = (await call<{ value?: unknown }>('doc.get', { name: 'backlot', ...(name ? { on: name } : {}) }, 4000))?.value
          const parsed = parseBacklotDoc(value)
          doc = parsed ? prefixRemoteTerminals(parsed, name) : null
        } catch { doc = old?.doc ?? null }
        cache.set(name, { at: now, doc })
        return [name, doc] as const
      }))
      const out: BacklotMachineView[] = []
      for (const [name, doc] of docs) {
        if (!doc) continue
        out.push({
          session,
          machine: name,
          label: name || hostLabel(),
          stageRunning: stageRunning(terminals, name),
          backlotVersion: doc.backlot_version ?? null,
          summary: doc,
        })
      }
      return out
    },
    clear() { cache.clear() },
  }
}

const defaultReader = createBacklotDocsReader()
const poolReaders = new Map<string, ReturnType<typeof createBacklotDocsReader>>()
const poolCoreIds = new Map<string, string | null>() // entry id -> core.id from hello (cached)
const poolPublishers = new Map<string, string>() // `${session}\0${machine}` -> entry key (`localKey\0endpoint`)

export interface BacklotPoolEntry {
  localKey: string
  endpoint: string
  primary?: boolean
  sessionKey?: string
  call: Call
  terminals?: () => CoreTerminal[] | null
  snapshot?: () => CoreTerminal[] | null
  machines?: () => CoreMachine[]
}

const sha16 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)
const entryId = (entry: Pick<BacklotPoolEntry, 'localKey' | 'endpoint'>) => `${entry.localKey}\0${entry.endpoint}`
const publisherKey = (session: string, machine: string) => `${session}\0${machine}`

// Same session key that CorePool emits on SessionInfo (`''` for primary, `sessionIdScope` for others).
export function backlotEntrySession(entry: Pick<BacklotPoolEntry, 'primary' | 'sessionKey' | 'localKey' | 'endpoint'>): string {
  if (entry.sessionKey !== undefined) return entry.sessionKey
  if (entry.primary === true) return ''
  if (entry.primary === false) return sha16(`session:${entry.endpoint}`)
  return entry.localKey
}

const readerFor = (entry: BacklotPoolEntry, hostLabel: () => string) => {
  const id = entryId(entry)
  let r = poolReaders.get(id)
  if (!r) { r = createBacklotDocsReader(hostLabel); poolReaders.set(id, r) }
  return { id, reader: r }
}

async function readEntryCoreId(id: string, call: Call): Promise<string | null> {
  if (poolCoreIds.has(id)) return poolCoreIds.get(id)!
  try {
    const hello = await call<{ core?: { id?: unknown } }>('hello', { generation: 1, framed: false }, 2000)
    return typeof hello?.core?.id === 'string' && hello.core.id ? hello.core.id : null
  } catch {
    return null
  }
}

export async function readBacklotDocs(call: Call, machines: CoreMachine[], terminals: CoreTerminal[], now = Date.now()): Promise<BacklotMachineView[]> {
  return defaultReader.read(call, machines, terminals, now, '')
}

export async function readPoolBacklotDocs(entries: readonly BacklotPoolEntry[], now = Date.now(), hostLabel = localMachineLabel):
  Promise<{ ok: boolean; views: BacklotMachineView[]; error?: string }> {
  if (!entries.length) return { ok: false, views: [], error: 'herdr-core unavailable' }
  const activeIds = new Set(entries.map(entryId))
  for (const id of poolReaders.keys()) if (!activeIds.has(id)) poolReaders.delete(id)
  for (const id of poolCoreIds.keys()) if (!activeIds.has(id)) poolCoreIds.delete(id)

  let anyOk = false
  const perEntry = await Promise.all(entries.map(async (entry) => {
    const { id, reader } = readerFor(entry, hostLabel)
    const session = backlotEntrySession(entry)
    try {
      const cachedMachines = entry.machines?.()
      const snap = entry.terminals?.() ?? entry.snapshot?.() ?? null
      const [machines, terminals, localCoreId] = await Promise.all([
        cachedMachines?.length
          ? Promise.resolve(cachedMachines)
          : entry.call<{ machines: CoreMachine[] }>('machine.list', {}, 8000).then(r => r.machines),
        snap !== null
          ? Promise.resolve(snap)
          : entry.call<{ terminals: CoreTerminal[] }>('terminal.list', {}, 8000).then(r => r.terminals ?? [], () => [] as CoreTerminal[]),
        readEntryCoreId(id, entry.call),
      ])
      poolCoreIds.set(id, localCoreId)
      anyOk = true
      const views = await reader.read(entry.call, machines, terminals, now, session)
      return { id, session, localCoreId, machines, views }
    } catch {
      return { id, session, localCoreId: null as string | null, machines: [] as CoreMachine[], views: [] as BacklotMachineView[] }
    }
  }))

  if (!anyOk) return { ok: false, views: [], error: 'herdr-core unavailable' }
  // Collapse a core reached twice within the same session (e.g. locally and via a loopback remote)
  // using core.id / machine.id (falling back to machine name when ids are absent), while never
  // dropping documents from different sessions.
  const seenCores = new Set<string>()
  const views: BacklotMachineView[] = []
  poolPublishers.clear()
  for (const { id, session, localCoreId, machines, views: entryViews } of perEntry) {
    for (const v of entryViews) {
      const coreId = v.machine ? machines.find(m => m.name === v.machine)?.id : localCoreId
      const dedupKey = `${session}\0${coreId ? `core:${coreId}` : `machine:${v.machine}`}`
      if (seenCores.has(dedupKey)) continue
      seenCores.add(dedupKey)
      poolPublishers.set(publisherKey(session, v.machine), id)
      views.push(v)
    }
  }
  return { ok: true, views }
}

export async function findBacklotActionEntry<T extends BacklotPoolEntry>(
  entries: readonly T[],
  machine: string,
  session?: string,
  now = Date.now(),
): Promise<T | undefined> {
  if (!entries.length) return undefined
  if (session !== undefined) {
    const key = publisherKey(session, machine)
    if (!poolPublishers.has(key)) await readPoolBacklotDocs(entries, now)
    const ownerId = poolPublishers.get(key)
    if (ownerId) {
      const found = entries.find(e => entryId(e) === ownerId)
      if (found) return found
    }
    return entries.find(e => backlotEntrySession(e) === session)
  }
  const primaryKey = publisherKey('', machine)
  if (!poolPublishers.has(primaryKey)) await readPoolBacklotDocs(entries, now)
  const primaryOwnerId = poolPublishers.get(primaryKey)
  if (primaryOwnerId) {
    const found = entries.find(e => entryId(e) === primaryOwnerId)
    if (found) return found
  }
  for (const [k, ownerId] of poolPublishers) {
    if (k.endsWith(`\0${machine}`)) {
      const found = entries.find(e => entryId(e) === ownerId)
      if (found) return found
    }
  }
  return entries[0]
}

export function clearBacklotDocs() {
  defaultReader.clear()
  for (const r of poolReaders.values()) r.clear()
  poolCoreIds.clear()
  poolPublishers.clear()
}
