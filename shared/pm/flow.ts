// When the autopilot wakes next.
import { durationMs } from './steps'
import { nextRun, parseSchedule } from './schedule'
import { inHours, routinesOf, type Autopilot } from './autopilot'

// The next scheduled wake: its interval after the last one, moved to the start
// of its hours when it falls outside them (the scheduler waits for them), or a
// routine's next slot within the hours (ran: each one's last run; a slot
// outside them is skipped, never moved), whichever comes first. Off or with neither: none.
export function nextWakeAt(ap: Autopilot | undefined, ranAt: number | undefined, ran: Record<string, number>, now: number): number | undefined {
  if (!ap?.on) return undefined
  const times: number[] = []
  if (ap.every) times.push(intoHours(ap.hours, Math.max(now, (ranAt ?? 0) + durationMs(ap.every))))
  for (const r of routinesOf(ap).filter(x => x.on)) {
    const s = parseSchedule(r.when)
    if ('error' in s) continue
    let slot = nextRun(s, ran[r.id] ?? now)
    for (let i = 0; slot !== null && !inHours(ap.hours, new Date(slot)) && i < 1000; i++) slot = nextRun(s, slot)
    if (slot !== null && inHours(ap.hours, new Date(slot))) times.push(Math.max(now, slot))
  }
  return times.length ? Math.min(...times) : undefined
}

// The time itself within the hours, else the next start of them.
function intoHours(hours: Autopilot['hours'], t: number) {
  if (!hours || inHours(hours, new Date(t))) return t
  // Each day's opening from its date, kept only when inside the hours: a clock
  // change can skip it (02:00 that does not exist becomes 03:00).
  const d = new Date(t)
  for (let day = 0; day < 8; day++) {
    const open = new Date(d.getFullYear(), d.getMonth(), d.getDate() + day, hours.from).getTime()
    if (open > t && inHours(hours, new Date(open))) return open
  }
  return t
}
