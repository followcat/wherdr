// Starts a task's worker through herdr-core, on its project's machine: a git
// worktree, the instructions file, then a terminal labelled wherdr.* running
// the agent with its model pinned, DISABLE_AUTOUPDATER=1 and its temp files in
// the worktree (agentEnv). Nothing is ever
// started twice blindly: the run is saved before the terminal, and a restart
// finds it again by its labels (reconcileRuns).
import { Holds } from './pmHold'
import { projectPlace } from '../../shared/pm/places'
import { randomBytes, randomUUID } from 'node:crypto'
import { CoreError } from './core'
import { HerdrError } from './herdr'
import { PATH_SETUP, homeOf, kindsOf, launchFailure, machineOn, type CoreAdminDeps } from './coreCreate'
import type { PmStore } from './pmStore'
import { noteBack } from './pmStall'
import { actAgain, initialState, onEvent } from '../../shared/pm/steps'
import { doneSection, runFiles } from '../../shared/pm/advance'
import { isPublic } from '../../shared/pm/visibility'
import { cloneOn, taskMachine } from '../../shared/pm/project'
import { ensureVisibility, readLeakCheck } from './pmVisibility'
import { prepareWorktree } from './pmDeps'
import { ensureReady } from './pmReady'
import { fileConflict, filesSection, pastAgents } from '../../shared/pm/files'
import { branchFor } from '../../shared/pm/branchName'
import { showIds, shownTaskId } from '../../shared/pm/projectKey'
import { LABEL, TMP_DIR, agentEnv, agentLine, isAuthFailure, instructionsText, shotStep, taskBase, taskPlan, reconcile, runLabels, taskPaths, tmpRefusal, workerPlan, type Run, type Task } from '../../shared/pm/run'
import { isOpen, type Incident, type Recovery } from '../../shared/pm/incident'
import { recordGone, type CoreList } from './pmIncidents'
import { interruptTask } from './pmRecovery'

// Reuses the worktree of an earlier attempt; else a new branch from the base,
// origin's as fetched now when origin has it (a local one may be stale: a
// chained task needs the task merged before it; and with no local one, git
// would check out a new local base branch instead of the task's), not
// tracking it: the agent's git status must not read as being on the base. Records where the
// branch started (its fork from the base), once: verify counts only the
// commits made on it since. $5: where a new branch starts instead (origin/<branch>
// of a task that continues one); a local branch of that name that it is ahead of
// is moved up to it (a stale local copy would not push), one with commits of its
// own is kept. A branch taken over (moved up or kept) starts at its fork from the base, and its tip
// then is recorded (branch.<b>.wherdrtaken): the commits it had ahead are the task's.
export const WORKTREE_SCRIPT = `repo=$1 dir=$2 branch=$3 base=$4
[ -e "$dir/.git" ] && exit 0
mkdir -p "$(dirname "$dir")" || exit 1
from=$base
if [ -n "$base" ] && git -C "$repo" rev-parse -q --verify "refs/remotes/origin/$base" >/dev/null; then
  git -C "$repo" fetch -q origin "$base" 2>/dev/null; from=origin/$base; fi
tgt=$from; [ -z "$5" ] || from=$5
if [ -n "$5" ] && git -C "$repo" merge-base --is-ancestor "refs/heads/$branch" "$5" 2>/dev/null; then
  git -C "$repo" worktree add --no-track -B "$branch" "$dir" "$5" 2>&1 && base=HEAD
elif git -C "$repo" rev-parse -q --verify "refs/heads/$branch" >/dev/null; then git -C "$repo" worktree add "$dir" "$branch" 2>&1
else git -C "$repo" worktree add --no-track -b "$branch" "$dir" \${from:+"$from"} 2>&1 && base=HEAD; fi || exit 1
if [ -n "$5" ] && [ -n "$tgt" ]; then base=$tgt
  git -C "$repo" config "branch.$branch.wherdrtaken" >/dev/null || git -C "$repo" config "branch.$branch.wherdrtaken" "$(git -C "$dir" rev-parse HEAD)"; fi
k="branch.$branch.wherdrstart"
[ -z "$base" ] || git -C "$repo" config "$k" >/dev/null || git -C "$repo" config "$k" "$(git -C "$dir" merge-base HEAD "$base")"`
// The agents' temp folder in the worktree ($2 under $1), ignored through the
// repository's info/exclude (shared by its worktrees); prints the KB free in /tmp.
export const TMP_SCRIPT = `dir=$1 name=$2
mkdir -p "$dir/$name" || exit 1
x=$(git -C "$dir" rev-parse --git-path info/exclude) || exit 1
case $x in /*) ;; *) x=$dir/$x;; esac
if ! grep -qxF "/$name/" "$x" 2>/dev/null; then
  mkdir -p "$(dirname "$x")" || exit 1
  [ -s "$x" ] && [ -n "$(tail -c1 "$x")" ] && echo >> "$x"
  printf '/%s/\\n' "$name" >> "$x" || exit 1
fi
df -Pk /tmp | awk 'NR==2 {print $4}'`
// A branch to continue, fetched now. Exits 2 only when the remote answers and no
// longer has it; any other failure (remote unreachable…) is not that.
export const FETCH_BRANCH_SCRIPT = `git -C "$1" ls-remote -q --exit-code origin "refs/heads/$2" >/dev/null 2>&1; c=$?
[ $c = 2 ] && exit 2; [ $c = 0 ] || { echo "origin unreachable (git ls-remote exit $c)"; exit 1; }
git -C "$1" fetch -q origin "+refs/heads/$2:refs/remotes/origin/$2" 2>&1 || exit 1`
// The task's worker terminal exists (a launch that timed out is not confirmed until
// reconciliation finds it).
export const launched = async (store: PmStore, t: Task) => t.state === 'working' && !!t.run && !!(await store.runs()).find(r => r.id === t.run)?.terminal

