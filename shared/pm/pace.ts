// The pace of automatic work (WHR-376 § 4.2, § 5): which starts are held by
// the verdict of the worker's account (shared/pm/pacing.ts), the account's
// quota among the readings, and the words the coordinator and the firings get.
import type { Quota, QuotaAccount, Quotas } from '../types'
import type { Task, TaskOrigin } from './run'
import { DEFAULT_PACE, current, paceVerdict, targetLine, type PacePolicy, type PaceReason, type PaceVerdict } from './pacing'

// Tasks made before `origin` existed: from their other marks.
export const originOf = (t: Pick<Task, 'origin' | 'auto' | 'autopilot'>): TaskOrigin =>
  t.origin ?? (t.auto ? 'automation' : t.autopilot ? 'coordinator' : 'user')

// Who starts it now: the user's turn, a wake, or the engine (an 'after' chain).
export type Starter = 'user' | 'wake' | 'engine'

// Is this start automatic work, held by the pace? Never the user's own start,
// never the next step of a task already under way (stopping halfway wastes what
// it used), never a chain the user made (its order is their request).
export function pacedStart(task: Pick<Task, 'origin' | 'auto' | 'autopilot' | 'step'>, starter: Starter): boolean {
  if (starter === 'user' || task.step?.started) return false
  return starter === 'wake' || originOf(task) !== 'user'
}

// The quota of one account: its own block when the accounts of its program
// are told apart, else the program's reading (one account of it).
export function accountQuota(q: Quotas, account: QuotaAccount): Quota | null {
  const blocks = account.program === 'claude' ? q.claudeAccounts : q.codexAccounts
  if (blocks?.length) return blocks.find(b => b.key === account.key) ?? null
  return q[account.program]
}

const REASONS: Record<PaceReason, string> = {
  limited: 'the account hit its limit',
  ahead: 'ahead of the target line',
  reserveWeek: 'the weekly reserve is reached',
  reserve5h: 'the 5-hour reserve is reached',
  burnCap: 'the burn\'s cap is reached',
  stale: 'the last reading is too old for the margin left',
}

const when = (t: number) => new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })

// "ahead of the target line until Fri 00:00".
export function paceWait(v: Extract<PaceVerdict, { go: false }>): string {
  return `${REASONS[v.reason]}${v.until ? ` until ${when(v.until)}` : ' until the next reading'}`
}

// Why the pace holds this automatic start, or undefined.
export const paceRefusal = (v: PaceVerdict | undefined) =>
  v && !v.go ? `Paced: ${paceWait(v)} (automatic work waits; the user's own starts never do)` : undefined

const MODES: Record<PacePolicy['mode'], string> = { workdays: 'working days', everyday: 'every day', free: 'free with reserve' }

// The weekly % automatic work may reach now: the target line, the free mode's
// limit (100 − the reserve of the days left), or the burn's cap.
export function weekLimit(p: PacePolicy, resetsAt: number, now: number) {
  if (p.burn && now >= (p.burn.start ?? resetsAt - 86_400_000)) return { label: 'burn cap' as const, value: p.burn.cap }
  if (p.mode === 'free') return { label: 'limit' as const, value: 100 - p.reservePerDay * Math.ceil((resetsAt - now) / 86_400_000) }
  return { label: 'line' as const, value: targetLine(p, resetsAt, now) }
}

export interface PaceState {
  program: string // the worker's program
  account: QuotaAccount | null // null: no reading of it on the project's machine
  quota: Quota | null
  policy: PacePolicy
  verdict: PaceVerdict
  today: number | null // weekly % used today
}

const pct = (n: number) => `${Math.round(n)} %`

// `autopilot show`'s line: `pacing: claude:ab12 Pro · working days · week 41 % /
// line 54 % · today +9 % · 5 h 30 % · go`.
export function paceLine(s: PaceState, now: number): string {
  if (!s.account || s.verdict.go && s.verdict.unknown) {
    return `${s.account?.key ?? s.program}${s.account?.name ? ` ${s.account.name}` : ''} · quota unknown (no reading${s.account ? '' : ` of ${s.program} on this project's machine`}) · task-count limits only`
  }
  const parts = [`${s.account.key}${s.account.name ? ` ${s.account.name}` : ''}`, MODES[s.policy.mode]]
  const week = s.quota && current(s.quota.week, now), five = s.quota && current(s.quota.five, now)
  if (week?.resetsAt) {
    const l = weekLimit(s.policy, week.resetsAt, now)
    parts.push(`week ${pct(week.used)} / ${l.label} ${pct(l.value)}`)
  }
  if (s.today !== null) parts.push(`today +${pct(s.today)}`)
  if (five) parts.push(`5 h ${pct(five.used)}`)
  parts.push(s.verdict.go ? 'go' : `wait: ${paceWait(s.verdict)}`)
  return parts.join(' · ')
}

// One row of Settings › Pace: an account (or a program with no reading at all:
// account null, quota unknown), its policy, where it stands and its verdict.
export interface PaceRow {
  program: 'claude' | 'codex'
  account: QuotaAccount | null
  policy: PacePolicy
  week: { used: number, resetsAt: number, limit: number, label: ReturnType<typeof weekLimit>['label'] } | null
  five: { used: number, resetsAt: number | null } | null
  at: number | null // time of the reading
  today: number | null
  verdict: PaceVerdict
}

export function paceRows(q: Quotas | null, policyOf: (key: string) => PacePolicy, today: Record<string, number | null>, now: number): PaceRow[] {
  const accounts = q?.accounts ?? []
  return (['claude', 'codex'] as const).flatMap((program): PaceRow[] => {
    const mine = accounts.filter(a => a.program === program)
    if (!mine.length) return [{ program, account: null, policy: DEFAULT_PACE, week: null, five: null, at: null, today: null, verdict: { go: true, unknown: true } }]
    return mine.map((account) => {
      const quota = q ? accountQuota(q, account) : null
      const policy = policyOf(account.key)
      const w = quota && current(quota.week, now), f = quota && current(quota.five, now)
      const l = w?.resetsAt ? weekLimit(policy, w.resetsAt, now) : null
      const week = w?.resetsAt && l ? { used: w.used, resetsAt: w.resetsAt, limit: l.value, label: l.label } : null
      return { program, account, policy, week, five: f ?? null, at: quota?.at ?? null, today: today[account.key] ?? null, verdict: paceVerdict(policy, quota, now) }
    })
  })
}
