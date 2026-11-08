// Short history of the quota readings (WHR-376 § 3.2): one line per account
// each time a value changes, kept 8 days. It gives "used today" on the weekly
// window, the base of the pacing line. Pure; the file is in
// server/utils/pacingLog.ts.
import type { Quota } from './types'

// `five` and `week`: % used (null: window not in the plan); `reset`: the weekly
// window's reset time (ms), which tells a reset apart from a correction.
export interface PacingEntry { account: string, at: number, five: number | null, week: number | null, reset: number | null }

export const LOG_KEEP_MS = 8 * 86400000
// Reset times are recomputed on each reply: within 10 minutes, same window.
const SAME_WINDOW = 10 * 60000

// Entry of a reading; null for a reading without numbers ("limit reached").
export function pacingEntry(account: string, q: Quota): PacingEntry | null {
  if (q.limited || (!q.five && !q.week) || !q.at) return null
  return { account, at: q.at, five: q.five?.used ?? null, week: q.week?.used ?? null, reset: q.week?.resetsAt ?? null }
}

const sameReset = (a: number | null, b: number | null) => (a && b ? Math.abs(a - b) <= SAME_WINDOW : a === b)

// Worth a line? Only when newer than the account's last line and a value moved.
export function changed(last: PacingEntry | undefined, next: PacingEntry): boolean {
  if (!last) return true
  if (next.at <= last.at) return false
  return next.five !== last.five || next.week !== last.week || !sameReset(last.reset, next.reset)
}

export const keepRecent = (entries: PacingEntry[], now: number) => entries.filter(e => e.at > now - LOG_KEEP_MS)

// Last line of each account.
export function lastByAccount(entries: PacingEntry[]): Map<string, PacingEntry> {
  const m = new Map<string, PacingEntry>()
  for (const e of entries) {
    const l = m.get(e.account)
    if (!l || e.at >= l.at) m.set(e.account, e)
  }
  return m
}

// Line read back from the file; null if malformed.
export function parseEntry(line: string): PacingEntry | null {
  try {
    const e = JSON.parse(line)
    const num = (v: unknown) => (v === null || (typeof v === 'number' && Number.isFinite(v)))
    if (typeof e?.account !== 'string' || typeof e.at !== 'number' || !num(e.five) || !num(e.week) || !num(e.reset)) return null
    return { account: e.account, at: e.at, five: e.five, week: e.week, reset: e.reset }
  } catch { return null }
}

// Local midnight that starts the day of `now` (the machine running wherdr).
export function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Weekly % used today (local day), reset included; null without any reading.
// Starts from the account's last line before midnight (lines are only written on
// change: usage first seen after midnight belongs to today), or else its first
// line of the day. Each step adds what the window grew; when the week was reset
// in between, what was used before the reset stays counted and the new window's
// usage is added from 0. A lower value in the same window (a correction) adds
// nothing.
export function usedToday(entries: PacingEntry[], account: string, now: number): number | null {
  const list = entries.filter(e => e.account === account && e.week !== null && e.at <= now).sort((a, b) => a.at - b.at)
  const midnight = startOfDay(now)
  const before = list.filter(e => e.at <= midnight).pop()
  const day = list.filter(e => e.at > midnight)
  const seq = before ? [before, ...day] : day
  if (!seq.length) return null
  let used = 0
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1]!
    const b = seq[i]!
    const reset = a.reset && b.reset ? b.reset - a.reset > SAME_WINDOW : b.week! < a.week!
    used += reset ? b.week! : Math.max(0, b.week! - a.week!)
  }
  return Math.round(used * 10) / 10
}
