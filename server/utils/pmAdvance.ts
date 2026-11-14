// After an agent's turn, every minute before the mechanical moves: a run's
// "done" label becomes the step engine's event; the worker or reviewer that
// holds the current step gets its text once (the reviewer is started for its
// first round); an engine action the task entered starts (outside the tick); a done task's agents
// stop. All of it is read again from the task's state, so a restart loses
// nothing (shared/pm/advance.ts holds the rules).
import { randomUUID } from 'node:crypto'
import { DONE_CMD, READ_SEP, dueText, parseRead, reviewFile, runFiles, runsNow, signalEvent, signalKept } from '../../shared/pm/advance'
import { onEvent, type PlannedStep } from '../../shared/pm/steps'
import { followedBranch } from '../../shared/pm/branchName'
import { LABEL, agentEnv, agentLine, duplicateAgents, prefOf, programName, quotaOut, reviewerPlan, runLabels, taskPlan, type LabelledTerminal, type Run, type Task } from '../../shared/pm/run'
import { accountOut } from '../../shared/pm/pace'
import { codexError } from '../../shared/codexError'
import { codexLimitReset } from './quotas'
import type { Quotas } from '../../shared/types'
import { reviewAccount, reviewCap, reviewTurn, reviewerOut, runningReviews } from '../../shared/pm/reviewQueue'
import { policyIn, readPolicies } from './pacingPolicies'
import { showIds } from '../../shared/pm/projectKey'
import { PATH_SETUP, launchFailure } from './coreCreate'
import { WRITE_SCRIPT, exec, oneStart, prepareTmp, runOn, type PmLaunchDeps } from './pmLaunch'
import { HerdrError } from './herdr'
import { startAction } from './pmBoard'
import { cleanTask } from './pmCleanup'
import { readLeakCheck } from './pmVisibility'
import { isPublic, leakText, scanDiff } from '../../shared/pm/visibility'
import type { Project } from '../../shared/pm/project'
import { agentBack, retriesAction, wasReleased } from '../../shared/pm/release'
import { reviveWorker } from './pmRelease'
import { readAccounts, recordGone, type CoreList } from './pmIncidents'
import type { Incident } from '../../shared/pm/incident'
import { interruptTask } from './pmRecovery'
import { killTerminal } from './pmProcs'
import { noteTaskError } from './pmSentinel'

// The task's commit, its diff size since the branch started, the worker's note, the verdict file,
// its branch, then its own commits (no merges) and files per line count since its fork from the base ($5).
export const SIGNAL_READ_SCRIPT = `wt=$1 b=$2 base=$5
git -C "$wt" rev-parse -q --verify HEAD; echo "${READ_SEP}"
s=$(git -C "$wt" config "branch.$b.wherdrstart")
git -C "$wt" diff --numstat \${s:+"$s"} HEAD 2>/dev/null | awk '{n+=$1+$2} END {print n+0}'; echo "${READ_SEP}"
cat "$3" 2>/dev/null; echo; echo "${READ_SEP}"
cat "$4" 2>/dev/null; echo; echo "${READ_SEP}"
git -C "$wt" symbolic-ref -q --short HEAD; echo "${READ_SEP}"
m=
[ -n "$base" ] && { m=$(git -C "$wt" merge-base HEAD "origin/$base" 2>/dev/null) || m=$(git -C "$wt" merge-base HEAD "$base" 2>/dev/null); }
[ -n "$m" ] || m=$s
git -C "$wt" log --no-merges --format='%at %s' \${m:+"$m..HEAD"} 2>/dev/null | cksum; echo "${READ_SEP}"
git -C "$wt" diff --numstat \${m:+"$m"} HEAD 2>/dev/null`
// The task moves to the branch its worker pushed: its start point (and takeover tip) goes with it.
const FOLLOW_SCRIPT = `for k in wherdrstart wherdrtaken; do s=$(git -C "$1" config "branch.$2.$k") && git -C "$1" config "branch.$3.$k" "$s"; done; exit 0`

type Ctx = { task: Task, p: Project, on: string | undefined, plan: PlannedStep[], t: NonNullable<Awaited<ReturnType<PmLaunchDeps['store']['template']>>> }

