// Starts a task's worker through herdr-core, on its project's machine: a git
// worktree, the instructions file, then a terminal labelled wherdr.* running
// the agent with its model pinned and DISABLE_AUTOUPDATER=1. Nothing is ever
// started twice blindly: the run is saved before the terminal, and a restart
// finds it again by its labels (reconcileRuns).
import { randomBytes, randomUUID } from 'node:crypto'
import { CoreError } from './core'
import { HerdrError } from './herdr'
import { PATH_SETUP, homeOf, kindsOf, launchFailure, machineOn, type CoreAdminDeps } from './coreCreate'
import type { PmStore } from './pmStore'
import { initialState, onEvent, planSteps } from '../../shared/pm/steps'
import { LABEL, agentLine, instructionsText, shotStep, reconcile, runLabels, taskPaths, workerPlan, type LabelledTerminal, type Run, type Task } from '../../shared/pm/run'

// Reuses the worktree of an earlier attempt; else a new branch from the base.
// Records where the branch started (its fork from the base), once: verify
// counts only the commits made on it since.
export const WORKTREE_SCRIPT = `repo=$1 dir=$2 branch=$3 base=$4
[ -e "$dir/.git" ] && exit 0
mkdir -p "$(dirname "$dir")" || exit 1
if git -C "$repo" rev-parse -q --verify "refs/heads/$branch" >/dev/null; then git -C "$repo" worktree add "$dir" "$branch" 2>&1
else git -C "$repo" worktree add -b "$branch" "$dir" \${base:+"$base"} 2>&1 && base=HEAD; fi || exit 1
k="branch.$branch.wherdrstart"
[ -z "$base" ] || git -C "$repo" config "$k" >/dev/null || git -C "$repo" config "$k" "$(git -C "$dir" merge-base HEAD "$base")"`
export const WRITE_SCRIPT = 'mkdir -p "$(dirname "$1")" && cat > "$1"'
const NOT_FOUND = '127' // the shell found no such program: starting again cannot help

export async function exec(deps: Pick<CoreAdminDeps, 'call'>, on: string | undefined, script: string, args: string[], input?: string) {
  const r = await deps.call<{ code: number | null, stdout: string, stderr?: string, timed_out?: boolean }>('machine.exec', {
    argv: ['sh', '-c', script, 'sh', ...args], ...(on ? { on } : {}), timeout: 60,
    ...(input !== undefined ? { input: Buffer.from(input).toString('base64') } : {}),
  }, 70000)
  const text = (b?: string) => Buffer.from(b || '', 'base64').toString('utf8').trim()
  return { code: r.timed_out ? null : r.code, out: text(r.stdout), err: text(r.stderr) }
}

// origin: the address the user reached wherdr at (the start request's).
export interface PmLaunchDeps extends CoreAdminDeps { store: PmStore, origin?: string }

// Where an agent reaches wherdr: on wherdr's own machine, loopback; elsewhere,
// the app's address (APP_URL), else the one the user started the task from.
export function wherdrBase(machine: string, origin = '', appUrl = process.env.APP_URL || '', port = process.env.NITRO_PORT || process.env.PORT || '3000') {
  if (!machine) return `http://127.0.0.1:${port}`
  return (appUrl || origin).replace(/\/+$/, '')
}

const wait = (store: PmStore, task: Task, reason: string) => store.saveTask({ ...task, state: 'waiting', waiting: reason })

