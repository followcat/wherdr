// The pace of a project's automatic work, now: the account its worker uses
// (the project's machine × the worker's program), that account's latest
// reading and verdict. Read only when an automatic start or a scheduled wake
// asks for it.
import { accountFor } from '../../shared/quotaAccount'
import { DEFAULT_PACE, paceVerdict } from '../../shared/pm/pacing'
import { accountQuota, paceRows, type PaceRow, type PaceState } from '../../shared/pm/pace'
import { workerPlan, type Task } from '../../shared/pm/run'
import type { Quotas } from '../../shared/types'
import type { PmStore } from './pmStore'
import { readQuotas } from './quotas'
import { accountUsedToday } from './pacingLog'
import { policyIn, readPolicies } from './pacingPolicies'

// `task`: the one to start (its type and prefs pick the program); none: the
// template's first task type. `withToday`: also the weekly % used today
// (`autopilot show`). null: no template, or no worker program.
export async function projectPace(store: PmStore, project: string, task?: Pick<Task, 'type' | 'prefs'>, now = Date.now(), withToday = false): Promise<PaceState | null> {
  const p = (await store.projects()).find(x => x.key === project)
  const t = p ? await store.workflow(p.key) : null
  if (!p || !t) return null
  const type = task?.type ?? Object.keys(t.taskTypes)[0] ?? ''
  const plan = workerPlan(t, { type, ...(task?.prefs ? { prefs: task.prefs } : {}) } as Task)
  if ('reason' in plan) return null
  const program = plan.program as 'claude' | 'codex'
  // A failed read: quota unknown, only the task-count limits hold.
  const q: Quotas | null = await readQuotas().catch(() => null)
  const account = accountFor(q?.accounts, p.machine, program)
  const quota = q && account ? accountQuota(q, account) : null
  const policy = account ? policyIn(await readPolicies(), account.key) : DEFAULT_PACE
  const today = account && withToday ? await accountUsedToday(account.key, now).catch(() => null) : null
  return { program, account, quota, policy, verdict: paceVerdict(policy, quota, now), today }
}

// Settings › Pace: every account read, plus a program with no reading at all.
export async function pacingView(now = Date.now()): Promise<{ rows: PaceRow[] }> {
  const q: Quotas | null = await readQuotas().catch(() => null)
  const policies = await readPolicies()
  const today = Object.fromEntries(await Promise.all((q?.accounts ?? []).map(async a => [a.key, await accountUsedToday(a.key, now).catch(() => null)] as const)))
  return { rows: paceRows(q, key => policyIn(policies, key), today, now) }
}
