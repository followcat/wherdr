import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PACE, dayShares, mergePolicy, paceVerdict, targetLine, type PacePolicy } from '../shared/pm/pacing'
import { paceRows, weekLimit } from '../shared/pm/pace'
import { policyIn, readPolicies, setPolicy } from '../server/utils/pacingPolicies'
import type { Quota, Quotas } from '../shared/types'

// Week of Sunday 8 → Sunday 15 November 2026, reset on Sunday at 21:00 (local).
const at = (day: number, h = 12, m = 0) => new Date(2026, 10, day, h, m).getTime()
const R = at(15, 21)
const DAY = 86_400_000
const workdays: PacePolicy = { ...DEFAULT_PACE, mode: 'workdays' }
const everyday: PacePolicy = { ...DEFAULT_PACE, mode: 'everyday' }
const quota = (week: number | null, five: number | null, now: number, more: Partial<Quota> = {}): Quota => ({
  week: week === null ? null : { used: week, resetsAt: R, minutes: 7 * 24 * 60 },
  five: five === null ? null : { used: five, resetsAt: now + 2 * 3_600_000, minutes: 300 },
  at: now, ...more,
})

describe('target line', () => {
  it('Mon-Fri with a cap of 90: 18 % a day from Monday 00:00, flat on the weekend', () => {
    const line = [9, 10, 11, 12, 13, 14, 15].map(d => Math.round(targetLine(workdays, R, at(d, 0, 1))))
    expect(line).toEqual([18, 36, 54, 72, 90, 90, 90])
    expect(targetLine(workdays, R, at(8, 22))).toBe(0) // the week's first evening is a Sunday
  })

  it('counts the partial first and last days of a reset that is not at midnight', () => {
    const shares = dayShares(() => true, R)
    expect(shares).toHaveLength(8)
    expect(shares[0]!.share).toBeCloseTo(3 / 24) // Sunday 21:00 → 24:00
    expect(shares[7]!.share).toBeCloseTo(21 / 24) // Sunday 00:00 → 21:00
    expect(shares.reduce((s, d) => s + d.share, 0)).toBeCloseTo(7)
    expect(targetLine(everyday, R, at(8, 22))).toBeCloseTo(90 * (3 / 24) / 7)
    expect(targetLine(everyday, R, at(9, 0))).toBeCloseTo(90 * (27 / 24) / 7)
    expect(targetLine(everyday, R, at(15, 1))).toBeCloseTo(90)
  })

  it('ahead of the line (2-point margin): waits for the midnight that lifts it', () => {
    const now = at(10, 15) // Tuesday, line 36
    expect(paceVerdict(workdays, quota(30, 0, now), now)).toEqual({ go: true })
    expect(paceVerdict(workdays, quota(34, 0, now), now)).toEqual({ go: false, reason: 'ahead', until: at(11, 0) })
    expect(paceVerdict(workdays, quota(60, 0, now), now)).toEqual({ go: false, reason: 'ahead', until: at(12, 0) }) // Thursday: 72 - 2 > 60
    // Friday night: no chosen day left before the reset.
    expect(paceVerdict(workdays, quota(89, 0, at(13, 23)), at(13, 23))).toEqual({ go: false, reason: 'ahead', until: R })
  })
})

describe('free (no restriction)', () => {
  it('is a new account\'s mode, and goes until the account itself is limited', () => {
    expect(DEFAULT_PACE.mode).toBe('unlimited')
    const now = at(14, 22) // the burn's window, but Free has no burn
    const p: PacePolicy = { ...DEFAULT_PACE, burn: { until: R } }
    expect(paceVerdict(p, quota(99, 99, now, { at: now - 60 * 60_000 }), now)).toEqual({ go: true }) // no line, reserve, burn cap or stale wait
    expect(weekLimit(p, R, now)).toEqual({ label: 'limit', value: 100 })
    expect(paceVerdict(p, quota(100, 40, now, { limited: { resetsAt: R } }), now)).toEqual({ go: false, reason: 'limited', until: R })
  })
})

