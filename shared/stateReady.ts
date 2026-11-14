// Server restart (redeployment): its first state may be partial. The app
// applies recovered machines immediately, retaining the last state of
// machines still reconnecting. An unrelated slow machine must not hold back
// the whole UI or unmount an open view for a transient reason.
import type { HerdrState, MachineInfo } from './types'
import { LOCAL, machineOf } from './ids'

// What the server sends before its first read: not ready, so a page that
// reconnects to a restarted server keeps the state it shows.
export const startingState = (): HerdrState => ({ ok: false, ready: false, error: 'starting…', workspaces: [], panes: [] })

// State to show: null = keep the current state. `settling`: recent
// reconnection (the server may have restarted).
export function settleState(prev: HerdrState | null, next: HerdrState, settling: boolean): HerdrState | null {
  if (!prev || !prev.ok) return next
  // A restart still probing AND an empty answer: nothing to merge into.
  if (next.ready === false && !next.ok) return null
  const partial = next.ready === false
  if (!partial && (!settling || !next.ok)) return next
  // During a restart, only a machine the server has read (`polled`) or
  // declared offline answers for its content; any machine with panes in the
  // new state was read too. The others keep their previous content, so an
  // open view stays mounted. Without `polled` (older server), an online
  // machine with no panes waits for the server to be ready.
  const present = new Set(next.panes.map(p => machineOf(p.id)))
  const certain = new Set(partial
    ? (next.machines || []).filter(m => m.status === 'offline' || m.polled).map(m => m.key)
    : [LOCAL, ...(next.machines || []).filter(m => m.status === 'online').map(m => m.key)])
  const localListed = (next.machines || []).some(m => m.key === LOCAL)
  const keep = (id: string) => {
    const m = machineOf(id)
    return !certain.has(m) && !present.has(m)
  }
  const panes = prev.panes.filter(p => keep(p.id))
  const kept = new Set(panes.map(p => machineOf(p.id)))
  const known = new Set((next.machines || []).map(m => m.key))
  const lost = (prev.machines || []).filter(m => m.key !== LOCAL && kept.has(m.key) && !known.has(m.key))
    .map((m): MachineInfo => ({ ...m, status: 'connecting' }))
  // next.ok already confirms the local poll succeeded, even before the
  // machine list is available. Do not disable input on a recovered local pane.
  const localInfo: MachineInfo[] = localListed ? [] : (prev.machines || []).filter(m => m.key === LOCAL)
    .map((m): MachineInfo => partial ? { ...m, status: 'online', error: null } : m)
  if (!panes.length && !lost.length && !localInfo.length) return next
  return {
    ...next,
    workspaces: [...next.workspaces, ...prev.workspaces.filter(w => keep(w.id))],
    tabs: [...(next.tabs || []), ...(prev.tabs || []).filter(t => keep(t.id))],
    panes: [...next.panes, ...panes],
    machines: [...localInfo, ...(next.machines || []), ...lost],
  }
}
