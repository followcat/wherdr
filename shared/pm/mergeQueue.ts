// A project's merge queue: the tasks whose merge may go on (the engine merges
// it, or the user approved it). Only PRs ready to merge now stand in line, and
// the first merges; a PR that needs work (a conflict, an update GitHub
// requires, checks running or red, work handed to its agent) steps out until
// it is ready again, so it never holds up the others. Each queued PR is
// updated with its base on its own, whatever its place, and only when GitHub
// reports a conflict or requires it (BEHIND: the branch rules want it up to
// date). Pure: server/utils/pmMechanic.ts keeps each task's place (task.queue)
// and why it stepped out (task.queueOut), and carries out the moves.
import { prReady } from './actions'
import { mergeAfterIds } from './advance'
import { mayMerge, type ResolvedGuards } from './guards'
import type { MechFacts } from './mechanic'
import { waitsToMerge, type PlannedStep, type StepState } from './steps'
import type { Task } from './run'

// May this merge step go on without the user: the guards give it to the
// engine, or the user approved it (a merge that waited for them).
export const mergeGoesOn = (step: PlannedStep | undefined, s: StepState, guards: ResolvedGuards, base: string) =>
  (step?.action?.kind === 'github.merge' && step.ends === 'action' && !step.guarded && mayMerge(guards, base, 'engine'))
  || (waitsToMerge(step) && !s.acting && !!s.approved)

// In the queue: working at such a merge step, with its PR open.
export function inMergeQueue(task: Task, plan: PlannedStep[], guards: ResolvedGuards, pr: { baseRefName: string, merged?: boolean } | undefined) {
  const s = task.step
  if (!s?.started || s.done || task.stopped || task.state !== 'working' || !pr || pr.merged) return false
  return mergeGoesOn(plan[s.at], s, guards, pr.baseRefName)
}

// Why a queued PR is out of line, or undefined when it may merge now: GitHub
// reports no conflict, no required update and no other block, its head is the
// task's commit, its checks are green, no merge was refused at that commit and
// the tasks it merges after (mergeAfter) are done; tasks: every task, for those.
export function queueOut(f: Pick<MechFacts, 'task' | 'plan' | 'pr' | 'head' | 'agentBusy'>, tasks: Task[] = []): string | undefined {
  const { task, plan, pr, head } = f
  const s = task.step!
  if (s.agent) return s.agent.kind === 'catch-up' ? 'its agent resolves a conflict with the base' : 'its agent fixes the PR'
  if (s.catchUp) return `updating with ${s.catchUp.base}`
  if (f.agentBusy) return 'its agent is working'
  // Upstream tasks not done: its new commits wait too, since pushing them would merge it (NOT_PUSHED lets the merge step push and merge).
  const waits = mergeWaits(task, tasks)
  if (!pr || !head || pr.headRefOid !== head) return waits.length ? waitText(waits) : NOT_PUSHED
  if (pr.mergeStateStatus === 'DIRTY') return 'conflict with its base'
  if (pr.mergeStateStatus === 'BEHIND') return `updating with ${pr.baseRefName}`
  // Its merge tried at this commit and refused: the user's (Try again, Merge), out of line meanwhile.
  if (s.yourTurn?.reason === 'action' && Object.keys(task.mech ?? {}).some(k => k === `merge:${head}` || k.startsWith(`merge:${head}:`)))
    return `${MERGE_REFUSED}${s.yourTurn.error ?? s.yourTurn.badge}`
  const ready = prReady(pr, head, plan[s.at]?.action?.checks)
  if (!ready.ok) return ready.later ? 'waiting for its checks' : 'checks failed'
  // Ready, but its upstream tasks are not done: out of line, the others merge meanwhile.
  if (waits.length) return waitText(waits)
  // Green, yet GitHub refuses it (a required review, a required check the step does not list).
  return pr.mergeStateStatus === 'BLOCKED' ? 'blocked by the branch rules' : undefined
}

// The tasks it merges after (mergeAfter) not done yet: done is the whole
// workflow finished (merged, its deploy watched when the workflow has one).
// One stopped or abandoned is still waited for; a removed one no longer.
const waitText = (ids: string[]) => `waits for ${ids.join(', ')} to be done`
export const mergeWaits = (task: Pick<Task, 'mergeAfter'>, tasks: Task[]) =>
  mergeAfterIds(task).filter((id) => { const t = tasks.find(x => x.id === id); return !!t && !(t.step?.done && !t.step.abandoned) })

// A task it merges after that was stopped or abandoned: its coordinator is
// woken once for it (key: kept in task.mech), and it keeps waiting, no cascade stop.
export function mergeAfterWake(task: Task, tasks: Task[]): { key: string, why: string } | undefined {
  for (const id of mergeWaits(task, tasks)) {
    const up = tasks.find(t => t.id === id)!
    const what = up.step?.abandoned ? 'abandoned' : up.stopped ? 'stopped' : undefined
    const key = what && `merge-after:${id}:${up.step?.abandoned ? 'abandoned' : up.stopped!.at}`
    if (key && !task.mech?.[key]) return { key, why: `${task.id} (${task.title}) merges after ${id}, which was ${what}: its PR keeps waiting. Start ${id} again, or drop the wait: \`wherdr pm task edit ${task.id} --merge-after "" --reason "<why>"\`.` }
  }
  return undefined
}

// Out of line until its commits are on the PR: the merge step pushes them (mechanic.ts).
export const NOT_PUSHED = 'its new commits are not on the PR yet'

// The start of queueOut's reason for a refused merge: that one stays on Your turn.
export const MERGE_REFUSED = 'merge refused: '

export interface QueueEntry {
  id: string
  files: string[] // the files its PR changes
  size: number // lines added and deleted
  out?: string // why it stepped out of line (queueOut)
  order?: number // its place on the board (task.order, boardOrder.ts)
}

// The queue's order, by id: the PRs in line first, then those that stepped
// out; in each, those the coordinator ordered on the board (task order) in that
// order, then PRs that touch no file another queued PR touches, then smaller diffs.
export function mergeOrder(entries: QueueEntry[]): string[] {
  const shares = (e: QueueEntry) => entries.some(o => o !== e && o.files.some(f => e.files.includes(f)))
  const rank = (e: QueueEntry) => [e.out ? 1 : 0, e.order ?? Number.MAX_SAFE_INTEGER, shares(e) ? 1 : 0, e.size] as const
  return [...entries].sort((a, b) => {
    const x = rank(a), y = rank(b)
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3] || a.id.localeCompare(b.id)
  }).map(e => e.id)
}

// "1st", "2nd", "3rd", "11th"…
export function ordinal(n: number) {
  const teen = n % 100 >= 11 && n % 100 <= 13
  return `${n}${teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
}
