// Ask the agent to fix it: the user's button on a blocked task (Tasks to review,
// the task sheet's To do). The mechanics of the coordinator's `tell --fix`
// (pmCoordinator.ts): its worker started again if it ended (reviveWorker), else
// told; the step out of Your turn while it works (fixAskedStep), a stall's clock
// started again (noteBack, as tell does). It comes back
// on the agent's question, or with the new reason if the fix fails. The user's
// own action: no limit per step, logged as theirs.
import { HerdrError } from './herdr'
import { reviveWorker } from './pmRelease'
import { load } from './pmStop'
import { noteBack } from './pmStall'
import { stallOf } from '../../shared/pm/blocked'
import type { PmLaunchDeps } from './pmLaunch'
import { tellTarget } from '../../shared/pm/coordinator'
import { fixAskText, fixAskedStep, fixableBlock } from '../../shared/pm/release'
import { showIds } from '../../shared/pm/projectKey'
import type { Task } from '../../shared/pm/run'

export async function askAgentFix(deps: PmLaunchDeps, id: unknown, by = 'user'): Promise<Task> {
  const { store } = deps
  const { task, plan } = await load(deps, id)
  const reason = fixableBlock(task, stallOf(task, plan, Date.now()))
  if (!reason) throw new HerdrError('refused', 'The task waits for nothing its agent can fix')
  if (plan[task.step!.at]?.holder === 'reviewer') throw new HerdrError('refused', 'The review is blocked: restart the review')
  const { run, released } = tellTarget(await store.runs(), task.id, 'worker', 'worker', true, !task.cleanup?.done)
  // The block's reason may name a task: with its project's shown key.
  const projects = await store.projects(), text = fixAskText(reason)
  if (released) {
    let hold: string | undefined
    const started = await reviveWorker(deps, task.id, `a fix the ${by} asked: ${reason}`, showIds(projects, text), (h) => { hold = h })
    if (hold) throw new HerdrError('refused', `The worker cannot start now: ${hold}`)
    if (started?.state !== 'working') throw new HerdrError('refused', `The worker could not start: ${started?.waiting ?? 'unknown reason'}`)
  }
  else if (run?.terminal) await deps.call('terminal.send', { terminal: run.terminal, text: showIds(projects, text) }, 30000)
  else throw new HerdrError('not_found', 'The task has no worker to fix it')
  const fresh = (await store.task(task.id))!
  const live = fresh.state === 'waiting' && !fresh.waitKind ? { state: 'working' as const, waiting: undefined } : {}
  const asked = await store.logTask({ ...fresh, ...live, step: fixAskedStep(plan, fresh.step!, Date.now()) }, by, `asked the agent to fix: ${reason}`)
  return noteBack(store, asked, plan, by, `the ${by} asked the agent to fix it`)
}