async function context(deps: PmLaunchDeps, id: string): Promise<Ctx | null> {
  const task = await deps.store.task(id)
  const p = task && (await deps.store.projects()).find(x => x.key === task.project)
  const t = p ? await deps.store.workflow(p.key) : null
  if (!task?.step?.started || !p || !t) return null
  // The worker's machine (its reviewer runs there too); no worker yet: the project's.
  const worker = latest(await deps.store.runs(), id, 'worker')
  let on: string | undefined
  try { on = runOn(deps, worker ?? p) } catch { return null }
  return { task, p, on, t, plan: taskPlan(t, task, p) }
}

const latest = (runs: Run[], task: string, role: Run['role']) =>
  runs.filter(r => r.task === task && r.role === role).sort((a, b) => b.startedAt - a.startedAt)[0]
const clearSignal = (deps: PmLaunchDeps, terminal: string) =>
  deps.call('terminal.label', { terminal, labels: { [LABEL.report]: '' } }, 8000).catch(() => {})
// Reviewer accounts a Codex reviewer's screen showed out ("You've hit your usage
// limit"), until the reset its message gives: the quota reading has no numbers
// then (rate_limits primary and secondary null) and cannot tell.
const screenOut = new Map<string, number>()
export const SCREEN_OUT = screenOut

// A Codex screen ending on its usage-limit message: until when the account is out (an hour when it gives no time).
export function codexLimitHit(screen: string, now: number): number | undefined {
  const e = codexError(screen)
  return e && /usage limit/i.test(e) ? codexLimitReset(e, now) ?? now + 3_600_000 : undefined
}

// Why an account is out by what its reviewer's screen said, until its reset.
function outOnScreen(q: Quotas | null, program: string, machine: string, now: number) {
  const until = screenOut.get(reviewAccount(q, program, machine).key)
  return until && until > now ? quotaOut(program, until) : undefined
}

// The live Codex reviewers holding their review whose screen shows the usage limit: their accounts marked out.
async function readLimits(deps: PmLaunchDeps, alive: (r?: Run) => LabelledTerminal | undefined, now: number) {
  const hit = new Set<string>(), tasks = await deps.store.tasks()
  const held = (await deps.store.runs()).filter(r => r.role === 'reviewer' && r.program === 'codex' && alive(r) && tasks.some(t => t.run === r.id && t.step && !t.step.done && t.step.told === t.step.since))
  if (!held.length) return hit
  const q = await readAccounts(deps)
  for (const r of held) {
    const screen = String((await deps.call<{ text?: string }>('terminal.read', { terminal: r.terminal, lines: 40 }, 3000).catch(() => null))?.text || '')
    const until = codexLimitHit(screen, now)
    if (!until) continue
    screenOut.set(reviewAccount(q, r.program, r.machine).key, until)
    hit.add(r.id)
  }
  return hit
}

const waitFor = async (deps: PmLaunchDeps, id: string, reason: string) =>
  deps.store.logTask({ ...(await deps.store.task(id))!, state: 'waiting', waiting: reason, waitKind: undefined }, 'engine', reason)

export async function advanceTick(deps: PmLaunchDeps, now = Date.now()) {
  const { store } = deps
  const list = await deps.call<CoreList>('terminal.list', { all: true, labels: { [LABEL.install]: await store.install() } }, 8000)
  const { terminals } = list
  const alive = (r?: Run) => (r?.terminal && r.state !== 'ended' ? terminals.find(x => x.address === r.terminal && x.state !== 'finished') : undefined)
  await endDuplicates(deps, terminals).catch(() => {})
  // An agent killed, crashed or gone with its machine while wherdr runs: an incident (an agent that exited with 0 ended on its own).
  const gone = (await store.runs()).filter(r => r.terminal && r.state !== 'ended' && !alive(r) && terminals.find(x => x.address === r.terminal)?.exit_code !== 0)
  const why = gone.length ? await recordGone(deps, gone, list, now).catch(() => new Map<string, Incident>()) : new Map<string, Incident>()
  for (const run of await store.runs()) {
    if (alive(run)?.labels?.[LABEL.report] !== 'done') continue
    // Cleared once handled; a failure leaves it for the next tick.
    if (await signal(deps, run, now).then(() => true, () => false)) await clearSignal(deps, run.terminal!)
  }
  const limited = await readLimits(deps, alive, now).catch(() => new Set<string>())
  // One task's error is logged on it, once, and never stops the others' pass.
  for (const task of await store.tasks()) await advance(deps, task.id, alive, why, limited).catch(e => noteTaskError(store, task.id, e))
}

