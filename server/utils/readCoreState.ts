import { coreCall } from './core'
import { readCoreDocs } from './readCoreDocs'
import type { CoreSession } from './coreSession'
import { coreState, type CoreMachine } from '../../shared/coreState'
import type { CoreInventory } from '../../shared/coreInventory'
import { liveTerminals } from '../../shared/coreEvents'
import type { HerdrState } from '../../shared/types'
import { localMachineLabel } from './machines'

// Terminals come from the events session once it holds a snapshot (else one terminal.list).
// Core does not push machine or document changes except `doc`: those are read again
// every MACHINES_MS, and at once after a `doc` event or a new snapshot.
const MACHINES_MS = 4000
let session: CoreSession | null = null
let cache: { at: number; machines: CoreMachine[]; docs: Awaited<ReturnType<typeof readCoreDocs>> } | null = null
export const useCoreSession = (s: CoreSession | null) => { session = s; cache = null }
// A read already in flight when this runs must not refill the cache with what it saw before.
let generation = 0
export const staleCoreDocs = () => { generation++; cache = null }

export async function readCoreState(previous: HerdrState): Promise<HerdrState> {
  try {
    const endpoint = process.env.HC_SOCKET
    if (!endpoint) throw new Error('Missing core endpoint')
    const held = session?.snapshot() ?? null
    const terminals = held ?? [...liveTerminals((await coreCall<CoreInventory>(endpoint, 'terminal.list')).terminals).values()]
    const gen = generation
    if (!cache || Date.now() - cache.at > MACHINES_MS || !held) {
      const machines = (await coreCall<{ machines: CoreMachine[] }>(endpoint, 'machine.list')).machines
      const docs = await readCoreDocs((method, params) => coreCall(endpoint, method, params), machines)
      if (gen !== generation) return readCoreState(previous)
      cache = { at: Date.now(), machines, docs }
    }
    return coreState(terminals, cache.machines, cache.docs, localMachineLabel())
  } catch {
    return { ...previous, ok: false, ready: true, error: 'Cannot read herdr-core inventory',
      machines: previous.machines?.map(m => ({ ...m, status: 'offline' })) }
  }
}
