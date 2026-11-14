// The engine's watchdog, every minute after the other passes: a working task
// whose current step's holder has had no running agent for AGENTLESS_MS is
// started again (the worker in its worktree with a handover; the reviewer by
// the next advance pass). Its machine offline or paused, no room, or the start
// refused: the status line says why; at the second failure the coordinator is
// woken once. The rules are in shared/pm/watchdog.ts.
import { LABEL, taskPlan, type LabelledTerminal, type Run, type Task } from '../../shared/pm/run'
import { MACHINE_OFFLINE, MACHINE_PAUSED } from '../../shared/pm/release'
import { isReadHold } from '../../shared/pm/sentinel'
import { AGENTLESS_WHY, agentNeeded, reviewRestartRefusal, reviewRestarted, watchAgent, watchFailed, type AgentWatch } from '../../shared/pm/watchdog'
import { isPaused, type Project } from '../../shared/pm/project'
import { showIds } from '../../shared/pm/projectKey'
import { reviveWorker } from './pmRelease'
import { HerdrError } from './herdr'
import { killTerminal } from './pmProcs'
import type { PmLaunchDeps } from './pmLaunch'

// Task id → its missing agent's watch. In memory: a restart starts the minutes again.
const watches = new Map<string, AgentWatch>()

const latest = (runs: Run[], task: string, role: Run['role']) =>
  runs.filter(r => r.task === task && r.role === role).sort((a, b) => b.startedAt - a.startedAt)[0]

// The review started again (the user's Restart the review, a coordinator's
// tell --fix, the watchdog): its reviewer ends, killed if still there, and the
// next advance pass starts a new one on the branch's current head.
export async function restartReview(deps: PmLaunchDeps, id: string, by: string, text: string): Promise<Task> {
  const { store } = deps
  const task = await store.task(id), p = task && (await store.projects()).find(x => x.key === task.project)
  const t = p && await store.workflow(p.key).catch(() => null)
  if (!task || !p || !t) throw new HerdrError('not_found', 'Unknown task')
  const plan = taskPlan(t, task, p)
  const why = reviewRestartRefusal(task, plan)
  if (why) throw new HerdrError('refused', why)
  const run = latest(await store.runs(), id, 'reviewer')
  if (run && run.state !== 'ended') {
    if (run.terminal) await killTerminal(deps, run.terminal).catch(() => {})
    await store.saveRun({ ...run, state: 'ended', endedBy: 'stopped' })
  }
  return store.logTask(reviewRestarted((await store.task(id))!, plan, Date.now()), by, text)
}

// Why its machine takes no agent now: offline, or paused for the project.
function machineWait(deps: PmLaunchDeps, p: Project, machine: string) {
  const m = deps.machines().find(x => x.key === machine)
  if (!m || (!m.local && m.status !== 'online')) return MACHINE_OFFLINE
  return isPaused(p, machine) ? MACHINE_PAUSED : undefined
}

// wake: the task's coordinators woken with why; returns who was (pmWakes's wakeCoordinators).
export async function watchAgents(deps: PmLaunchDeps, wake: (task: Task, why: string) => Promise<string[]>, now = Date.now()) {
  const { store } = deps
  const { terminals } = await deps.call<{ terminals: LabelledTerminal[] }>('terminal.list', { all: true, labels: { [LABEL.install]: await store.install() } }, 8000)
  const runs = await store.runs(), projects = await store.projects(), restarted: string[] = []
  for (const task of await store.tasks()) {
    const p = projects.find(x => x.key === task.project)
    const t = p ? await store.workflow(p.key).catch(() => null) : null
    const role = p && t ? agentNeeded(task, taskPlan(t, task, p)) : undefined
    const run = role && latest(runs, task.id, role)
    // A run still starting has no terminal yet: there.
    const there = !!run && run.state !== 'ended' && (!run.terminal || terminals.some(x => x.address === run.terminal && x.state !== 'finished'))
    const worker = latest(runs, task.id, 'worker')
    const { watch, due } = watchAgent(watches.get(task.id), !!role && !there && !!worker, now)
    if (!watch) {
      watches.delete(task.id)
      // Its agent is back (or not needed): the watchdog's status goes.
      // A hold the mechanic set (it cannot follow the task) is the mechanic's to clear.
      if (task.held && task.state === 'working' && !task.reviewWait && !isReadHold(task.held)) await store.saveTask({ ...task, held: undefined })
      continue
    }
    watches.set(task.id, watch)
    if (!due) continue
    const fail = async (why: string, counts = true) => {
      const r = counts ? watchFailed(watch, now) : { watch: { ...watch, since: now }, wake: false }
      watches.set(task.id, r.watch)
      const fresh = (await store.task(task.id))!
      const woke = r.wake ? await wake(fresh, showIds(projects, `${task.id} (${task.title}): its ${role} is not running and could not be started again twice: ${why}. \`wherdr pm resume ${task.id}\` starts it once that is fixed.`)) : []
      const said = woke.length ? ` Woke ${woke.join(' and ')}.` : ''
      if (fresh.state === 'working' && (fresh.held !== why || said)) await store.logTask({ ...fresh, held: why }, 'engine', `its ${role} is not running: ${why}.${said}`)
    }
    const machineWhy = machineWait(deps, p!, (run || worker)!.machine)
    if (machineWhy) { await fail(machineWhy); continue }
    if (role === 'reviewer') {
      await restartReview(deps, task.id, 'engine', 'its reviewer was not running: started again')
      watches.set(task.id, { ...watch, since: now })
      restarted.push(task.id)
      continue
    }
    if (run && run.state !== 'ended') await store.saveRun({ ...run, state: 'ended', endedBy: 'exit' })
    let hold: string | undefined
    const started = await reviveWorker(deps, task.id, 'its agent was not running', undefined, (h) => { hold = h }, AGENTLESS_WHY)
      .then(x => x ?? null, (e: Error) => (e instanceof HerdrError && e.code === 'busy' ? undefined : e))
    // Started another way meanwhile: looked at again on the next pass.
    if (started === undefined) continue
    // No room on its machine: a wait, not a failure.
    if (hold) { await fail(hold, false); continue }
    if (started instanceof Error) { await fail(started.message); continue }
    if (started?.state === 'working') { watches.set(task.id, { ...watch, since: now }); restarted.push(task.id); continue }
    // Refused: the task waits with why (its status), the user's or the coordinator's.
    await fail(started?.waiting?.split('\n')[0] || 'the start was refused')
  }
  return restarted
}
