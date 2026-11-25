// The "backlot" document of this core and of each connected machine, read only.
// Cached for a few seconds (a remote read goes over ssh); a missing, unreadable
// or invalid document counts as none, so a user without backlot sees nothing.
import type { BacklotMachineView, BacklotSummary } from '../../shared/backlot'
import { parseBacklotDoc } from '../../shared/backlot'
import type { CoreMachine } from '../../shared/coreState'
import type { CoreTerminal } from '../../shared/coreInventory'
import { localMachineLabel } from './machines'

const TTL = 4000
type Call = <T>(method: string, params: object, timeout?: number) => Promise<T>

const ended = (state: string) => state === 'finished' || state === 'lost'
const machineOf = (address: string) => (address.includes('/') ? address.split('/')[0]! : '')
const isStage = (t: CoreTerminal) =>
  t.name === 'backlot-stage' || t.name === 'backlot-server' || t.labels?.['backlot.role'] === 'stage' || t.labels?.['backlot.role'] === 'server'

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
    async read(call: Call, machines: CoreMachine[], terminals: CoreTerminal[], now = Date.now()): Promise<BacklotMachineView[]> {
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
const poolPublishers = new Map<string, string>() // view.machine -> entry key (`localKey:endpoint`)

export interface BacklotPoolEntry {
  localKey: string
  endpoint: string
  call: Call
  terminals?: () => CoreTerminal[] | null
  machines?: () => CoreMachine[]
}

const readerFor = (entry: BacklotPoolEntry, hostLabel: () => string) => {
  const id = `${entry.localKey}\0${entry.endpoint}`
  let r = poolReaders.get(id)
  if (!r) { r = createBacklotDocsReader(hostLabel); poolReaders.set(id, r) }
  return { id, reader: r }
}

export async function readBacklotDocs(call: Call, machines: CoreMachine[], terminals: CoreTerminal[], now = Date.now()): Promise<BacklotMachineView[]> {
  return defaultReader.read(call, machines, terminals, now)
}

export async function readPoolBacklotDocs(entries: readonly BacklotPoolEntry[], now = Date.now(), hostLabel = localMachineLabel):
  Promise<{ ok: boolean; views: BacklotMachineView[]; error?: string }> {
  if (!entries.length) return { ok: false, views: [], error: 'herdr-core unavailable' }
  const activeIds = new Set(entries.map(e => `${e.localKey}\0${e.endpoint}`))
  for (const id of poolReaders.keys()) if (!activeIds.has(id)) poolReaders.delete(id)

  let anyOk = false
  const perEntry = await Promise.all(entries.map(async (entry) => {
    const { id, reader } = readerFor(entry, hostLabel)
    try {
      const cachedMachines = entry.machines?.()
      const machines = cachedMachines?.length
        ? cachedMachines
        : (await entry.call<{ machines: CoreMachine[] }>('machine.list', {}, 8000)).machines
      const snap = entry.terminals?.() ?? null
      const terminals = snap ?? (await entry.call<{ terminals: CoreTerminal[] }>('terminal.list', {}, 8000)
        .then(r => r.terminals ?? [], () => [] as CoreTerminal[]))
      anyOk = true
      const views = await reader.read(entry.call, machines, terminals, now)
      return { id, views }
    } catch {
      return { id, views: [] as BacklotMachineView[] }
    }
  }))

  if (!anyOk) return { ok: false, views: [], error: 'herdr-core unavailable' }
  const seenMachines = new Set<string>()
  const views: BacklotMachineView[] = []
  poolPublishers.clear()
  for (const { id, views: entryViews } of perEntry) {
    for (const v of entryViews) {
      if (seenMachines.has(v.machine)) continue
      seenMachines.add(v.machine)
      poolPublishers.set(v.machine, id)
      views.push(v)
    }
  }
  return { ok: true, views }
}

export async function findBacklotActionEntry<T extends BacklotPoolEntry>(entries: readonly T[], machine: string, now = Date.now()): Promise<T | undefined> {
  if (!entries.length) return undefined
  if (!poolPublishers.has(machine)) await readPoolBacklotDocs(entries, now)
  const ownerId = poolPublishers.get(machine)
  return (ownerId ? entries.find(e => `${e.localKey}\0${e.endpoint}` === ownerId) : undefined) ?? entries[0]
}

export function clearBacklotDocs() {
  defaultReader.clear()
  for (const r of poolReaders.values()) r.clear()
  poolPublishers.clear()
}