// Starts the worker of a task to do (or waiting, to try again). Any reason it
// cannot start puts the task in 'waiting' with that reason, after one attempt.
export async function startTask(deps: PmLaunchDeps, id: unknown): Promise<Task> {
  const { store } = deps
  const task = await store.task(id)
  if (!task) throw new HerdrError('not_found', 'Unknown task')
  if (task.state === 'working') throw new HerdrError('busy', 'This task is already working')
  const p = (await store.projects()).find(x => x.key === task.project)
  if (!p) throw new HerdrError('not_found', 'Unknown project')
  const t = p.template ? await store.template(p.template) : null
  if (!t) return wait(store, task, 'The project has no template: pick one in Settings › Projects')
  const plan = workerPlan(t, task)
  if ('reason' in plan) return wait(store, task, plan.reason)
  let on: string | undefined, label = ''
  try { ({ on, m: { label } } = machineOn(deps, p.machine)) } catch (e) { return wait(store, task, (e as Error).message) }
  if (!(await kindsOf(deps, on)).includes(plan.program)) return wait(store, task, `${plan.program} is not installed on ${label}`)
  const home = await homeOf(deps, on)
  if (!home) return wait(store, task, `${label}: home folder not found`)
  const paths = taskPaths(home, task.id)
  const wt = await exec(deps, on, WORKTREE_SCRIPT, [p.path, paths.worktree, paths.branch, p.base || ''])
  if (wt.code !== 0) return wait(store, task, `git worktree failed: ${wt.out.split('\n').slice(-3).join(' ') || 'timeout'}`)
  // A visual task: the worker's key to upload its screenshots, kept with the task.
  const shotToken = shotStep(t, task.type) ? task.shotToken || randomBytes(16).toString('hex') : undefined
  const text = instructionsText(p, t, task, paths, shotToken ? { base: wherdrBase(p.machine, deps.origin), token: shotToken } : undefined)
  if ((await exec(deps, on, WRITE_SCRIPT, [paths.instructions], text)).code !== 0) return wait(store, task, 'Could not write the instructions file')

  // The engine's start: the task enters its first step (the worker's); the
  // instructions file already tells the worker what to do.
  const step = task.step?.started ? task.step : onEvent(planSteps(t, { type: task.type, ...(task.prefs ? { prefs: task.prefs } : {}) }), initialState(), { kind: 'start' }, Date.now()).state
  const install = await store.install()
  let run: Run = { id: randomUUID().replace(/-/g, '').slice(0, 12), task: task.id, role: 'worker', ...plan, machine: p.machine, ...paths, attempt: 1, state: 'starting', startedAt: Date.now() }
  for (;;) {
    await store.saveRun(run) // the receipt, before the terminal exists
    await store.saveTask({ ...task, state: 'working', waiting: undefined, run: run.id, step, ...(shotToken ? { shotToken } : {}) })
    let address: string
    try {
      address = (await deps.call<{ address: string }>('terminal.run', {
        cwd: paths.worktree, ...(on ? { on } : {}), no_parent: true, wait: false,
        env: { DISABLE_AUTOUPDATER: '1' }, labels: runLabels(install, run),
        line: `${PATH_SETUP}; ${agentLine(plan.program, plan.model, paths.instructions)}`,
      }, 30000)).address
    } catch (e) {
      // Unconfirmed: it may run anyway. The next reconciliation finds it by its labels.
      if (e instanceof CoreError && ['timeout', 'disconnected', 'protocol'].includes(e.kind)) return (await store.task(task.id))!
      await store.saveRun({ ...run, state: 'ended', endedBy: 'exit' })
      return wait(store, task, `herdr-core refused to start ${plan.program}: ${(e as Error).message}`)
    }
    run = { ...run, terminal: address, state: 'running', startedAt: Date.now() }
    await store.saveRun(run)
    const failed = await launchFailure(deps, address, deps.launchWatchMs ?? 5000)
    if (!failed) return (await store.task(task.id))!
    await store.saveRun({ ...run, state: 'ended', endedBy: 'exit' })
    // An agent that exits at once gets one more attempt, never a loop.
    if (run.attempt > 1 || failed.code === NOT_FOUND)
      return wait(store, task, `${plan.program} stopped right after starting (exit code ${failed.code}). Last output:\n${failed.lines || '(none)'}`)
    run = { ...run, id: randomUUID().replace(/-/g, '').slice(0, 12), terminal: undefined, attempt: 2, state: 'starting' }
  }
}

// After a restart: unfinished runs find their terminal by wherdr.run. Found =
// it goes on; ended or gone while wherdr was stopped = the task waits, with why.
export async function reconcileRuns(deps: PmLaunchDeps) {
  const { store } = deps
  if (!(await store.enabled())) return []
  const install = await store.install()
  const { terminals } = await deps.call<{ terminals: LabelledTerminal[] }>('terminal.list', { all: true, labels: { [LABEL.install]: install } }, 8000)
  const found = reconcile(await store.runs(), terminals, install)
  for (const f of found) {
    const task = await store.task(f.run.task)
    if (f.state === 'running') {
      await store.saveRun({ ...f.run, terminal: f.terminal, state: 'running' })
      if (task && task.run === f.run.id && task.state !== 'working') await store.saveTask({ ...task, state: 'working', waiting: undefined })
      continue
    }
    await store.saveRun({ ...f.run, state: 'ended', endedBy: f.state })
    if (task?.run === f.run.id && task.state === 'working')
      await wait(store, task, f.state === 'exit' ? 'The agent ended while wherdr was stopped' : 'The agent\'s terminal is gone (not found after a restart)')
  }
  return found
}
