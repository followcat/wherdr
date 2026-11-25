import type { CoreEvent } from '../../shared/coreEvents'
import type { CoreTerminal } from '../../shared/coreInventory'
import { isBacklotDaemonTerminal } from '../../shared/backlotDaemon'

// Push alerts from herdr-core events, with herdr-app's rules: nothing for a sub-agent
// (a terminal with a parent), nothing before the first snapshot (the session only
// reports events after it, and a reconnect snapshot reports none), nothing while
// someone views that agent (the sender checks), at most one alert per
// (terminal, turn, kind), and only if the state still holds after a short settle.
export type CoreAlertKind = 'needs-you' | 'finished'
export interface CoreAlertDeps {
  settleMs: number
  current: (address: string) => CoreTerminal | undefined
  send: (address: string, kind: CoreAlertKind) => void
}
const stateOf = (t?: CoreTerminal) => t?.status?.state
const isBacklotDaemon = (t: CoreTerminal) => isBacklotDaemonTerminal(t)

export function createCoreAlerts(deps: CoreAlertDeps) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const sent = new Set<string>()
  const holds = (kind: CoreAlertKind, t?: CoreTerminal) => kind === 'needs-you'
    ? stateOf(t) === 'blocked' || stateOf(t) === 'error'
    : stateOf(t) === 'idle' || stateOf(t) === 'done'
  return {
    onEvent(event: CoreEvent, before: CoreTerminal | undefined, after: CoreTerminal | undefined) {
      if (event.type !== 'status' || !after || after.parent || isBacklotDaemon(after)) return
      const address = after.address
      const was = stateOf(before)
      const now = stateOf(after)
      const kind: CoreAlertKind | null = (now === 'blocked' || now === 'error') && was !== 'blocked' && was !== 'error' ? 'needs-you'
        : (now === 'idle' || now === 'done') && was === 'working' ? 'finished' : null
      clearTimeout(timers.get(address))
      timers.delete(address)
      if (!kind) return
      const timer = setTimeout(() => {
        timers.delete(address)
        const latest = deps.current(address)
        if (!latest || latest.parent || isBacklotDaemon(latest) || !holds(kind, latest)) return
        const key = `${address}:${latest.turn ?? 0}:${kind}`
        if (sent.has(key)) return
        if (sent.size > 2000) sent.clear()
        sent.add(key)
        deps.send(address, kind)
      }, deps.settleMs)
      timer.unref?.()
      timers.set(address, timer)
    },
    stop() { for (const t of timers.values()) clearTimeout(t); timers.clear() },
  }
}