// A run said it is done: the engine's event for the current step.
async function signal(deps: PmLaunchDeps, run: Run, now: number) {
  const c = await context(deps, run.task)
  if (!c || c.task.step!.done) return
  const step = c.plan[c.task.step!.at]
  const files = runFiles(latest(await deps.store.runs(), run.task, 'worker')?.instructions ?? run.instructions)
  const r = await exec(deps, c.on, SIGNAL_READ_SCRIPT, [run.worktree, run.branch, files.note, files.verdict, c.task.base ?? ''])
  const read = parseRead(r.out)
  const ev = signalEvent(step, run.role, read)
  const moved = ev && 'kind' in ev && ev.kind === 'report' ? followedBranch(run.branch, read, c.task.branchStart ?? `task/${c.task.id}`) : undefined
  if (moved) await follow(deps, c, run, moved)
  // The worker reports the work the engine handed it (a catch-up, red CI): the step's Your turn, if any, comes back.
  const work = c.task.step!.agent
  if (!ev && work && run.role === 'worker') {
    const retry = retriesAction(c.plan, c.task.step!)
    await deps.store.logTask({ ...c.task, step: agentBack(c.task.step!) }, 'engine', `${work.kind}: the worker says it is done${retry ? `, ${step!.id} is tried again` : ''}`)
    // A failed action it fixed: tried again now; failing again, it is back in Your turn with the new error.
    if (retry) startAction(deps, run.task, () => {})
    return
  }
  if (!ev) return
  const tell = (text: string) => deps.call('terminal.send', { terminal: run.terminal, text: showIds([c.p], text) }, 30000)
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
  const fresh = await deps.store.task(run.task)
  await deps.store.logTask({ ...fresh!, step: res.state, ...signalKept(fresh!, step!.id, ev, read) }, `${run.role} ${run.program} ${run.model}`, `${step!.id}: ${what}`)
}

// The worker pushed another branch than the task's: the engine pushes, opens
// PRs and checks merges on that one from now on, never on the old one.
async function follow(deps: PmLaunchDeps, c: Ctx, run: Run, branch: string) {
  await exec(deps, c.on, FOLLOW_SCRIPT, [run.worktree, run.branch, branch]).catch(() => {})
  for (const r of (await deps.store.runs()).filter(x => x.task === run.task && x.branch === run.branch)) await deps.store.saveRun({ ...r, branch })
  await deps.store.logTask({ ...(await deps.store.task(run.task))!, branch }, 'engine', `follows branch ${branch}, the worker's (was ${run.branch})`)
  run.branch = branch
}

// Two live agents of one role on a task: the tracked one stays, the others
// end (terminal killed, run ended), each with a line in the task's log.
async function endDuplicates(deps: PmLaunchDeps, terminals: LabelledTerminal[]) {
  const { store } = deps
  const runs = await store.runs()
  for (const d of duplicateAgents(terminals, runs, await store.tasks(), await store.install())) {
    for (const x of d.end) {
      await killTerminal(deps, x.address).catch(() => {})
      x.state = 'finished'
      const r = runs.find(y => y.id === x.labels?.[LABEL.run])
      if (r && r.state !== 'ended') await store.saveRun({ ...r, state: 'ended', endedBy: 'stopped' })
      const task = await store.task(d.task)
      if (task) await store.logTask(task, 'engine', `ended a second ${d.role} (run ${x.labels?.[LABEL.run] ?? '?'}): one ${d.role} per task, run ${d.keep.labels?.[LABEL.run] ?? '?'} goes on`)
    }
  }
}

