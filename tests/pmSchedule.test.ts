import { describe, expect, it } from 'vitest'
import { due, nextRun, parseSchedule, type Schedule } from '../shared/pm/schedule'

// Local times, as the schedules read them.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const sched = (s: string) => parseSchedule(s) as Schedule

describe('schedules', () => {
  it('reads the forms the user writes, and refuses the rest', () => {
    expect(parseSchedule('every 2h')).toEqual({ every: 7_200_000 })
    expect(parseSchedule('Daily 4:17')).toMatchObject({ hour: [4], min: [17], dow: null })
    expect(parseSchedule('mon,thu 08:10')).toMatchObject({ hour: [8], min: [10], dow: [1, 4] })
    expect(parseSchedule('*/15 9-17 * * mon-fri')).toMatchObject({ min: [0, 15, 30, 45], hour: [9, 10, 11, 12, 13, 14, 15, 16, 17], dow: [1, 2, 3, 4, 5] })
    for (const bad of ['', 'every 0m', 'every 2d', 'daily 24:00', 'mon 9', 'funday 09:00', '60 * * * *', '* * * *', '1-x * * * *'])
      expect(parseSchedule(bad), bad).toHaveProperty('error')
  })

  it('gives the next slot after a time, in local time', () => {
    // 2026-11-05 is a Thursday.
    expect(nextRun(sched('daily 04:17'), at(2026, 11, 5, 3))).toBe(at(2026, 11, 5, 4, 17))
    expect(nextRun(sched('daily 04:17'), at(2026, 11, 5, 4, 17))).toBe(at(2026, 11, 6, 4, 17))
    expect(nextRun(sched('mon,thu 08:10'), at(2026, 11, 5, 9))).toBe(at(2026, 11, 9, 8, 10))
    expect(nextRun(sched('0 9 1 * *'), at(2026, 11, 5))).toBe(at(2026, 12, 1, 9))
    // Both day fields restricted: either one matches (cron).
    expect(nextRun(sched('0 9 1 * sun'), at(2026, 11, 5))).toBe(at(2026, 11, 8, 9))
    expect(nextRun(sched('0 9 29 2 *'), at(2026, 11, 5))).toBe(at(2028, 2, 29, 9))
    expect(nextRun(sched('every 30m'), 1000)).toBe(1000 + 1_800_000)
  })

  it('is due once however many slots were missed', () => {
    const s = sched('daily 04:17')
    const last = at(2026, 11, 1, 5)
    expect(due(s, last, at(2026, 11, 2, 4, 16))).toBe(false)
    // Down three days: due now; once the caller records now, not again until tomorrow.
    const back = at(2026, 11, 5, 10)
    expect(due(s, last, back)).toBe(true)
    expect(due(s, back, back + 60_000)).toBe(false)
    expect(due(s, back, at(2026, 11, 6, 4, 17))).toBe(true)
  })
})
