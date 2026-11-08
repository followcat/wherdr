// Quota pacing of a subscription account: may automatic work (autopilot,
// automations, missions) start now on this account? One pure verdict; the
// user's own requests are never refused, only warned about.
//
// Modes: 'workdays' and 'everyday' follow a target line that rises at local
// midnight of each chosen day up to `cap` at the weekly reset; 'free' keeps a
// weekly reserve of `reservePerDay` per day left before the reset. A burn
// (one-shot, before a reset) replaces the usual mode from its start to the
// reset. Every mode keeps the 5-hour reserve.
import type { Quota, QuotaWindow } from '../types'

export type PaceMode = 'workdays' | 'everyday' | 'free'

export interface BurnSettings {
  cap: number // weekly % the burn may reach
  start?: number // ms; unset: 24 h before the weekly reset
  atOnce: number // tasks at once while burning (read by the burn loop)
  reserve5h: number // 5-hour reserve while burning
}

export interface PacePolicy {
  mode: PaceMode
  days: number[] // chosen days for 'workdays', 0 = Sunday … 6 = Saturday
  cap: number // top of the target line, % of the week
  reserve5h: number // automatic work stops at 100 - reserve5h on the 5-hour window
  reservePerDay: number // 'free': weekly % kept per day left before the reset
  margin: number // points under the line where automatic work already waits
  stale: { minutes: number, margin: number } // older reading: start only with this margin left
  burn?: BurnSettings
}

export const DEFAULT_PACE: PacePolicy = {
  mode: 'free', days: [1, 2, 3, 4, 5], cap: 90, reserve5h: 25, reservePerDay: 10, margin: 2,
  stale: { minutes: 30, margin: 5 },
}
export const DEFAULT_BURN: BurnSettings = { cap: 95, atOnce: 3, reserve5h: 10 }

// limited: the account hit its limit; ahead: on or above the target line;
// reserveWeek / reserve5h: the reserve is reached; burnCap: the burn's cap;
// stale: the reading is too old for the margin left (waits for a new one).
export type PaceReason = 'limited' | 'ahead' | 'reserveWeek' | 'reserve5h' | 'burnCap' | 'stale'
export type PaceIntent = 'auto' | 'user'
export type PaceVerdict =
  | { go: true, warn?: PaceReason, unknown?: true } // unknown: no reading, only the task-count limits apply
  | { go: false, reason: PaceReason, until: number | null } // until: ms, null = on the next reading

const DAY = 86_400_000

const nextMidnight = (t: number) => {
  const d = new Date(t)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}
const midnight = (t: number) => new Date(t).setHours(0, 0, 0, 0)

// A window as it stands now: a reading taken before its reset counts as empty,
// with the next reset one window later.
export function current(w: QuotaWindow | null, now: number): { used: number, resetsAt: number | null } | null {
  if (!w) return null
  if (w.resetsAt !== null && w.resetsAt <= now) return { used: 0, resetsAt: w.resetsAt + w.minutes * 60_000 }
  return { used: w.fresh ? 0 : w.used, resetsAt: w.resetsAt }
}

// Local days of the week [reset - 7 d, reset), with the share of each chosen
// day inside it: the first and last days count in part when the reset is not
// at midnight.
export function dayShares(chosen: (day: number) => boolean, resetsAt: number) {
  const from = resetsAt - 7 * DAY
  const out: { start: number, share: number }[] = []
  for (let start = midnight(from); start < resetsAt; start = nextMidnight(start)) {
    const end = nextMidnight(start)
    const inside = Math.min(end, resetsAt) - Math.max(start, from)
    out.push({ start, share: chosen(new Date(start).getDay()) ? inside / (end - start) : 0 })
  }
  return out
}

const chosenDays = (p: PacePolicy) => (day: number) => p.mode === 'everyday' || p.days.includes(day)

