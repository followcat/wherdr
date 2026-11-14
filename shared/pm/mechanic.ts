// What the engine does alone, without waking the coordinator: restart a task
// once its agent's login is back, retry a failed push (synced with its remote
// first when refused as behind it), run again an interrupted action, fix a
// PR's base, catch up the target branch, re-run CI that failed for
// infrastructure reasons (its conclusion or its log), send red CI back to the
// agent, merge what the branch rule allows (selfFix.ts counts the tries). Pure:
// each move has its guard here; server/utils/pmMechanic.ts gathers the facts
// and carries the move out. A move is made once per key (task.mech).
import { isTransient, prReady, type PrInfo } from './actions'
import { isProtected, type ResolvedGuards } from './guards'
import { NOT_PUSHED, mergeGoesOn } from './mergeQueue'
import { DEFAULT_ROUNDS, waitsToMerge, type PlannedStep } from './steps'
import type { Task } from './run'
import { blockOf } from './selfFix'

export interface PrState extends PrInfo { mergeStateStatus?: string }
export interface MechFacts {
  task: Task
  plan: PlannedStep[]
  guards: ResolvedGuards
  branch: string
  agentBusy: boolean // the worker's terminal is working: its worktree is not touched
  head?: string // the task's commit
  pr?: PrState // its open PR, else its merged one (merged: true)
  loggedIn?: boolean // the agent's program answers its login status again
  queue?: number // its place in the merge queue (mergeQueue.ts): only the first merges
  queueOut?: string // why it stepped out of the queue's line: it does not merge, its own updates go on
  infra?: boolean // the failed jobs' log shows an infrastructure error (infraLog)
  now?: number
}

export type Move =
  | { kind: 'restart' }
  | { kind: 'retry-action', step: string }
  | { kind: 'sync-push', step: string }
  | { kind: 'fix-base', base: string }
  | { kind: 'catch-up', base: string }
  | { kind: 'take-update' }
  | { kind: 'rerun-ci', checks: string[] }
  | { kind: 'ci-to-agent', checks: string[] }
  | { kind: 'merge', url: string, base: string }

const RETRIED = ['git.push', 'github.pr', 'git.land']
// Conclusions that say nothing of the code: run again once.
const INFRA = ['CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE', 'STALE']
const GREEN = ['SUCCESS', 'NEUTRAL', 'SKIPPED']
// A failed job's log that says nothing of the code: a server error, a download
// that timed out, the runner lost.
const INFRA_LOG = [
  /\bHTTP\/?[\d.]* ?(error )?5\d\d\b/i, /returned error: 5\d\d\b/i, /\b50[234] (Bad Gateway|Service Unavailable|Gateway Time-?out)/i,
  /(download|fetch)\w*\b.{0,80}\b(timed out|timeout)/i, /\b(timed out|timeout)\b.{0,80}\bdownload/i,
  /runner .{0,60}(lost|shutdown signal)|lost communication with the server/i,
]
export const infraLog = (log: string) => INFRA_LOG.some(r => r.test(log))
// An update with the base that failed (a passing git error) is tried again,
// spaced out, a few times per commit; past them it gives up the merge queue's front.
export const CATCH_UP_TRIES = 3
const CATCH_UP_GAP_MS = 2 * 60_000
const catchUps = (task: Task, head: string) =>
  Object.entries(task.mech ?? {}).filter(([k]) => k === `catch-up:${head}` || k.startsWith(`catch-up:${head}:`)).map(([, at]) => at)
export const catchUpGaveUp = (task: Task, head?: string) => !!head && catchUps(task, head).length >= CATCH_UP_TRIES

const checkName = (c: { name?: string, context?: string }) => c.name || c.context || 'a check'

// The PR's failed checks, once none still runs.
const checksRun = (pr: PrState) => (pr.statusCheckRollup ?? []).some(c => (c.status && c.status !== 'COMPLETED') || ['PENDING', 'EXPECTED'].includes(c.state ?? ''))
function redChecks(pr: PrState) {
  return checksRun(pr) ? [] : (pr.statusCheckRollup ?? []).filter(c => !GREEN.includes(c.conclusion || c.state || ''))
}

