// When the autopilot wakes next.
import { durationMs } from './steps'
import { nextRun, parseSchedule } from './schedule'
import { inHours, type Autopilot } from './autopilot'

// The next scheduled wake: its interval after the last one, or its next fixed
// time, whichever comes first, moved to the start of its hours when it falls
// outside them (the scheduler waits for them). Off or with neither: none.
export function nextWakeAt(ap: Autopilot | undefined, ranAt: number | undefined, atRan: number | undefined, now: number): number | undefined {
  if (!ap?.on) return undefined
  const times: number[] = []
  if (ap.every) times.push(Math.max(now, (ranAt ?? 0) + durationMs(ap.every)))
  const at = ap.at ? parseSchedule(ap.at) : null
  const slot = at && !('error' in at) ? nextRun(at, atRan ?? now) : null
  if (slot !== null) times.push(Math.max(now, slot))
  return times.length ? intoHours(ap.hours, Math.min(...times)) : undefined
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
