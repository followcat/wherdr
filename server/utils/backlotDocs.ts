// The "backlot" document of this core and of each connected machine, read only.
// Cached for a few seconds (a remote read goes over ssh); a missing, unreadable
// or invalid document counts as none, so a user without backlot sees nothing.
import type { BacklotMachineView, BacklotSummary } from '../../shared/backlot'
import { parseBacklotDoc } from '../../shared/backlot'
import type { CoreMachine } from '../../shared/coreState'
import type { CoreTerminal } from '../../shared/coreInventory'
import { localMachineLabel } from './machines'

const TTL = 4000
type Call = <T>(method: string, params: object) => Promise<T>
const cache = new Map<string, { at: number; doc: BacklotSummary | null }>()

const ended = (state: string) => state === 'finished' || state === 'lost'
const machineOf = (address: string) => (address.includes('/') ? address.split('/')[0]! : '')
const isStage = (t: CoreTerminal) => t.name === 'backlot-stage' || t.labels?.['backlot.role'] === 'stage'

// A live terminal named backlot-stage, or carrying the stage's manager label.
export function stageRunning(terminals: CoreTerminal[], machine: string): boolean {
  return terminals.some(t => Boolean(t) && !ended(t.state) && machineOf(t.address) === machine && isStage(t))
}

export async function readBacklotDocs(call: Call, machines: CoreMachine[], terminals: CoreTerminal[], now = Date.now()): Promise<BacklotMachineView[]> {
  const names = ['', ...machines.filter(m => m.state === 'connected').map(m => m.name)]
  for (const known of cache.keys()) if (!names.includes(known)) cache.delete(known)
  const docs = await Promise.all(names.map(async (name) => {
    const old = cache.get(name)
    if (old && now - old.at < TTL) return [name, old.doc] as const
    let doc: BacklotSummary | null = null
    try {
      const value = (await call<{ value?: unknown }>('doc.get', { name: 'backlot', ...(name ? { on: name } : {}) }))?.value
      doc = parseBacklotDoc(value)
    } catch { doc = old?.doc ?? null }
    cache.set(name, { at: now, doc })
    return [name, doc] as const
  }))
  const out: BacklotMachineView[] = []
  for (const [name, doc] of docs) {
    if (!doc) continue
    out.push({
      machine: name,
      label: name || localMachineLabel(),
      stageRunning: stageRunning(terminals, name),
      backlotVersion: doc.backlot_version ?? null,
      summary: doc,
    })
  }
  return out
}

export const clearBacklotDocs = () => cache.clear()
