// Whether a "limit reached" reading still holds now: one rule for the home
// row, the status card, pacing and incident checks. A limit is over once its
// reset time has passed (with no reset time known: 5 hours after the reading,
// the short window). While it holds, credits on the account let work go on.
// A reading older than STALE_MS no longer states the limit as fact: the
// provider may have reset the account early (WHR-445).
import type { Quota } from './types'

export const LIMIT_NO_RESET_MS = 5 * 3_600_000
// A reading older than this (1 h) is to be taken with caution.
export const STALE_MS = 3_600_000

// When the limit of a reading lifts (ms), or null when it is not limited.
export const limitEnds = (q: Pick<Quota, 'limited' | 'at'>) =>
  q.limited ? q.limited.resetsAt ?? q.at + LIMIT_NO_RESET_MS : null

// 'reached': blocked until `limitEnds`; 'credits': reached, but the account
// has credits to go on with; 'stale': reached when last read, over STALE_MS
// ago, so maybe reset since (unknown, never blocking by itself); 'expired':
// its reset has passed since the reading.
export type LimitState = 'reached' | 'credits' | 'stale' | 'expired'
export function limitState(q: Pick<Quota, 'limited' | 'at' | 'credits'>, now: number): LimitState | null {
  const end = limitEnds(q)
  if (end === null) return null
  if (end <= now) return 'expired'
  if (q.credits) return 'credits'
  return now - q.at > STALE_MS ? 'stale' : 'reached'
}

// "16 h" since the reading.
export const hoursAgo = (at: number, now: number) => `${Math.max(1, Math.round((now - at) / 3_600_000))} h`
