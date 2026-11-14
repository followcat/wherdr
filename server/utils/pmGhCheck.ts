// "Check on GitHub" (the task sheet's button, `wherdr pm task check`): the
// task's PR read now. Merged: the merge step runs its action at once, which
// records a PR already merged on GitHub (pmActions.ts), the mechanic's own
// path (pmMechanic.ts); an archived task ends as merged. Open: why it waits,
// and a merge the engine may do is tried again on its next pass. Closed: said,
// with Archive offered.
import { checkable, mergedArchive, openWhy, PR_VIEW_FIELDS, taskPr, type GhCheck, type PrView } from '../../shared/pm/ghCheck'
import { errorText, prReady, taskGuards } from '../../shared/pm/actions'
import { requiredChecks } from '../../shared/pm/board'
import { mayMerge } from '../../shared/pm/guards'
import { taskPlan, type Task } from '../../shared/pm/run'
import { waitsToMerge } from '../../shared/pm/steps'
import { actionShell } from './pmActions'
import { stepAction } from './pmBoard'
import { runOn } from './pmLaunch'
import type { CoreAdminDeps } from './coreCreate'
import { HerdrError } from './herdr'
import type { PmStore } from './pmStore'

export async function checkOnGithub(deps: CoreAdminDeps & { store: PmStore }, id: unknown, by: string): Promise<{ task: Task, check: GhCheck }> {
  const { store } = deps
  const task = await store.task(id)
  if (!task) throw new HerdrError('not_found', 'Unknown task')
  const p = (await store.projects()).find(x => x.key === task.project)
  const t = p ? await store.workflow(p.key) : null
  if (!p || !t) throw new HerdrError('not_found', 'The project has no template')
  const plan = taskPlan(t, task, p), s = task.step!
  if (!checkable(plan, s)) throw new HerdrError('refused', 'Only a task with a PR, at its merge step or archived, is checked on GitHub')
  const url = taskPr(plan, s)!
  const run = (await store.runs()).filter(x => x.task === task.id && x.role === 'worker').sort((a, b) => b.startedAt - a.startedAt)[0]
  if (!run) throw new HerdrError('refused', 'The task never started')
  const r = await actionShell(deps, runOn(deps, run))(`gh pr view "$1" --json ${PR_VIEW_FIELDS}`, [url])
  let pr: PrView | undefined
  try { pr = JSON.parse(r.out.split('\n').find(l => l.startsWith('{')) ?? '') as PrView } catch {}
  if (r.code !== 0 || !pr) throw new HerdrError('failed', `gh pr view: ${errorText(r).trim().split('\n').pop()?.slice(0, 300) || 'no answer'}`)

  if (pr.state === 'MERGED') {
    if (s.done) {
      const saved = await store.logTask({ ...task, step: mergedArchive(plan, s, url) }, by, `checked on GitHub: ${url} is merged`)
      return { task: saved, check: { outcome: 'merged', url, text: 'Merged on GitHub: the task is done' } }
    }
    await store.logTask(task, by, `checked on GitHub: ${url} is merged`)
    const after = await stepAction(deps, task.id, 'engine')
    const ended = after.step?.done || after.step?.at !== s.at
    return { task: after, check: { outcome: 'merged', url, text: ended ? 'Merged on GitHub: the merge step ended' : after.step?.yourTurn?.badge ?? 'Merged on GitHub' } }
  }
  if (pr.state === 'CLOSED') {
    const saved = await store.logTask(task, by, `checked on GitHub: ${url} was closed without a merge`)
    return { task: saved, check: { outcome: 'closed', url, text: 'The PR was closed without a merge', ...(s.done ? {} : { archive: true as const }) } }
  }
  const guards = taskGuards(t, task.type), step = plan[s.at]
  let text = openWhy(pr, requiredChecks(plan), guards, s.done ? undefined : step)
  let next: Task = task
  // A merge the engine may do (or one the user approved), ready now: its next pass tries it again, even after an attempt it already made.
  const engineMerges = (!step?.guarded && mayMerge(guards, pr.baseRefName, 'engine')) || (waitsToMerge(step) && !!s.approved && !s.catchUp)
  if (!s.done && engineMerges && prReady(pr, pr.headRefOid, step?.action?.checks).ok && task.mech) {
    next = { ...task, mech: Object.fromEntries(Object.entries(task.mech).filter(([k]) => !k.startsWith('merge:'))) }
    text += '. wherdr tries the merge again within a minute'
  }
  return { task: await store.logTask(next, by, `checked on GitHub: ${text}`), check: { outcome: 'open', url, text } }
}