describe('reserves', () => {
  const free: PacePolicy = { ...DEFAULT_PACE, mode: 'free' }

  it('weekly reserve of 10 % per day left, rounded up', () => {
    const monday = at(9, 12) // 6.4 days left → 7 → keeps 70 %
    expect(paceVerdict(free, quota(29, 0, monday), monday)).toEqual({ go: true })
    expect(paceVerdict(free, quota(30, 0, monday), monday)).toEqual({ go: false, reason: 'reserveWeek', until: R - 6 * 86_400_000 })
    const sixLeft = at(9, 22) // 5.96 days → 6 → up to 40 %
    expect(paceVerdict(free, quota(39, 0, sixLeft), sixLeft).go).toBe(true)
    expect(paceVerdict(free, quota(40, 0, sixLeft), sixLeft).go).toBe(false)
    const eve = at(15, 9) // the day before the reset → keeps 10 %, up to 90 %
    expect(paceVerdict(free, quota(89, 0, eve), eve).go).toBe(true)
    expect(paceVerdict(free, quota(90, 0, eve), eve)).toEqual({ go: false, reason: 'reserveWeek', until: R })
  })

  it('5-hour reserve of 25 % in every mode, until the window resets', () => {
    const now = at(10, 15)
    for (const p of [free, workdays, everyday]) {
      expect(paceVerdict(p, quota(10, 74, now), now).go).toBe(true)
      expect(paceVerdict(p, quota(10, 75, now), now)).toEqual({ go: false, reason: 'reserve5h', until: now + 2 * 3_600_000 })
    }
  })

  it('both reached: reports the one that lifts last', () => {
    const now = at(10, 15)
    expect(paceVerdict(workdays, quota(40, 80, now), now)).toMatchObject({ reason: 'ahead', until: at(11, 0) })
  })

  it('a window whose reset has passed counts as empty', () => {
    const now = at(10, 15)
    const q = quota(10, 90, now - 3 * 3_600_000, { at: now - 10 * 60_000 })
    expect(paceVerdict(free, q, now)).toEqual({ go: true })
  })
})

describe('end-of-week burn', () => {
  const burn: PacePolicy = { ...workdays, burn: { until: R } }

  it('on: no pace hold until the reset, only the account\'s own limit; off at the reset', () => {
    const now = at(10, 15) // Wednesday, well ahead of the line and past both reserves
    expect(paceVerdict(workdays, quota(91, 95, now), now)).toMatchObject({ go: false })
    expect(paceVerdict(burn, quota(91, 95, now), now)).toEqual({ go: true, burning: true })
    expect(paceVerdict(burn, { ...quota(100, 100, now), limited: { resetsAt: now + 3_600_000 } }, now)).toMatchObject({ go: false, reason: 'limited' })
    expect(weekLimit(burn, R, now)).toEqual({ label: 'burn', value: 100 })
    // After the reset: the usual line again.
    const next = R + 6 * DAY
    expect(paceVerdict(burn, { ...quota(91, 0, next), week: { used: 91, resetsAt: R + 7 * DAY, minutes: 7 * 24 * 60 } }, next)).toMatchObject({ go: false, reason: 'ahead' })
    expect(weekLimit(burn, R + 7 * DAY, next).label).toBe('line')
  })
})

describe('readings', () => {
  const now = at(10, 15)

  it('older than 30 min: starts only with 5 points left', () => {
    const old = (week: number) => quota(week, 0, now, { at: now - 31 * 60_000 })
    expect(paceVerdict(workdays, old(28), now)).toEqual({ go: true }) // line 36 - 2 = 34: 6 points
    expect(paceVerdict(workdays, old(30), now)).toEqual({ go: false, reason: 'stale', until: null })
    expect(paceVerdict(workdays, { ...old(30), at: now - 29 * 60_000 }, now)).toEqual({ go: true })
    expect(paceVerdict(workdays, old(30), now, 'user')).toEqual({ go: true })
  })

  it('a missing window is skipped (Codex Pro), no reading at all is unknown', () => {
    expect(paceVerdict(workdays, quota(10, null, now), now)).toEqual({ go: true })
    expect(paceVerdict(workdays, quota(null, 80, now), now)).toMatchObject({ go: false, reason: 'reserve5h' })
    expect(paceVerdict(workdays, quota(null, null, now), now)).toEqual({ go: true, unknown: true })
    expect(paceVerdict(workdays, null, now)).toEqual({ go: true, unknown: true })
  })

  it('a limited account waits for its reset', () => {
    const q = quota(null, null, now, { limited: { resetsAt: now + 3_600_000 } })
    expect(paceVerdict(workdays, q, now)).toEqual({ go: false, reason: 'limited', until: now + 3_600_000 })
    expect(paceVerdict(workdays, q, now + 3_600_000)).toEqual({ go: true, unknown: true })
  })

  it('an expired limit or one covered by credits holds nothing', () => {
    // Read 3 days ago, its reset long passed; no reset known: over 5 h after the reading.
    expect(paceVerdict(workdays, quota(null, null, now - 3 * DAY, { limited: { resetsAt: now - 2 * DAY } }), now)).toEqual({ go: true, unknown: true })
    expect(paceVerdict(workdays, quota(null, null, now - 6 * 3_600_000, { limited: { resetsAt: null } }), now)).toEqual({ go: true, unknown: true })
    expect(paceVerdict(workdays, quota(null, null, now - 3_600_000, { limited: { resetsAt: null } }), now)).toEqual({ go: false, reason: 'limited', until: now + 4 * 3_600_000 })
    const credits = quota(null, null, now, { limited: { resetsAt: now + 3_600_000 }, credits: { unlimited: false, balance: 120 } })
    expect(paceVerdict(workdays, credits, now)).toEqual({ go: true, unknown: true })
  })
})