// Target line at `t` (% of the week): cap × shares of the days started by t /
// all shares. It steps up at midnight, so a day's share is there from 00:00.
export function targetLine(p: PacePolicy, resetsAt: number, t: number) {
  const shares = dayShares(chosenDays(p), resetsAt)
  const total = shares.reduce((s, d) => s + d.share, 0)
  if (!total) return 0
  const started = shares.filter(d => d.start <= t).reduce((s, d) => s + d.share, 0)
  return p.cap * started / total
}

interface Check { reason: PaceReason, room: number, until: number | null } // room: points left before the limit

// Weekly check of the mode in force.
function weekCheck(p: PacePolicy, w: { used: number, resetsAt: number }, now: number): Check {
  const R = w.resetsAt
  const burn = p.burn
  if (burn && now >= (burn.start ?? R - DAY)) return { reason: 'burnCap', room: burn.cap - w.used, until: R }
  if (p.mode === 'free') {
    const left = Math.ceil((R - now) / DAY)
    const limit = (n: number) => 100 - p.reservePerDay * n
    let until = R
    for (let n = left - 1; n > 0; n--) if (limit(n) > w.used) { until = R - n * DAY; break }
    return { reason: 'reserveWeek', room: limit(left) - w.used, until }
  }
  // Waits until a later midnight lifts the line past the margin, or the reset.
  let until = R
  for (const d of dayShares(chosenDays(p), R)) {
    if (d.start > now && targetLine(p, R, d.start) - p.margin > w.used) { until = d.start; break }
  }
  return { reason: 'ahead', room: targetLine(p, R, now) - p.margin - w.used, until }
}

export function paceVerdict(policy: PacePolicy, quota: Quota | null, now: number, intent: PaceIntent = 'auto'): PaceVerdict {
  const refuse = (reason: PaceReason, until: number | null): PaceVerdict =>
    intent === 'user' ? { go: true, warn: reason } : { go: false, reason, until }
  if (!quota) return { go: true, unknown: true }
  if (quota.limited && (quota.limited.resetsAt === null || quota.limited.resetsAt > now)) return refuse('limited', quota.limited.resetsAt)

  const week = current(quota.week, now), five = current(quota.five, now)
  if (!week?.resetsAt && !five) return { go: true, unknown: true }
  const checks: Check[] = []
  if (week?.resetsAt) checks.push(weekCheck(policy, { used: week.used, resetsAt: week.resetsAt }, now))
  if (five) {
    const burning = checks[0]?.reason === 'burnCap'
    const reserve = burning ? policy.burn!.reserve5h : policy.reserve5h
    checks.push({ reason: 'reserve5h', room: 100 - reserve - five.used, until: five.resetsAt })
  }

  // Blocked: report the limit that lifts last.
  const blocked = checks.filter(c => c.room <= 0)
  if (blocked.length) {
    const last = blocked.reduce((a, b) => (a.until === null || (b.until !== null && b.until <= a.until) ? a : b))
    return refuse(last.reason, last.until)
  }
  // An old reading starts automatic work only with a wide margin left.
  if (intent === 'auto' && now - quota.at > policy.stale.minutes * 60_000 && checks.some(c => c.room < policy.stale.margin)) {
    return { go: false, reason: 'stale', until: null }
  }
  return { go: true }
}

const PACE_MODES: PaceMode[] = ['workdays', 'everyday', 'free']
const pctIn = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : undefined)

// The user's changes to a policy (Settings › Pace), checked field by field over
// `base`: unknown or invalid fields keep the base value. The burn stays as it is.
export function mergePolicy(base: PacePolicy, patch: unknown): PacePolicy {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
  const out: PacePolicy = { ...base, days: [...base.days], stale: { ...base.stale } }
  if (PACE_MODES.includes(p.mode as PaceMode)) out.mode = p.mode as PaceMode
  const days = Array.isArray(p.days) ? [...new Set(p.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : []
  if (days.length) out.days = days // no day at all: automatic work would wait until the reset
  out.cap = pctIn(p.cap, 10, 100) ?? out.cap
  out.reserve5h = pctIn(p.reserve5h, 0, 90) ?? out.reserve5h
  out.reservePerDay = pctIn(p.reservePerDay, 0, 14) ?? out.reservePerDay
  return out
}
