import { expect, it } from 'vitest'
import { weekSeries } from '../shared/pacingChart'
import { DEFAULT_PACE, type PacePolicy } from '../shared/pm/pacing'
import type { PacingEntry } from '../shared/pacingLog'

// Week of Sunday 8 → Sunday 15 November 2026, reset on Sunday at 21:00 (local).
const at = (day: number, h = 12) => new Date(2026, 10, day, h).getTime()
const R = at(15, 21)
const entry = (t: number, week: number, reset: number | null = R, account = 'claude:a1'): PacingEntry => ({ account, at: t, five: null, week, reset })
const workdays: PacePolicy = { ...DEFAULT_PACE, mode: 'workdays' }

it('draws this week\'s readings as steps from the first one, up to the latest reading; the last week and other accounts stay out', () => {
  const log = [
    entry(at(8, 10), 95, R - 7 * 86_400_000), // last week, before the reset
    entry(at(9, 10), 10, R + 60_000), // the reset time moves by a minute: same week
    entry(at(10, 9), 30),
    entry(at(10, 9), 70, R, 'claude:b2'),
  ]
  const s = weekSeries(log, 'claude:a1', workdays, R, at(11), { at: at(11, 11), used: 30 })
  expect(s.from).toBe(R - 7 * 86_400_000)
  expect(s.usage).toEqual([[{ t: at(9, 10), v: 10 }, { t: at(10, 9), v: 10 }, { t: at(10, 9), v: 30 }, { t: at(11, 11), v: 30 }]])
})

it('no reading this week: no usage at all, never a made-up 0; a reading without a weekly value leaves a gap', () => {
  expect(weekSeries([], 'claude:a1', workdays, R, at(11)).usage).toEqual([])
  const gap = [entry(at(9), 10), { ...entry(at(10), 0), week: null }, entry(at(12), 40)]
  expect(weekSeries(gap, 'claude:a1', workdays, R, at(13)).usage).toEqual([[{ t: at(9), v: 10 }], [{ t: at(12), v: 40 }]])
})

it('the target line steps at each midnight up to the cap; free with reserve steps a day before the reset; Free has none', () => {
  const line = weekSeries([], 'claude:a1', workdays, R, at(11)).target!
  const at00 = (d: number) => line.filter(p => p.t === new Date(2026, 10, d).getTime()).map(p => Math.round(p.v))
  expect(at00(9)).toEqual([0, 18]) // Monday adds its share at 00:00
  expect(at00(14)).toEqual([90]) // Saturday adds nothing: no step
  expect(line[line.length - 1]).toEqual({ t: R, v: 90 })

  const reserve = weekSeries([], 'claude:a1', { ...DEFAULT_PACE, mode: 'free', reservePerDay: 10 }, R, at(11))
  expect(reserve.label).toBe('reserve')
  expect(reserve.target![0]).toEqual({ t: R - 7 * 86_400_000, v: 30 })
  expect(reserve.target!.filter(p => p.t === R - 86_400_000).map(p => p.v)).toEqual([80, 90])

  expect(weekSeries([], 'claude:a1', DEFAULT_PACE, R, at(11)).target).toBeNull()
})
