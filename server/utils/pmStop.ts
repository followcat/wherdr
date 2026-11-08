// Stops a task (its agents end through herdr-core; worktree, branch and work
// stay), takes a stopped one up again, and removes one never started. Never
// merges, never deletes a branch; Archive removes the worktree (pmCleanup.ts).
import { HerdrError } from './herdr'
import { startTask, type PmLaunchDeps } from './pmLaunch'
import { cleanTask } from './pmCleanup'
import { onEvent } from '../../shared/pm/steps'
import { handoverText, removeRefusal, resumeRefusal, stopRefusal, stoppedTask, type Resume, type Stopper } from '../../shared/pm/stop'
import { taskPlan, type Task } from '../../shared/pm/run'

async function load(deps: PmLaunchDeps, id: unknown) {
  const task = await deps.store.task(id)
  if (!task) throw new HerdrError('not_found', 'Unknown task')
  const p = (await deps.store.projects()).find(x => x.key === task.project)
  const t = p ? await deps.store.workflow(p.key) : null
  return { task, plan: t ? taskPlan(t, task, p) : [] }
}

// logBy: the task log's author ('user', 'coordinator KEY').
export async function stopTask(deps: PmLaunchDeps, id: unknown, by: Stopper, why: string, logBy: string): Promise<Task> {
  const { store } = deps
  const { task } = await load(deps, id)
  const refused = stopRefusal(task, by)
  if (refused) throw new HerdrError('refused', refused)
  const reason = why.trim().slice(0, 300) || 'no reason given'
  // Saved first: from now on the engine's passes leave the task alone.
  let saved = await store.logTask(stoppedTask(task, { by: by.who === 'user' ? 'the user' : 'the coordinator', why: reason, at: Date.now() }), logBy, `stopped: ${reason}`)
  for (const r of (await store.runs()).filter(x => x.task === task.id && x.state !== 'ended')) {
    const err = r.terminal ? await deps.call('terminal.kill', { terminal: r.terminal }, 15000).then(() => '', (e: Error) => e.message) : ''
    await store.saveRun({ ...r, state: 'ended', endedBy: 'stopped' })
    saved = await store.logTask(saved, 'engine', err ? `could not end the ${r.role} (${err}): close its terminal by hand` : `ended the ${r.role} (${r.program} ${r.model}); its worktree stays`)
  }
  return saved
}

// A task never started, removed from the board; the project's log keeps who and why.
export async function removeTask(deps: Pick<PmLaunchDeps, 'store'>, id: unknown, by: Stopper, why: string, logBy: string) {
  const { store } = deps
  const task = await store.task(id)
  if (!task) throw new HerdrError('not_found', 'Unknown task')
  const refused = removeRefusal(task, await store.runs(), await store.tasks(), by)
  if (refused) throw new HerdrError('refused', refused)
  await store.removeTask(task, logBy, `removed ${task.id} "${task.title}": ${why.trim().slice(0, 300) || 'no reason given'}`)
  return { removed: task.id }
}

export async function resumeTask(deps: PmLaunchDeps, id: unknown, how: Resume, by: Stopper, logBy: string): Promise<Task> {
  const { store } = deps
  const { task, plan } = await load(deps, id)
  const s = task.step!
  const refused = resumeRefusal(task, how, by, plan[s?.at ?? -1])
  if (refused) throw new HerdrError('refused', refused)
  const going = { ...task, stopped: undefined, waiting: undefined, waitKind: undefined }
  if (how === 'archive') {
    const archived = await store.logTask({ ...going, state: 'working', step: { ...s, done: true, abandoned: true } }, logBy, 'archived; its worktree goes, its branch stays')
    void cleanTask(deps, task.id).catch(() => {})
    return archived
  }
  if (how === 'as-is') {
    const r = onEvent(plan, s, { kind: 'skip' }, Date.now())
    if (r.refused) throw new HerdrError('refused', r.refused)
    const next = r.state.done ? 'done' : `on to ${plan[r.state.at]!.id}`
    return store.logTask({ ...going, state: 'working', step: r.state }, logBy, `${plan[s.at]!.id}: taken as it is, ${next}`)
  }
  // Continue: a new agent for the step, in the same worktree; a worker reads a handover note first.
  const worker = (await store.runs()).filter(r => r.task === task.id && r.role === 'worker').sort((a, b) => b.startedAt - a.startedAt)[0]
  const handover = plan[s.at]?.holder === 'worker' && worker ? handoverText(task, plan, worker.branch) : undefined
  let started = await startTask(deps, task.id, { handover })
  // It could not start: now a failure of its own, no longer the stop.
  if (started.stopped) started = await store.saveTask({ ...started, stopped: undefined })
  return store.logTask(started, logBy, started.state === 'working' ? `${plan[s.at]?.id ?? 'step'}: continued` : `could not continue: ${started.waiting ?? ''}`)
}
