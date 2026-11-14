// Reviews per reviewer account: a few at once on one account, the others wait
// in order, oldest first; an account near its limit or held by its pace hands
// new reviews to the fallback reviewer.
import type { Quota, Quotas } from '../types'
import { accountFor } from '../quotaAccount'
import { accountOut, accountQuota, paceWait } from './pace'
import { current, paceVerdict, type PacePolicy } from './pacing'
import { programName, type Run, type Task } from './run'

// The 5-hour % from which a new review goes to the fallback.
export const REVIEW_NEAR = 90

export interface ReviewAccount { key: string, name: string, quota: Quota | null }

// The account an agent of `program` uses on `machine`; a machine with no
// account of its own: the program's reading, keyed by the program.
export function reviewAccount(q: Quotas | null, program: string, machine: string): ReviewAccount {
  const known = program === 'claude' || program === 'codex'
  const a = q && known ? accountFor(q.accounts, machine, program) : null
  const quota = !q || !known ? null : a ? accountQuota(q, a) : q[program]
  return { key: a?.key ?? program, name: programName(program), quota }
}

// Why the review agent's account takes no new review now: at its limit, its
// 5-hour window near full, or held by its pace. undefined: it can.
export function reviewerOut(q: Quotas | null, program: string, machine: string, policyOf: (key: string) => PacePolicy, now: number): string | undefined {
  const out = accountOut(q, program, machine, now)
  if (out) return out
  const { key, name, quota } = reviewAccount(q, program, machine)
  const five = quota && current(quota.five, now)
  if (five && five.used >= REVIEW_NEAR) return `${name} 5h at ${Math.round(five.used)} %`
  const v = paceVerdict(policyOf(key), quota, now)
  return v.go ? undefined : `${name} paced: ${paceWait(v)}`
}

// Reviews one account runs at once: 3 while its 5-hour window is under half used, else 2.
export function reviewCap(quota: Quota | null, now: number) {
  const five = quota && current(quota.five, now)
  return five && five.used < 50 ? 3 : 2
}

// A task's review is due, not yet told (its reviewer not started or not sent the round).
const due = (t: Task) => t.state === 'working' && !!t.step && !t.step.done && t.step.told !== t.step.since

// The reviews running on each account: a live reviewer holding its task's told step.
export function runningReviews(tasks: Task[], runs: Run[], keyOf: (r: Run) => string) {
  const n = new Map<string, number>()
  for (const r of runs) {
    const t = r.role === 'reviewer' && r.state !== 'ended' ? tasks.find(x => x.id === r.task) : undefined
    if (t?.run === r.id && t.step && !t.step.done && t.step.told === t.step.since) n.set(keyOf(r), (n.get(keyOf(r)) ?? 0) + 1)
  }
  return n
}

// Where a task's new review stands on account `key`: it goes, or waits behind
// the running reviews and the older waiting ones (their step due first).
export function reviewTurn(task: Task, key: string, tasks: Task[], running: number, cap: number): { go: true } | { ahead: number } {
  const order = (t: Task) => [t.step?.since ?? 0, t.id] as const
  const [since, id] = order(task)
  const older = tasks.filter(t => t.id !== task.id && t.reviewWait === key && due(t) && (order(t)[0] < since || (order(t)[0] === since && t.id < id))).length
  return running + older < cap ? { go: true } : { ahead: running + older }
}

// An account's quota by the key reviewAccount gives.
export function quotaByKey(q: Quotas | null, key: string): Quota | null {
  const a = q?.accounts?.find(x => x.key === key)
  return !q ? null : a ? accountQuota(q, a) : key === 'claude' || key === 'codex' ? q[key] : null
}

// `autopilot show`'s line per reviewer account with reviews running or
// waiting: its 5-hour and weekly use, then its queue.
export function reviewQueueLines(tasks: Task[], running: Map<string, number>, quotaOf: (key: string) => Quota | null, now: number) {
  const waiting = tasks.filter(t => t.reviewWait && due(t))
  const keys = new Set([...running.keys(), ...waiting.map(t => t.reviewWait!)])
  return Object.fromEntries([...keys].map((k) => {
    const quota = quotaOf(k), five = quota && current(quota.five, now), week = quota && current(quota.week, now)
    const use = [five && `5 h ${Math.round(five.used)} %`, week && `week ${Math.round(week.used)} %`].filter(Boolean)
    return [k, [...use, `${running.get(k) ?? 0} running, ${waiting.filter(t => t.reviewWait === k).length} waiting (${reviewCap(quota, now)} at once)`].join(' · ')]
  }))
}