// The task's current step, carried on: its action run, its holder told, or its agents stopped.
async function advance(deps: PmLaunchDeps, id: string, alive: (r?: Run) => LabelledTerminal | undefined, why = new Map<string, Incident>(), limited = new Set<string>()) {
  const c = await context(deps, id)
  if (!c) return
  const { task, plan } = c, s = task.step!
  const runs = await deps.store.runs()
  if (s.done) {
    for (const r of runs.filter(x => x.task === id && x.state !== 'ended')) {
      if (alive(r)) await killTerminal(deps, r.terminal!).catch(() => {})
      await deps.store.saveRun({ ...r, state: 'ended', endedBy: 'exit' })
    }
    // Its agents ended: its worktree (and, merged, its local branch) goes, once tried.
    if (!task.cleanup) void cleanTask(deps, id).catch(() => {})
    return
  }
  // Stopped on a failure: it waits for the user, nothing is tried again alone.
  if (task.state === 'waiting' && !task.waitKind) return
  // Started, never waited for: one slow action holds no other task (pmBoard.ts startAction).
  if (runsNow(plan[s.at], s)) return void startAction(deps, id)
  const busy = (e: Error) => { if (!(e instanceof HerdrError && e.code === 'busy')) throw e }
  // The review agent hit its account limit during the review (it ended on it, or
  // sits idle on Codex's usage-limit message): with a fallback set, the fallback
  // takes the review over from the start, at once.
  const rv = latest(runs, id, 'reviewer'), main = reviewerPlan(c.t, task)
  const hit = rv && (limited.has(rv.id) || (!alive(rv) && why.get(rv.id)?.cause === 'limit'))
  if (plan[s.at]?.holder === 'reviewer' && s.told === s.since && rv && rv.state !== 'ended' && hit
    && prefOf(c.t, task, 'reviewFallbackAgent') && 'program' in main && main.program === rv.program && main.model === rv.model) {
    if (alive(rv)) await killTerminal(deps, rv.terminal!).catch(() => {})
    await deps.store.saveRun({ ...rv, state: 'ended', endedBy: 'lost' })
    const again = dueText(plan, { ...s, told: undefined })!, q = await readAccounts(deps), now = Date.now()
    const out = outOnScreen(q, rv.program, rv.machine, now) ?? accountOut(q, rv.program, rv.machine, now) ?? `${programName(rv.program)} hit its account limit during the review`
    return oneStart(id, 'reviewer', () => reviewer(deps, c, again.text, false, out)).catch(busy)
  }
  const due = dueText(plan, s)
  if (!due) return
  const told = { ...s, told: s.since }
  if (due.holder === 'reviewer') return oneStart(id, 'reviewer', () => reviewer(deps, c, due.text, alive(rv) && rv)).catch(busy)
  const worker = latest(runs, id, 'worker')
  // Released while the task waited for the user, or ended earlier (on its own, or
  // by a stop the task went on from) with no incident: a step due for it (a
  // send-back, the user's or the engine's) starts it again, the handover gives the step.
  if (!alive(worker) && (wasReleased(worker) || (worker?.state === 'ended' && !task.stopped && task.state !== 'waiting' && !why.has(worker.id))))
    return void await reviveWorker(deps, id, `${plan[s.at]!.id} needs it`)
  if (!alive(worker)) {
    if (task.state === 'waiting') return
    const i = why.get(worker?.id ?? '')
    // Ended with no incident (on its own, or unread after a restart): the watchdog starts it again (pmWatchdog.ts).
    if (!i) return void (worker && worker.state !== 'ended' && await deps.store.saveRun({ ...worker, state: 'ended', endedBy: 'exit' }))
    // An incident: its run ends, the engine resumes the task once the cause is gone (pmRecovery.ts).
    await deps.store.saveRun({ ...worker!, state: 'ended', endedBy: 'lost' })
    return void await interruptTask(deps, task, i)
  }
  await clearSignal(deps, worker!.terminal!)
  // A new note for this step: the last one's link must not pass as this step's proof.
  await exec(deps, c.on, 'rm -f "$1"', [runFiles(worker!.instructions).note])
  await deps.call('terminal.send', { terminal: worker!.terminal, text: showIds([c.p], due.text) }, 30000)
  await deps.store.logTask({ ...task, step: told, run: worker!.id }, 'engine', `${plan[s.at]!.id}: sent to the worker`)
}