// The task's CI as the engine reads it: red only while the PR head is still
// the task's commit and its checks have finished red (pm/blocked.ts).
// running: its checks have not all finished (a finished run is news for rechecks).
export const ciOf = (pr: PrState | undefined, head: string | undefined): NonNullable<Task['ci']> | undefined =>
  pr && head && !pr.merged ? { head, red: pr.headRefOid === head && redChecks(pr).length > 0, ...(checksRun(pr) ? { running: true as const } : {}) } : undefined

// The next mechanical move for a task and its key, or undefined.
export function nextMove(f: MechFacts): { move: Move, key: string } | undefined {
  const { task, plan, guards, pr, head } = f
  const s = task.step, done = (key: string) => task.mech?.[key] != null
  const pick = (key: string, move: Move) => (done(key) ? undefined : { move, key })
  // A task stopped on a login: started again once the login is back.
  if (task.state === 'waiting' && task.waitKind === 'auth') return f.loggedIn ? pick(`restart:${task.run ?? ''}`, { kind: 'restart' }) : undefined
  if (!s?.started || s.done || task.state !== 'working') return
  const step = plan[s.at]
  if (!step) return
  const n = s.tries?.[step.id] ?? 0
  const failed = step.action && !s.acting && s.yourTurn?.reason === 'action'
  // Refused as behind its remote: the worktree takes the remote's commits, then pushes again.
  // Counted by syncs, not attempts: a sync conflict handed to the worker runs no attempt.
  if (failed && step.ends === 'action' && RETRIED.includes(step.action!.kind) && !step.guarded && blockOf(task) === 'push') {
    const syncs = Object.keys(task.mech ?? {}).filter(k => k.startsWith(`sync:${step.id}:`)).length
    return pick(`sync:${step.id}:${syncs}`, { kind: 'sync-push', step: step.id })
  }
  // Interrupted by a restart: run again (a merge done meanwhile is recorded as merged).
  if (failed && blockOf(task) === 'interrupted' && (step.ends === 'action' ? !step.guarded : waitsToMerge(step) && !!s.approved))
    return pick(`again:${step.id}:${n}`, { kind: 'retry-action', step: step.id })
  // A push, PR or landing that failed on a passing error, outside a guarded merge.
  if (step.ends === 'action' && !s.acting && s.yourTurn?.reason === 'action' && RETRIED.includes(step.action!.kind) && !step.guarded
    && isTransient(1, s.yourTurn.badge) && (s.tries?.[step.id] ?? 0) < 3)
    return pick(`retry:${step.id}:${s.tries?.[step.id] ?? 0}`, { kind: 'retry-action', step: step.id })
  // The rest needs the task's open PR, at its commit, opened by an earlier step.
  const prStep = plan.slice(0, s.at).findLast(p => p.action?.kind === 'github.pr')
  const base = prStep?.action?.base
  if (!pr || !head || !base) return
  // The guards decide, a protected branch too (merge.protected: engine).
  // A merge step waiting for the user: watched while it waits; once the user
  // approved it, the engine merges it when ready, under the user's approval.
  const waits = waitsToMerge(step) && !s.acting
  // In the merge queue: only the first in line merges, one per tick; updates go on whatever the place.
  const held = (f.queue ?? 1) > 1 || !!f.queueOut
  const engineMerges = mergeGoesOn(step, s, guards, pr.baseRefName) && !(waits && s.catchUp) && !held
  // One per commit and merge attempt: a head reviewed again is merged on the step's next attempt.
  const mergeKey = `merge:${head}${n > 1 ? `:${n}` : ''}`
  const mergeMove = () => (engineMerges && (pr.merged || prReady(pr, head, step.action!.checks).ok)
    ? pick(mergeKey, { kind: 'merge', url: pr.url, base: pr.baseRefName })
    : undefined)
  // Merged on GitHub already, whatever its head: nothing to fix on it, the merge
  // step records it, even after an attempt of its own that was refused, and
  // even when the guard keeps that branch for the user (they merged it, or approved it).
  const mergeStep = step.action?.kind === 'github.merge' && (step.ends === 'action' || (waits && !!s.approved))
  if (pr.merged) return mergeStep ? pick(`merged:${pr.url}`, { kind: 'merge', url: pr.url, base: pr.baseRefName }) : undefined
  // One catch-up at a time: run again once the agent committed its conflict resolution (a new head).
  if (waits && s.catchUp) {
    if (f.agentBusy) return
    const tries = catchUps(task, head)
    if (!tries.length) return pick(`catch-up:${head}`, { kind: 'catch-up', base: s.catchUp.base })
    // Its conflict reached no worker (it could not start): tried again, spaced out, a few times.
    return s.agent || tries.length >= CATCH_UP_TRIES || (f.now ?? Date.now()) - Math.max(...tries) < CATCH_UP_GAP_MS ? undefined
      : pick(`catch-up:${head}:${tries.length + 1}`, { kind: 'catch-up', base: s.catchUp.base })
  }
  // The PR head is not the task's commit (a CI fix not pushed, a push from
  // elsewhere): the merge step pushes it and has it reviewed again, or says why not.
  // Out of line for that only, it is still pushed: its own update, whatever its place.
  if (pr.headRefOid !== head) {
    if (f.agentBusy) return
    const pushes = mergeGoesOn(step, s, guards, pr.baseRefName) && !(waits && s.catchUp) && (!f.queueOut || f.queueOut === NOT_PUSHED)
    if (engineMerges || pushes) return pick(mergeKey, { kind: 'merge', url: pr.url, base: pr.baseRefName })
    // Not merging now (it waits for the user, or for its turn): a head GitHub's Update branch made is still fixed and pushed.
    return pick(`update:${pr.headRefOid}`, { kind: 'take-update' })
  }
  if (pr.baseRefName !== base) return pick(`base:${head}`, { kind: 'fix-base', base })
  if (f.agentBusy) return
  // Updated with its base only when GitHub reports a conflict or requires it (BEHIND: the branch rules want it up to date).
  if (['BEHIND', 'DIRTY'].includes(pr.mergeStateStatus ?? '') && !isProtected(guards, f.branch)) {
    const tries = catchUps(task, head)
    if (!tries.length) return pick(`catch-up:${head}`, { kind: 'catch-up', base })
    // Tried already at this commit: again unless its agent holds a conflict, spaced out.
    if (tries.length < CATCH_UP_TRIES) {
      return s.agent || (f.now ?? Date.now()) - Math.max(...tries) < CATCH_UP_GAP_MS ? undefined
        : pick(`catch-up:${head}:${tries.length + 1}`, { kind: 'catch-up', base })
    }
    // Past its tries: what GitHub allows goes on below.
  }
  const red = redChecks(pr)
  // Run again once; red again after that, it goes to the agent.
  if (red.length && (red.every(c => INFRA.includes(c.conclusion || '')) || f.infra) && !done(`rerun:${head}`)) return pick(`rerun:${head}`, { kind: 'rerun-ci', checks: red.map(checkName) })
  if (red.length) {
    // One send per commit, within the send-back rounds; past them, the user's.
    const sent = Object.keys(task.mech ?? {}).filter(k => k.startsWith('red:')).length
    return sent < DEFAULT_ROUNDS ? pick(`red:${head}`, { kind: 'ci-to-agent', checks: red.map(checkName) }) : undefined
  }
  // A merge step the guards give the engine; any other waits for the user's gesture.
  return mergeMove()
}

// What the agent is told when its CI is red.
export const redCiText = (checks: string[], head: string) =>
  `CI failed on ${checks.join(', ')} (commit ${head.slice(0, 7)}). Read the failing job's log (gh pr checks, gh run view --log-failed), fix it, commit, then say you are done.`
