import { describe, expect, it } from 'vitest'
import { nextWakeAt } from '../shared/pm/flow'

describe('nextWakeAt', () => {
  const ap = { on: true, goal: '', events: [], perDay: 1, atOnce: 1 }
  const now = new Date(2026, 0, 5, 10, 0).getTime()
  it('the interval after the last wake, or the next fixed time, whichever comes first', () => {
    expect(nextWakeAt({ ...ap, every: '2h' }, now - 30 * 60_000, undefined, now)).toBe(now + 90 * 60_000)
    expect(nextWakeAt({ ...ap, every: '2h', at: 'daily 10:30' }, now, now, now)).toBe(new Date(2026, 0, 5, 10, 30).getTime())
    // A wake overdue goes now, never in the past.
    expect(nextWakeAt({ ...ap, every: '30m' }, now - 3_600_000, undefined, now)).toBe(now)
  })
  it('outside its hours on a clock change: the next opening that exists', () => {
    const tz = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      // 8 March 2026: 02:00 does not exist; 02:00-03:00 has no opening that day.
      const t = new Date(2026, 2, 8, 1, 30).getTime()
      expect(nextWakeAt({ ...ap, every: '30m', hours: { from: 2, to: 3 } }, t, undefined, t)).toBe(new Date(2026, 2, 9, 2, 0).getTime())
    } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz }
  })
  it('outside its hours: the next start of them', () => {
    const late = new Date(2026, 0, 5, 21, 30).getTime()
    expect(nextWakeAt({ ...ap, every: '2h', hours: { from: 8, to: 20 } }, late - 2.5 * 3_600_000, undefined, late)).toBe(new Date(2026, 0, 6, 8, 0).getTime())
    expect(nextWakeAt({ ...ap, every: '2h', hours: { from: 22, to: 6 } }, now, undefined, now)).toBe(new Date(2026, 0, 5, 22, 0).getTime())
  })
  it('none when off or with no schedule', () => {
    expect(nextWakeAt({ ...ap, on: false, every: '2h' }, 0, 0, now)).toBeUndefined()
    expect(nextWakeAt(ap, 0, 0, now)).toBeUndefined()
  })
})
