// Server restart (redeployment): its first state may be partial.
// The server only says it is "ready" once the machine list is read, the
// local machine probed and each remote machine either probed or declared
// offline (or after READY_MAX_MS, so it never stays stuck).
// The app applies recovered machines immediately, retaining the last state
// of machines still reconnecting. An unrelated slow machine must not hold
// back the whole UI or unmount an open view for a transient reason.
import type { HerdrState, MachineInfo } from './types'
import { LOCAL, machineOf } from './ids'

export const READY_MAX_MS = 20000

export interface ReadyInput {
  machinesListed: boolean
  localPolled: boolean
  remotes: { status: MachineInfo['status'], polled: boolean }[]
  elapsedMs: number
}

export function serverReady(i: ReadyInput): boolean {
  if (i.elapsedMs >= READY_MAX_MS) return true
  return i.machinesListed && i.localPolled && i.remotes.every(r => r.polled || r.status === 'offline')
}

// A machine as the server publishes it. `ms`: its last read state, if any.
// While not ready, `polled` says whether that state exists: 'online' only
// proves the connection is back (SSH, or a secondary local session, which
// is always online), not that the machine has been read yet.
export function publishedMachine(info: MachineInfo, ms: HerdrState | undefined, ready: boolean): MachineInfo {
  const flag = ready ? {} : { polled: Boolean(ms) }
  // Machine connected but Herdr server silent: "attention".
  if (info.status === 'online' && ms && !ms.ok) return { ...info, status: 'offline', error: ms.error || null, version: ms.version, ...flag }
  return { ...info, version: ms && ms.version, ...flag }
}

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
