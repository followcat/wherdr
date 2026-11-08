// After an agent's turn, every minute before the mechanical moves: a run's
// "done" label becomes the step engine's event; the worker or reviewer that
// holds the current step gets its text once (the reviewer is started for its
// first round); an engine action the task entered runs; a done task's agents
// stop. All of it is read again from the task's state, so a restart loses
// nothing (shared/pm/advance.ts holds the rules).
import { randomUUID } from 'node:crypto'
import { DONE_CMD, READ_SEP, dueText, parseRead, reviewFile, runFiles, runsNow, signalEvent } from '../../shared/pm/advance'
import { onEvent, type PlannedStep } from '../../shared/pm/steps'
import { LABEL, agentLine, reviewerPlan, runLabels, taskPlan, type LabelledTerminal, type Run, type Task } from '../../shared/pm/run'
import { PATH_SETUP, launchFailure, machineOn } from './coreCreate'
import { WRITE_SCRIPT, exec, type PmLaunchDeps } from './pmLaunch'
import { stepAction } from './pmBoard'
import { cleanTask } from './pmCleanup'
import { readLeakCheck } from './pmVisibility'
import { isPublic, leakText, scanDiff } from '../../shared/pm/visibility'
import type { Project } from '../../shared/pm/project'

// The task's commit, its diff size since the branch started, the worker's note, the verdict file.
export const SIGNAL_READ_SCRIPT = `wt=$1 b=$2
git -C "$wt" rev-parse -q --verify HEAD; echo "${READ_SEP}"
s=$(git -C "$wt" config "branch.$b.wherdrstart")
git -C "$wt" diff --numstat \${s:+"$s"} HEAD 2>/dev/null | awk '{n+=$1+$2} END {print n+0}'; echo "${READ_SEP}"
cat "$3" 2>/dev/null; echo; echo "${READ_SEP}"
cat "$4" 2>/dev/null`

type Ctx = { task: Task, p: Project, on: string | undefined, plan: PlannedStep[], t: NonNullable<Awaited<ReturnType<PmLaunchDeps['store']['template']>>> }

async function context(deps: PmLaunchDeps, id: string): Promise<Ctx | null> {
  const task = await deps.store.task(id)
  const p = task && (await deps.store.projects()).find(x => x.key === task.project)
  const t = p ? await deps.store.workflow(p.key) : null
  if (!task?.step?.started || !p || !t) return null
  let on: string | undefined
  try { on = machineOn(deps, p.machine).on } catch { return null }
  return { task, p, on, t, plan: taskPlan(t, task, p) }
}

const latest = (runs: Run[], task: string, role: Run['role']) =>
  runs.filter(r => r.task === task && r.role === role).sort((a, b) => b.startedAt - a.startedAt)[0]
const clearSignal = (deps: PmLaunchDeps, terminal: string) =>
  deps.call('terminal.label', { terminal, labels: { [LABEL.report]: '' } }, 8000).catch(() => {})
const waitFor = async (deps: PmLaunchDeps, id: string, reason: string) =>
  deps.store.logTask({ ...(await deps.store.task(id))!, state: 'waiting', waiting: reason, waitKind: undefined }, 'engine', reason)

export async function advanceTick(deps: PmLaunchDeps, now = Date.now()) {
  const { store } = deps
  const { terminals } = await deps.call<{ terminals: LabelledTerminal[] }>('terminal.list', { all: true, labels: { [LABEL.install]: await store.install() } }, 8000)
  const alive = (r?: Run) => (r?.terminal && r.state !== 'ended' ? terminals.find(x => x.address === r.terminal && x.state !== 'finished') : undefined)
  for (const run of await store.runs()) {
    if (alive(run)?.labels?.[LABEL.report] !== 'done') continue
    // Cleared once handled; a failure leaves it for the next tick.
    if (await signal(deps, run, now).then(() => true, () => false)) await clearSignal(deps, run.terminal!)
  }
  for (const task of await store.tasks()) await advance(deps, task.id, alive).catch(() => {})
}

// A run said it is done: the engine's event for the current step.
async function signal(deps: PmLaunchDeps, run: Run, now: number) {
  const c = await context(deps, run.task)
  if (!c || c.task.step!.done) return
  const step = c.plan[c.task.step!.at]
  const files = runFiles(latest(await deps.store.runs(), run.task, 'worker')?.instructions ?? run.instructions)
  const r = await exec(deps, c.on, SIGNAL_READ_SCRIPT, [run.worktree, run.branch, files.note, files.verdict])
  const ev = signalEvent(step, run.role, parseRead(r.out))
  if (!ev) return
  const tell = (text: string) => deps.call('terminal.send', { terminal: run.terminal, text }, 30000)
  if ('fix' in ev) return void await tell(ev.fix)
  // A public repository with no leak check of its own: the engine scans the diff first.
  if (run.role === 'worker' && isPublic(c.p)) {
    const own = await readLeakCheck(deps, c.on, run, true)
    const leaks = own.check === undefined ? scanDiff(own.diff) : []
    if (leaks.length) return void await Promise.all([tell(`${leakText(leaks)}\n\nWhen done: ${DONE_CMD}`), deps.store.logTask(c.task, 'engine', `${step!.id}: leak scan, ${leaks.length} finding(s)`)])
  }
  const res = onEvent(c.plan, c.task.step!, ev, now)
  // A proof is missing: the agent is told which, the step stays.
  if (res.refused) return void await Promise.all([tell(`${res.refused}\n\nWhen done: ${DONE_CMD}`), deps.store.logTask(c.task, 'engine', `${step!.id}: ${res.refused}`)])
  const what = ev.kind === 'verdict' ? `verdict, ${ev.findings.length} finding(s)` : 'done'
  await deps.store.logTask({ ...(await deps.store.task(run.task))!, step: res.state }, `${run.role} ${run.program} ${run.model}`, `${step!.id}: ${what}`)
}

