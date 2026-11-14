// Whether a "limit reached" reading still holds now: one rule for the home
// row, the status card, pacing and incident checks. A limit is over once its
// reset time has passed (with no reset time known: 5 hours after the reading,
// the short window). While it holds, credits on the account let work go on.
import type { Quota } from './types'

export const LIMIT_NO_RESET_MS = 5 * 3_600_000

// When the limit of a reading lifts (ms), or null when it is not limited.
export const limitEnds = (q: Pick<Quota, 'limited' | 'at'>) =>
  q.limited ? q.limited.resetsAt ?? q.at + LIMIT_NO_RESET_MS : null

// 'reached': blocked until `limitEnds`; 'credits': reached, but the account
// has credits to go on with; 'expired': its reset has passed since the reading.
export type LimitState = 'reached' | 'credits' | 'expired'
export function limitState(q: Pick<Quota, 'limited' | 'at' | 'credits'>, now: number): LimitState | null {
  const end = limitEnds(q)
  if (end === null) return null
  if (end <= now) return 'expired'
  return q.credits ? 'credits' : 'reached'
}
