// What the engine does alone, without waking the coordinator: restart a task
// once its agent's login is back, retry a failed push, fix a PR's base, catch
// up the target branch, re-run CI that failed for infrastructure reasons,
// send red CI back to the agent, merge what the branch rule allows. Pure:
// each move has its guard here; server/utils/pmMechanic.ts gathers the facts
// and carries the move out. A move is made once per key (task.mech).
import { isTransient, prReady, type PrInfo } from './actions'
import { isProtected, mayMerge, type ResolvedGuards } from './guards'
import { DEFAULT_ROUNDS, type PlannedStep } from './steps'
import type { Task } from './run'

export interface PrState extends PrInfo { mergeStateStatus?: string }
export interface MechFacts {
  task: Task
  plan: PlannedStep[]
  guards: ResolvedGuards
  branch: string
  agentBusy: boolean // the worker's terminal is working: its worktree is not touched
  head?: string // the task's commit
  pr?: PrState // its open PR
  loggedIn?: boolean // the agent's program answers its login status again
}

export type Move =
  | { kind: 'restart' }
  | { kind: 'retry-action', step: string }
  | { kind: 'fix-base', base: string }
  | { kind: 'catch-up', base: string }
  | { kind: 'rerun-ci', checks: string[] }
  | { kind: 'ci-to-agent', checks: string[] }
  | { kind: 'merge', url: string, base: string }

const RETRIED = ['git.push', 'github.pr', 'git.land']
// Conclusions that say nothing of the code: run again once.
const INFRA = ['CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE', 'STALE']
const GREEN = ['SUCCESS', 'NEUTRAL', 'SKIPPED']

const checkName = (c: { name?: string, context?: string }) => c.name || c.context || 'a check'

// The next mechanical move for a task and its key, or undefined.
export function nextMove(f: MechFacts): { move: Move, key: string } | undefined {
  const { task, plan, guards, pr, head } = f
  const s = task.step, done = (key: string) => !!task.mech?.[key]
  const pick = (key: string, move: Move) => (done(key) ? undefined : { move, key })
  // A task stopped on a login: started again once the login is back.
  if (task.state === 'waiting' && task.waitKind === 'auth') return f.loggedIn ? pick(`restart:${task.run ?? ''}`, { kind: 'restart' }) : undefined
  if (!s?.started || s.done || task.state !== 'working') return
  const step = plan[s.at]
  if (!step) return
  // A push, PR or landing that failed on a passing error, outside a guarded merge.
  if (step.ends === 'action' && !s.acting && s.yourTurn?.reason === 'action' && RETRIED.includes(step.action!.kind) && !step.guarded
    && isTransient(1, s.yourTurn.badge) && (s.tries?.[step.id] ?? 0) < 3)
    return pick(`retry:${step.id}:${s.tries?.[step.id] ?? 0}`, { kind: 'retry-action', step: step.id })
  // The rest needs the task's open PR, at its commit, opened by an earlier step.
  const prStep = plan.slice(0, s.at).findLast(p => p.action?.kind === 'github.pr')
  const base = prStep?.action?.base
  if (!pr || !head || pr.headRefOid !== head || !base) return
  if (pr.baseRefName !== base) return pick(`base:${head}`, { kind: 'fix-base', base })
  if (f.agentBusy) return
  if (['BEHIND', 'DIRTY'].includes(pr.mergeStateStatus ?? '') && !isProtected(guards, f.branch)) return pick(`catch-up:${head}`, { kind: 'catch-up', base })
  const checks = pr.statusCheckRollup ?? []
  const running = checks.some(c => (c.status && c.status !== 'COMPLETED') || ['PENDING', 'EXPECTED'].includes(c.state ?? ''))
  const red = running ? [] : checks.filter(c => !GREEN.includes(c.conclusion || c.state || ''))
  if (red.length && red.every(c => INFRA.includes(c.conclusion || ''))) return pick(`rerun:${head}`, { kind: 'rerun-ci', checks: red.map(checkName) })
  if (red.length) {
    // One send per commit, within the send-back rounds; past them, the user's.
    const sent = Object.keys(task.mech ?? {}).filter(k => k.startsWith('red:')).length
    return sent < DEFAULT_ROUNDS ? pick(`red:${head}`, { kind: 'ci-to-agent', checks: red.map(checkName) }) : undefined
  }
  // A merge step the branch rule gives the engine. A protected branch is never
  // merged without the user's gesture, whatever the rule or the autopilot.
  if (step.action?.kind === 'github.merge' && step.ends === 'action' && !step.guarded && !isProtected(guards, pr.baseRefName)
    && mayMerge(guards, pr.baseRefName, 'engine') && prReady(pr, head).ok)
    return pick(`merge:${head}`, { kind: 'merge', url: pr.url, base: pr.baseRefName })
}

// What the agent is told when its CI is red.
export const redCiText = (checks: string[], head: string) =>
  `CI failed on ${checks.join(', ')} (commit ${head.slice(0, 7)}). Read the failing job's log (gh pr checks, gh run view --log-failed), fix it, commit, then say you are done.`