export const WRITE_SCRIPT = 'mkdir -p "$(dirname "$1")" && cat > "$1"'
// The same, only when the file is missing: an agent's own file is never overwritten.
// An existing file still reads its input, so the writer never hits a closed pipe.
export const CREATE_SCRIPT = `if [ -e "$1" ]; then cat > /dev/null; else ${WRITE_SCRIPT}; fi`
// Makes the temp folder: why the agent may not start, or undefined.
export async function prepareTmp(deps: Pick<CoreAdminDeps, 'call'>, on: string | undefined, worktree: string) {
  const r = await exec(deps, on, TMP_SCRIPT, [worktree, TMP_DIR])
  const why = r.code !== 0 ? `Could not make the agents' temp folder ${TMP_DIR} in the worktree` : tmpRefusal(r.out)
  if (why) console.warn(`[pm] ${worktree}: ${why}`)
  return why
}
const NOT_FOUND = '127' // the shell found no such program: starting again cannot help

export async function exec(deps: Pick<CoreAdminDeps, 'call'>, on: string | undefined, script: string, args: string[], input?: string, timeout = 60) {
  const r = await deps.call<{ code: number | null, stdout: string, stderr?: string, timed_out?: boolean }>('machine.exec', {
    argv: ['sh', '-c', script, 'sh', ...args], ...(on ? { on } : {}), timeout,
    ...(input !== undefined ? { input: Buffer.from(input).toString('base64') } : {}),
  }, (timeout + 10) * 1000)
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

// The herdr-core target of the machine a run is on (undefined: the wherdr
// host). Everything done for a started task goes there, never to the project's
// machine. Throws when that machine is unknown or unreachable.
export const runOn = (deps: CoreAdminDeps, run: Pick<Run, 'machine'>) => machineOn(deps, run.machine).on

// The task and role of each agent being started now: a second start of the
// same one, from anywhere (user, coordinator, the engine's chain, a held start,
// a revive), is refused while the first runs, never run beside it; a start
// hung past 10 minutes no longer holds it (pmHold.ts).
const starting = new Holds('start of', 10 * 60_000)
export async function oneStart<T>(task: string, role: Run['role'], fn: () => Promise<T>): Promise<T> {
  const release = starting.take(`${task} ${role}`, `the ${role}'s start`)
  if (!release) throw new HerdrError('busy', `The ${role} of ${task} is already starting`)
  try { return await fn() } finally { release() }
}

// A worker run of the task whose terminal still runs: a new one would share its worktree.
async function liveWorker(deps: PmLaunchDeps, id: string) {
  for (const r of (await deps.store.runs()).filter(x => x.task === id && x.role === 'worker' && x.state !== 'ended' && x.terminal)) {
    const st = await deps.call<{ state?: string }>('terminal.get', { terminal: r.terminal }, 3000).catch(() => null)
    if (st && st.state !== 'finished') return r
  }
}

// Tasks that only wait for their merge (past their work and review), from each
// one's plan: their files no longer hold others (shared/pm/files.ts).
export async function mergingOf(store: PmStore): Promise<(t: Task) => boolean> {
  const projects = await store.projects()
  const flows = new Map(await Promise.all(projects.map(async p => [p.key, await store.workflow(p.key).catch(() => null)] as const)))
  return (t) => {
    const flow = flows.get(t.project)
    return !!flow && !!t.step && pastAgents(taskPlan(flow, t, projects.find(p => p.key === t.project)), t.step.at)
  }
}

const wait = (store: PmStore, task: Task, reason: string, waitKind?: Task['waitKind']) => store.saveTask({ ...task, state: 'waiting', waiting: reason, waitKind, held: undefined, sameFiles: undefined, machineWait: undefined })

// Its machine out of reach: herdr-core's inventory, or an answer of herdr-core midway.
const outOfReach = (e: unknown) => (e instanceof HerdrError && (e.code === 'unreachable' || e.code === 'offline')) || (e instanceof CoreError && (e as { kind?: string }).kind === 'unreachable')

// The engine's first start of a task, its machine out of reach (found offline,
// or gone midway): never a failure for the user. An open offline incident on
// that machine takes it (in its tasks, the task recovering: resumeInterrupted
// starts it once the machine is back); else it is to do again, held like a start
// that waits for room (startHeld, startChained start it once a machine that fits is back).
async function machineHold(deps: PmLaunchDeps, task: Task, machine: string, now = Date.now()): Promise<Task> {
  const label = deps.machines().find(m => m.key === machine)?.label ?? machine
  const tasks = await deps.store.tasks()
  const i = (await deps.store.incidents()).filter(x => x.machine === machine && x.cause === 'offline' && isOpen(x, tasks)).at(-1)
  const base = { ...task, waitKind: undefined, sameFiles: undefined, held: undefined, machineWait: undefined }
  if (!i) return deps.store.saveTask({ ...base, state: 'todo', waiting: undefined, held: `Waits for ${label} (unreachable)`, machineWait: machine })
  await deps.store.linkIncident(i.id, task.id)
  const recovery: Recovery = { incident: i.id, cause: 'offline', machine, label, ...(task.run ? { run: task.run } : {}), at: now, n: 1, waits: true }
  return deps.store.saveTask({ ...base, state: 'waiting', waiting: `Waits for ${label} (unreachable, incident ${i.id}): wherdr starts it once it is back`, recovery })
}

// Starts the worker of a task to do (or waiting, to try again). Any reason it
// cannot start puts the task in 'waiting' with that reason, after one attempt.
// handover: a note for a worker that takes up a stopped task (stop.ts). A
// stopped task stays stopped until its agent starts: never seen as a failure meanwhile.
// revive: the worker the engine released (release.ts) starts again in its
// worktree, whatever the task's state and the holder of its current step.
// on: the machine key a new task goes to (one its project allows); a started
// task always goes back to its own (taskMachine).
// anyway: the user's start of a task whose files a started task touches (files.ts);
// any other first start of it stays to do, behind that task (the engine starts it then).
// by: who starts it (the log's 'back to work' line, when that clears a timeout or a stall).
// resume: a Claude worker's conversation taken up again (crash recovery), with
// that first message; failing at once, a new conversation reads the instructions.
type StartOpts = { handover?: string, revive?: true, on?: string, by?: string, anyway?: true, resume?: { session: string, text: string } }
export async function startTask(deps: PmLaunchDeps, id: unknown, opts: StartOpts = {}): Promise<Task> {
  return oneStart(String(id), 'worker', async () => {
    const before = await deps.store.task(id)
    try { return await startOnce(deps, id, opts) } catch (e) {
      // The engine's first start, its machine out of reach: the task as it was before, held for it.
      if (!before || !outOfReach(e) || (opts.by ?? 'engine') !== 'engine' || opts.revive || before.step?.started || before.state === 'working') throw e
      const p = (await deps.store.projects()).find(x => x.key === before.project)
      const placed = p ? taskMachine(before, p, opts.on) : undefined
      if (!placed || 'refused' in placed) throw e
      const now = (await deps.store.task(id)) ?? before
      return machineHold(deps, { ...now, step: before.step, run: before.run, state: before.state }, placed.machine)
    }
  })
}

async function startOnce(deps: PmLaunchDeps, id: unknown, { handover, revive, on: asked, by = 'engine', anyway, resume }: StartOpts): Promise<Task> {
  const { store } = deps
  const asRead = await store.task(id)
  if (!asRead) throw new HerdrError('not_found', 'Unknown task')
  let task = asRead
  if (task.state === 'working' && !revive) throw new HerdrError('busy', 'This task is already working')
  const found = (await store.projects()).find(x => x.key === asRead.project)
  if (!found) throw new HerdrError('not_found', 'Unknown project')
  const placed = taskMachine(task, found, asked)
  if ('refused' in placed) throw new HerdrError('refused', placed.refused)
  const same = task.step?.started || revive || anyway ? undefined : fileConflict(task, await store.tasks(), await mergingOf(store))
  if (same) {
    if (task.state === 'todo' && task.sameFiles === same.task) return task
    return store.logTask({ ...task, state: 'todo', waiting: undefined, waitKind: undefined, sameFiles: same.task }, 'engine', `waits for ${same.task}: same files (${same.files.join(', ')})`)
  }
  if (found.git === false) return wait(store, task, 'The project folder is not a git repository: a task needs git for its own worktree')
  const p = await ensureVisibility(deps, found)
  const t = p ? await store.workflow(p.key) : null
  if (!t) return wait(store, task, `The project has no workflow: start it from a template in ${projectPlace(task.project, 'workflow')}`)
  const plan = workerPlan(t, task)
  if ('reason' in plan) return wait(store, task, plan.reason)
  // Stopped at a step the worker does not hold (the review): no new worker. That
  // step's holder is told again (the reviewer started again) by the next advance
  // pass, and an action step's action runs again.
  const s = task.step
  const steps = s?.started && !s.done ? taskPlan(t, task, p) : undefined
  const held = steps?.[s!.at]
  if (held && held.holder !== 'worker' && !revive) {
    const { told: _told, ...step } = actAgain(steps!, s!, Date.now())
    const saved = await store.saveTask({ ...task, state: 'working', waiting: undefined, waitKind: undefined, stopped: undefined, held: undefined, sameFiles: undefined, machineWait: undefined, step })
    return noteBack(store, saved, taskPlan(t, saved, p), by, `started again by the ${by}`)
  }
  // Only where a worker is launched: a running one would share its worktree.
  const live = await liveWorker(deps, task.id)
  if (live) throw new HerdrError('busy', `This task's worker is still running (${live.program} ${live.model}): stop the task first`)
  const { machine } = placed
  let on: string | undefined, label = ''
  try { ({ on, m: { label } } = machineOn(deps, machine)) } catch (e) {
    if (by === 'engine' && !revive && !asRead.step?.started && outOfReach(e)) throw e // startTask holds it
    return wait(store, task, (e as Error).message)
  }
  if (!(await kindsOf(deps, on)).includes(plan.program)) return wait(store, task, `${plan.program} is not installed on ${label}`)
  const home = await homeOf(deps, on)
  if (!home) return wait(store, task, `${label}: home folder not found`)
  const repo = cloneOn(p, machine, home)
  if (!repo) return wait(store, task, `wherdr knows no clone of the project on ${label}: allow that machine again in the project's settings`)
  // A new task on another machine than home: refused (left as it was) while that machine is not ready.
  if (task.machine === undefined && !task.run && machine !== p.machine) await ensureReady(deps, p, t, task, machine, repo)
  // A task that continues a branch (a v2 task's): at its first start, that branch when the remote still has it, else the base, saying so.
  // Any other fetch failure waits and tries again: the branch may still be there.
  const fetched = !task.branch && !task.run && task.fromBranch ? await exec(deps, on, FETCH_BRANCH_SCRIPT, [repo, task.fromBranch]) : undefined
  if (fetched && fetched.code !== 0 && fetched.code !== 2) return wait(store, task, `Could not fetch branch \`${task.fromBranch}\` to continue: ${fetched.out.split('\n').slice(-2).join(' ') || 'timeout'}`)
  const cont = fetched?.code === 0
  const contLine = fetched?.code === 2 ? `Branch \`${task.fromBranch}\` is no longer on the remote: this task starts from the base branch instead.` : ''
  if (contLine) task = await store.logTask(task, 'engine', contLine)
  // Named at the first start (a task started before has task/<id>): a later title, tag or template change leaves it alone.
  const paths = taskPaths(home, task.id, task.branch || (cont ? task.fromBranch : task.run ? undefined : branchFor(p.branchName, { ...task, id: shownTaskId([p], task.id) })))
  // Recorded at the first start: changing the project's branch later leaves this task alone.
  const base = taskBase(task, p) ?? ''
  const wt = await exec(deps, on, WORKTREE_SCRIPT, [repo, paths.worktree, paths.branch, base, cont ? `origin/${task.fromBranch}` : ''])
  if (wt.code !== 0) return wait(store, task, `git worktree failed: ${wt.out.split('\n').slice(-3).join(' ') || 'timeout'}`)
  // Its worktree is there now: the task stays on this machine.
  if (task.machine !== machine) task = await store.saveTask({ ...task, machine })
  const tmpWhy = await prepareTmp(deps, on, paths.worktree)
  if (tmpWhy) return wait(store, task, tmpWhy)
  // The project's worktree setup (files copied, folders shared, its command); a failed command: the user's turn.
  const setup = await prepareWorktree(deps, on, repo, paths.worktree, t)
  if (setup.log) task = await store.logTask(task, 'engine', setup.log)
  if (setup.failed) return wait(store, task, setup.failed)
  const depsLine = setup.note
  // A visual task: the worker's key to upload its screenshots, kept with the task.
  const shotToken = shotStep(t, task.type) ? task.shotToken || randomBytes(16).toString('hex') : undefined
  const leakCheck = isPublic(p) ? (await readLeakCheck(deps, on, paths).catch(() => ({ check: undefined }))).check : undefined
  const text = showIds([p], instructionsText(p, t, task, paths, shotToken ? { base: wherdrBase(machine, deps.origin), token: shotToken } : undefined, leakCheck)
    + ['', ...filesSection(runFiles(paths.instructions).files, task.files), ...(depsLine ? [depsLine, ''] : []), ...(contLine ? [contLine, ''] : []), ...(handover ? [handover] : []), ...doneSection(runFiles(paths.instructions).note)].join('\n'))
  if ((await exec(deps, on, WRITE_SCRIPT, [paths.instructions], text)).code !== 0) return wait(store, task, 'Could not write the instructions file')

  // The engine's start: the task enters its first step (the worker's); the
  // instructions file already tells the worker what to do.
  // Its first step's text is in the instructions file: told already.
  const first = onEvent(taskPlan(t, task, p), initialState(), { kind: 'start' }, Date.now()).state
  const step = task.step?.started ? task.step : { ...first, told: first.since }
  const install = await store.install()
  // Claude's conversation id, pinned: a later resume takes it up again.
  const taken = plan.program === 'claude' ? resume : undefined
  const session = () => (plan.program === 'claude' ? { session: randomUUID() } : {})
  let run: Run = { id: randomUUID().replace(/-/g, '').slice(0, 12), task: task.id, role: 'worker', ...plan, machine, ...paths, attempt: 1, state: 'starting', startedAt: Date.now(), ...(taken ? { session: taken.session } : session()) }
  for (;;) {
    await store.saveRun(run) // the receipt, before the terminal exists
    await store.saveTask({ ...task, state: 'working', waiting: undefined, waitKind: undefined, stopped: undefined, held: undefined, sameFiles: undefined, machineWait: undefined, run: run.id, step, base, branch: paths.branch, branchStart: task.branchStart ?? paths.branch, ...(shotToken ? { shotToken } : {}) })
    let address: string
    try {
      address = (await deps.call<{ address: string }>('terminal.run', {
        cwd: paths.worktree, ...(on ? { on } : {}), no_parent: true, wait: false,
        env: { ...agentEnv(paths.worktree), ...await deps.proxyEnv?.(p.machine) }, labels: runLabels(install, run),
        line: `${PATH_SETUP}; ${agentLine(plan.program, plan.model, paths.instructions, run.session ? { id: run.session, ...(taken && run.attempt === 1 ? { resume: taken.text } : {}) } : undefined)}`,
      }, 30000)).address
    } catch (e) {
      // Unconfirmed: it may run anyway. The next reconciliation finds it by its labels.
      if (e instanceof CoreError && ['timeout', 'disconnected', 'protocol'].includes(e.kind)) return (await store.task(task.id))!
      await store.saveRun({ ...run, state: 'ended', endedBy: 'exit' })
      if (by === 'engine' && !revive && !asRead.step?.started && outOfReach(e)) throw e // startTask holds it
      return wait(store, task, `herdr-core refused to start ${plan.program}: ${(e as Error).message}`)
    }
    run = { ...run, terminal: address, state: 'running', startedAt: Date.now() }
    await store.saveRun(run)
    const failed = await launchFailure(deps, address, deps.launchWatchMs ?? 5000)
    if (!failed) {
      const now = (await store.task(task.id))!
      return task.step?.started ? noteBack(store, now, taskPlan(t, now, p), by, `started again by the ${by}`) : now
    }
    await store.saveRun({ ...run, state: 'ended', endedBy: 'exit' })
    // An agent that exits at once gets one more attempt, never a loop.
    if (run.attempt > 1 || failed.code === NOT_FOUND)
      return wait(store, task, `${plan.program} stopped right after starting (exit code ${failed.code}). Last output:\n${failed.lines || '(none)'}`, isAuthFailure(failed.lines) ? 'auth' : undefined)
    run = { ...run, id: randomUUID().replace(/-/g, '').slice(0, 12), terminal: undefined, attempt: 2, state: 'starting', ...session() }
  }
}

// After a restart: unfinished runs find their terminal by wherdr.run. Found =
// it goes on; ended or gone while wherdr was stopped = an incident (pmIncidents.ts)
// and the task waits, with its cause.
export async function reconcileRuns(deps: PmLaunchDeps) {
  const { store } = deps
  if (!(await store.enabled())) return []
  const install = await store.install()
  const list = await deps.call<CoreList>('terminal.list', { all: true, labels: { [LABEL.install]: install } }, 8000)
  const found = reconcile(await store.runs(), list.terminals, install)
  // Why each agent is gone, from facts: recorded as incidents, the task waits with it.
  const why = await recordGone(deps, found.filter(f => f.state !== 'running').map(f => f.run), list).catch(() => new Map<string, Incident>())
  for (const f of found) {
    const task = await store.task(f.run.task)
    if (f.state === 'running') {
      await store.saveRun({ ...f.run, terminal: f.terminal, state: 'running' })
      if (task && task.run === f.run.id && task.state !== 'working') await store.saveTask({ ...task, state: 'working', waiting: undefined })
      continue
    }
    await store.saveRun({ ...f.run, state: 'ended', endedBy: f.state })
    if (task?.run !== f.run.id || task.state !== 'working') continue
    // An incident: the engine resumes it once its cause is gone (pmRecovery.ts).
    const i = why.get(f.run.id)
    await (i ? interruptTask(deps, task, i) : wait(store, task, f.state === 'exit' ? 'The agent ended while wherdr was stopped' : 'The agent\'s terminal is gone (not found after a restart)'))
  }
  return found
}