describe('user requests', () => {
  it('are never refused, only warned about', () => {
    const now = at(10, 15)
    expect(paceVerdict(everyday, quota(10, 81, now), now, 'user')).toEqual({ go: true, warn: 'reserve5h' })
    expect(paceVerdict(workdays, quota(60, 0, now), now, 'user')).toEqual({ go: true, warn: 'ahead' })
    expect(paceVerdict(workdays, quota(null, null, now, { limited: { resetsAt: null } }), now, 'user')).toEqual({ go: true, warn: 'limited' })
    expect(paceVerdict(workdays, quota(10, 0, now), now, 'user')).toEqual({ go: true })
  })
})

describe('policy per account (Settings › Pace)', () => {
  it('merges the user\'s changes field by field, clamped, invalid ones ignored', () => {
    const p = mergePolicy(DEFAULT_PACE, { mode: 'workdays', days: [5, 1, 1, 9, 'x'], cap: 140, reserve5h: -3, reservePerDay: 'a', margin: 50 })
    expect(p).toEqual({ ...DEFAULT_PACE, mode: 'workdays', days: [1, 5], cap: 100, reserve5h: 0 })
    expect(mergePolicy(DEFAULT_PACE, { mode: 'turbo' }).mode).toBe('unlimited')
    expect(mergePolicy(DEFAULT_PACE, { mode: 'free' }).mode).toBe('free') // a saved mode stays
    expect(mergePolicy(DEFAULT_PACE, { days: [] }).days).toEqual([1, 2, 3, 4, 5]) // never no day at all
    expect(DEFAULT_PACE).toMatchObject({ mode: 'unlimited', days: [1, 2, 3, 4, 5], cap: 90, reserve5h: 25, reservePerDay: 10 })
  })

  it('merges the burn: on until a coming reset, off with null, dropped after its reset; old fields ignored', () => {
    const now = at(10, 15)
    const on = mergePolicy(DEFAULT_PACE, { burn: { until: R } }, now)
    expect(on.burn).toEqual({ until: R })
    expect(mergePolicy(on, { cap: 50 }, now).burn).toEqual(on.burn) // other changes keep it
    expect(mergePolicy(DEFAULT_PACE, { burn: { until: now - 1 } }, now).burn).toBeUndefined() // a past reset is refused
    expect(mergePolicy(on, { burn: null }, now).burn).toBeUndefined()
    expect(mergePolicy(DEFAULT_PACE, on, R).burn).toBeUndefined() // read at its reset: dropped
    // The old settings: an every-week burn is off, a this-week one keeps its reset only.
    expect(mergePolicy(DEFAULT_PACE, { burn: { cap: 95, atOnce: 3, reserve5h: 10, hours: 48 } }, now).burn).toBeUndefined()
    expect(mergePolicy(DEFAULT_PACE, { burn: { cap: 95, atOnce: 3, reserve5h: 10, until: R } }, now).burn).toEqual({ until: R })
  })

  it('rows: each account with its policy, line and verdict; a program with no reading is unknown', () => {
    const now = at(11, 12)
    const q: Quotas = {
      claude: quota(60, 30, now), codex: null,
      accounts: [{ key: 'claude:a1b2c3d4', program: 'claude', name: 'Work', machines: [''] }],
    }
    const rows = paceRows(q, () => workdays, { 'claude:a1b2c3d4': 9 }, now)
    expect(rows.map(r => r.program)).toEqual(['claude', 'codex'])
    expect(rows[0]).toMatchObject({ today: 9, five: { used: 30 }, week: { used: 60, label: 'line' }, verdict: { go: false, reason: 'ahead' } })
    expect(Math.round(rows[0]!.week!.limit)).toBe(54)
    expect(rows[1]).toMatchObject({ account: null, verdict: { go: true, unknown: true } })
  })

  it('stores one policy per account key in pacing.json', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pace-'))
    const file = path.join(dir, 'pacing.json')
    try {
      expect(policyIn(await readPolicies(file), 'claude:a1b2c3d4')).toBe(DEFAULT_PACE)
      await setPolicy('claude:a1b2c3d4', { mode: 'everyday' }, file)
      await setPolicy('claude:a1b2c3d4', { cap: 80 }, file)
      expect(await readPolicies(file)).toEqual({ 'claude:a1b2c3d4': { ...DEFAULT_PACE, mode: 'everyday', cap: 80 } })
    } finally { fs.rmSync(dir, { recursive: true }) }
  })
})