// The task's current step, carried on: its action run, its holder told, or its agents stopped.
async function advance(deps: PmLaunchDeps, id: string, alive: (r?: Run) => LabelledTerminal | undefined) {
  const c = await context(deps, id)
  if (!c) return
  const { task, plan } = c, s = task.step!
  const runs = await deps.store.runs()
  if (s.done) {
    for (const r of runs.filter(x => x.task === id && x.state !== 'ended')) {
      if (alive(r)) await deps.call('terminal.kill', { terminal: r.terminal }, 15000).catch(() => {})
      await deps.store.saveRun({ ...r, state: 'ended', endedBy: 'exit' })
    }
    // Its agents ended: its worktree (and, merged, its local branch) goes, once tried.
    if (!task.cleanup) void cleanTask(deps, id).catch(() => {})
    return
  }
  // Stopped on a failure: it waits for the user, nothing is tried again alone.
  if (task.state === 'waiting' && !task.waitKind) return
  if (runsNow(plan[s.at], s)) return void await stepAction(deps, id, 'engine')
  const due = dueText(plan, s)
  if (!due) return
  const told = { ...s, told: s.since }
  if (due.holder === 'reviewer') return reviewer(deps, c, due.text, alive(latest(runs, id, 'reviewer')) && latest(runs, id, 'reviewer'))
  const worker = latest(runs, id, 'worker')
  if (!alive(worker)) return void (task.state !== 'waiting' && await waitFor(deps, id, 'The worker\'s agent is not running: start the task again to go on'))
  await clearSignal(deps, worker!.terminal!)
  // A new note for this step: the last one's link must not pass as this step's proof.
  await exec(deps, c.on, 'rm -f "$1"', [runFiles(worker!.instructions).note])
  await deps.call('terminal.send', { terminal: worker!.terminal, text: due.text }, 30000)
  await deps.store.logTask({ ...task, step: told, run: worker!.id }, 'engine', `${plan[s.at]!.id}: sent to the worker`)
}

// The reviewer's turn: its file written, then the running reviewer told, or a
// new one started in the worker's worktree (another model, pinned).
async function reviewer(deps: PmLaunchDeps, { task, p, t, on }: Ctx, text: string, live: Run | undefined | false) {
  const { store } = deps
  const worker = latest(await store.runs(), task.id, 'worker')
  const plan = reviewerPlan(t, task)
  if (!worker || 'reason' in plan) return void (task.state !== 'waiting' && await waitFor(deps, task.id, worker ? (plan as { reason: string }).reason : 'No worktree: the task never started'))
  const files = runFiles(worker.instructions)
  if ((await exec(deps, on, `rm -f "$2" && ${WRITE_SCRIPT}`, [files.review, files.verdict], reviewFile(task, worker, text, files.verdict, isPublic(p)))).code !== 0)
    return void await waitFor(deps, task.id, 'Could not write the review file')
  const told = { ...task.step!, told: task.step!.since }
  if (live) {
    await clearSignal(deps, live.terminal!)
    await deps.call('terminal.send', { terminal: live.terminal, text: `Review again: read ${files.review} and follow it.` }, 30000)
    return void await store.logTask({ ...task, step: told, run: live.id }, 'engine', 'review: sent to the reviewer')
  }
  let run: Run = { id: randomUUID().replace(/-/g, '').slice(0, 12), task: task.id, role: 'reviewer', ...plan, machine: worker.machine, worktree: worker.worktree, branch: worker.branch, instructions: files.review, attempt: 1, state: 'starting', startedAt: Date.now() }
  // The receipt first: an unconfirmed start is found again by its labels, never started twice.
  await store.saveRun(run)
  await store.logTask({ ...task, step: told, run: run.id }, 'engine', `review: started the reviewer (${plan.program} ${plan.model})`)
  const { address } = await deps.call<{ address: string }>('terminal.run', {
    cwd: worker.worktree, ...(on ? { on } : {}), no_parent: true, wait: false, env: { DISABLE_AUTOUPDATER: '1' },
    labels: runLabels(await store.install(), run), line: `${PATH_SETUP}; ${agentLine(plan.program, plan.model, files.review)}`,
  }, 30000)
  run = { ...run, terminal: address, state: 'running', startedAt: Date.now() }
  await store.saveRun(run)
  const failed = await launchFailure(deps, address, deps.launchWatchMs ?? 5000)
  if (!failed) return
  await store.saveRun({ ...run, state: 'ended', endedBy: 'exit' })
  await waitFor(deps, task.id, `The reviewer (${plan.program}) stopped right after starting (exit code ${failed.code}). Last output:\n${failed.lines || '(none)'}`)
}