// The reviewer's turn: its file written, then the running reviewer told, or a
// new one started in the worker's worktree (another model, pinned).
// out: the review agent is known to be out of quota (it hit its limit during the review).
async function reviewer(deps: PmLaunchDeps, { task, p, t, on }: Ctx, text: string, live: Run | undefined | false, out?: string) {
  const { store } = deps
  const worker = latest(await store.runs(), task.id, 'worker')
  const main = reviewerPlan(t, task), now = Date.now(), q = await readAccounts(deps)
  let handover = !!out
  const fallback = !!prefOf(t, task, 'reviewFallbackAgent'), policies = fallback ? await readPolicies() : {}
  // The review agent's account at its limit, near it, or held by its pace: why, for the fallback.
  const busy = () => worker && 'program' in main ? outOnScreen(q, main.program, worker.machine, now) ?? reviewerOut(q, main.program, worker.machine, k => policyIn(policies, k), now) : undefined
  const isMain = (r: Run) => 'program' in main && r.program === main.program && r.model === main.model
  // A new reviewer or round, a fallback set: the review agent's account read first.
  if (!out && fallback && (!live || isMain(live))) out = busy()
  // The live review agent's account is out: it ends, the fallback takes this round.
  if (out && live && isMain(live)) {
    await killTerminal(deps, live.terminal!).catch(() => {})
    await store.saveRun({ ...live, state: 'ended', endedBy: 'stopped' })
    live = false
    handover = true
  }
  // A live fallback reviewer: once the review agent has room again, it ends and the review agent takes this round.
  if (live && worker && 'program' in main && !isMain(live) && fallback && !busy()) {
    await killTerminal(deps, live.terminal!).catch(() => {})
    await store.saveRun({ ...live, state: 'ended', endedBy: 'stopped' })
    task = await store.logTask(task, 'engine', `review: ${programName(main.program)} has quota again, the fallback reviewer (${live.program} ${live.model}) ends`)
    live = false
  }
  const plan = out ? reviewerPlan(t, task, out) : main
  if (!worker || 'reason' in plan) return void (task.state !== 'waiting' && await waitFor(deps, task.id, worker ? (plan as { reason: string }).reason : 'No worktree: the task never started'))
  // A new review (not a hand-over) waits its turn in its account's queue, oldest first.
  if (!live && !handover) {
    const acc = reviewAccount(q, plan.program, worker.machine), tasks = await store.tasks()
    const running = runningReviews(tasks, await store.runs(), r => reviewAccount(q, r.program, r.machine).key).get(acc.key) ?? 0
    const turn = reviewTurn(task, acc.key, tasks, running, reviewCap(acc.quota, now))
    if ('ahead' in turn) {
      const held = `Review waits: ${turn.ahead} ahead on ${acc.name}`
      if (task.reviewWait !== acc.key) await store.logTask({ ...task, held, reviewWait: acc.key }, 'engine', `review: waits, ${turn.ahead} ahead on ${acc.name}`)
      else if (task.held !== held) await store.saveTask({ ...task, held })
      return
    }
  }
  task = { ...task, held: undefined, reviewWait: undefined }
  const files = runFiles(worker.instructions)
  if ((await exec(deps, on, `rm -f "$2" && ${WRITE_SCRIPT}`, [files.review, files.verdict], showIds([p], reviewFile(task, worker, text, files.verdict, isPublic(p))))).code !== 0)
    return void await waitFor(deps, task.id, 'Could not write the review file')
  const told = { ...task.step!, told: task.step!.since }
  if (live) {
    await clearSignal(deps, live.terminal!)
    await deps.call('terminal.send', { terminal: live.terminal, text: `Review again: read ${files.review} and follow it.` }, 30000)
    return void await store.logTask({ ...task, step: told, run: live.id }, 'engine', 'review: sent to the reviewer')
  }
  const tmpWhy = await prepareTmp(deps, on, worker.worktree)
  if (tmpWhy) return void await waitFor(deps, task.id, `The reviewer was not started: ${tmpWhy}`)
  const { switched, ...who } = plan
  let run: Run = { id: randomUUID().replace(/-/g, '').slice(0, 12), task: task.id, role: 'reviewer', ...who, machine: worker.machine, worktree: worker.worktree, branch: worker.branch, instructions: files.review, attempt: 1, state: 'starting', startedAt: Date.now() }
  // The receipt first: an unconfirmed start is found again by its labels, never started twice.
  await store.saveRun(run)
  const again = wasReleased(latest(await store.runs(), task.id, 'reviewer')) ? ' again in its worktree' : ''
  await store.logTask({ ...task, step: told, run: run.id }, 'engine', switched ? `review: ${switched}, reviewed by ${plan.program} ${plan.model}` : `review: started the reviewer${again} (${plan.program} ${plan.model})`)
  const { address } = await deps.call<{ address: string }>('terminal.run', {
    cwd: worker.worktree, ...(on ? { on } : {}), no_parent: true, wait: false,
    env: { ...agentEnv(worker.worktree), ...await deps.proxyEnv?.(worker.machine) },
    labels: runLabels(await store.install(), run), line: `${PATH_SETUP}; ${agentLine(plan.program, plan.model, files.review)}`,
  }, 30000)
  run = { ...run, terminal: address, state: 'running', startedAt: Date.now() }
  await store.saveRun(run)
  const failed = await launchFailure(deps, address, deps.launchWatchMs ?? 5000)
  if (!failed) return
  await store.saveRun({ ...run, state: 'ended', endedBy: 'exit' })
  await waitFor(deps, task.id, `The reviewer (${plan.program}) stopped right after starting (exit code ${failed.code}). Last output:\n${failed.lines || '(none)'}`)
}

