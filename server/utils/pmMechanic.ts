// The engine's mechanical moves, every minute (server/plugins/pm.ts): for each
// working or waiting task, the facts (its PR and checks, its agent busy or not,
// a login back), then at most one move (shared/pm/mechanic.ts). A move is
// noted on the task before it runs, so it is never made twice. A move that
// tries to fix a block counts (shared/pm/selfFix.ts): past its tries, or with
// nothing left to try, the coordinator is woken once, with what was tried.
import { CODE, SCRIPT, errorText, guardAction, readPrInfo, taskGuards, type PrInfo } from '../../shared/pm/actions'
import { CATCH_UP_TRIES, catchUpGaveUp, ciOf, infraLog, nextMove, redCiText, type MechFacts, type Move } from '../../shared/pm/mechanic'
import { FIX_MOVE, blockOf, escalation, fixOf, mayTry, noteFix } from '../../shared/pm/selfFix'
import { addSkip, wakesFor } from '../../shared/pm/wakes'
import { MAIN } from '../../shared/pm/coordinator'
import { inMergeQueue, mergeAfterWake, mergeOrder, ordinal, queueOut } from '../../shared/pm/mergeQueue'
import { awaitsHolder } from '../../shared/pm/blocked'
import { caughtUpSettled, onEvent, reviewedCommit, waitsToMerge, type PlannedStep, type StepEvent } from '../../shared/pm/steps'
import { LABEL, linkedPr, prLink, taskPlan, trustKeys, waitOf, type LabelledTerminal, type Run, type Task } from '../../shared/pm/run'
import { PATH_SETUP } from './coreCreate'
import { HerdrError } from './herdr'
import { CoreError } from './core'
import { actionShell, takeUpdate } from './pmActions'
import { actionRunning, prSeen, startAction } from './pmBoard'
import type { PmStore } from './pmStore'
import { prNow, requiredChecks } from '../../shared/pm/board'
import { exec, runOn, startTask, type PmLaunchDeps, launched } from './pmLaunch'
import { busyNext, busyQueue, coordinatorStartRefusal, AUTOPILOT_STARTED, UNCONFIRMED } from '../../shared/pm/autopilot'
import { originOf, pacedStart, paceRefusal } from '../../shared/pm/pace'
import { paceOf, pilotOf, placeFor, slotsOf } from './pmPlace'
import { coordinatorKey } from '../../shared/pm/workspace'
import { CHAIN_WAIT, chainState } from '../../shared/pm/advance'
import { isResumeWait, resumeWait } from '../../shared/pm/recovery'
import { resumeInterrupted, wakeIncidents } from './pmRecovery'
import { advanceTick } from './pmAdvance'
import { forgetMemory } from './pmMemory'
import { samplePeaks } from './pmPeaks'
import { releaseIdle, reviveWorker } from './pmRelease'
import { watchAgents } from './pmWatchdog'
import { startFileWaits, syncFiles } from './pmFiles'
import { agentBack, agentWaits, fixWatch, handToAgent, handedWatch, MACHINE_OFFLINE, MACHINE_PAUSED, retriesAction, roomWakeDue, type WorkerNow } from '../../shared/pm/release'
import { isRoomHold } from '../../shared/pm/placement'
import { isPaused, type Project } from '../../shared/pm/project'
import { noteBack, noteStall } from './pmStall'
import { askedQuestion } from './pmRead'
import { showIds, shownTaskId } from '../../shared/pm/projectKey'
import { killTerminal } from './pmProcs'
import { wakeCoordinators } from './pmWakes'
import { noteCannotFollow, noteTaskError, sentinelTick } from './pmSentinel'

export const LOGIN_SCRIPT = `export DISABLE_AUTOUPDATER=1; case $1 in claude) claude auth status;; codex) codex login status;; *) exit 2;; esac >/dev/null 2>&1`

const lastLine = (out: string) => out.trim().split('\n').pop()?.trim().slice(0, 300) || ''

const WAITS = { question: 'The agent asks a question', permission: 'The agent asks for a permission', auth: 'The agent is not logged in' } as const

// What each running agent waits for, from its terminal (wherdr.report label or
// a permission prompt): its task waits with that kind, and works again once it is gone.
const trusted = new Set<string>() // runs whose trust dialog the engine answered
export async function syncWaits(deps: PmLaunchDeps) {
  const { store } = deps
  const install = await store.install()
  const { terminals } = await deps.call<{ terminals: (LabelledTerminal & { status?: { state?: string, msg?: string } })[] }>('terminal.list', { all: true, labels: { [LABEL.install]: install } }, 8000)
  const runs = await store.runs()
  // A new agent stopped on the folder trust dialog of its own worktree (no status yet): "Yes".
  for (const run of runs.filter(r => r.terminal && r.state !== 'ended' && Date.now() - r.startedAt < 10 * 60_000)) {
    const term = terminals.find(x => x.address === run.terminal)
    if (!term || term.state === 'finished' || term.status?.state || trusted.has(run.id)) continue
    const screen = String((await deps.call<{ text?: string }>('terminal.read', { terminal: run.terminal, lines: 30 }, 3000).catch(() => null))?.text || '')
    const keys = trustKeys(screen, run.worktree)
    if (!keys) continue
    trusted.add(run.id)
    await deps.call('terminal.keys', { terminal: run.terminal, keys }, 10000).catch(() => {})
    const task = await store.task(run.task)
    if (task) await store.logTask(task, 'engine', `trusted the task's worktree for the ${run.role} (${run.worktree})`)
  }
  for (const task of await store.tasks()) {
    const run = runs.find(r => r.id === task.run)
    const term = run?.terminal && run.state !== 'ended' ? terminals.find(x => x.address === run.terminal) : undefined
    if (!term || term.state === 'finished') continue
    const kind = waitOf(term)
    // What herdr-core says is asked ("approve Bash: npm test"), else the kind.
    const msg = typeof term.status === 'object' ? term.status?.msg?.trim().slice(0, 300) : undefined
    // A question carries its text, for the board and the coordinator's wake.
    // A question waiting from before its whole message was kept: read once more.
    const asked = kind === 'question' && (task.state === 'working' || (task.waitKind === 'question' && !task.question)) ? await askedQuestion(deps, run!.terminal!) : undefined
    if (task.state === 'waiting' && task.waitKind === 'question' && kind === 'question' && asked && !task.question) { await store.saveTask({ ...task, question: asked.full }); continue }
    if (task.state === 'working' && kind) await store.saveTask({ ...task, state: 'waiting', waiting: (kind === 'permission' && msg) || (asked ? `${WAITS.question}: ${asked.line}` : WAITS[kind]), waitKind: kind, question: asked?.full })
    else if (task.state === 'waiting' && (task.waitKind === 'question' || task.waitKind === 'permission') && !kind)
      await store.saveTask({ ...task, state: 'working', waiting: undefined, waitKind: undefined, answered: undefined, question: undefined })
    // The answered question gone from its agent: the next one wakes the coordinator again.
    else if (task.answered && task.state === 'working' && !kind) await store.saveTask({ ...task, answered: undefined })
  }
}

// A task with "after" starts once those tasks are done, within its
// coordinator's autopilot limits and hours (one per tick and project): the
// order is the user's. One of them failed or stopped: it waits for the user, with why.
// Started another way meanwhile (the user, the coordinator): the engine's own start is dropped, not logged as a failure.
const startedElsewhere = (e: Error) => e instanceof HerdrError && e.code === 'busy'

export async function startChained(deps: PmLaunchDeps, now = Date.now()) {
  const { store } = deps
  const tasks = await store.tasks(), started: string[] = []
  for (const t of tasks.filter(x => x.after && !x.step?.started)) {
    const c = chainState(t, tasks)
    const held = c && c !== 'go' && 'wait' in c ? c.wait : undefined
    // One before it is resumed by the engine after an incident: it waits quietly, still to do.
    const quiet = c && c !== 'go' && 'resumes' in c ? resumeWait(c.resumes) : undefined
    if (t.state === 'todo' && held) await store.logTask({ ...t, state: 'waiting', waiting: held }, 'engine', held)
    // Held by its chain, and the task before it goes on again: to do, the engine starts it once that one is done.
    else if (t.state === 'waiting' && !held && t.waiting?.includes(CHAIN_WAIT)) await store.logTask({ ...t, state: 'todo', waiting: undefined, held: quiet }, 'engine', 'to do again: the tasks before it go on')
    else if (t.state === 'todo' && quiet && t.held !== quiet) await store.logTask({ ...t, held: quiet }, 'engine', quiet)
    else if (t.state === 'todo' && !quiet && isResumeWait(t.held)) await store.saveTask({ ...t, held: undefined })
  }
  const machines = new Set<string>() // one start per machine and tick: the next reading counts the new agent
  const projects = await store.projects()
  for (const p of projects) {
    // A member's: its workspace's autopilot, whose limits count all its projects' tasks.
    // Runs read again: a member started above counts in its workspace's limits.
    const { ap, all, holds } = await pilotOf(store, projects, p.key), runs = await store.runs()
    const mine = all.filter(t => t.project === p.key)
    // A chain the coordinator or an automation made is automatic work: held by the pace.
    let next: typeof mine[number] | undefined, pace: Awaited<ReturnType<typeof paceOf>> | undefined
    for (const t of mine.filter(x => x.after && x.state === 'todo' && !x.sameFiles)) {
      pace = pacedStart(t, 'engine') ? await paceOf(store, p, t, now) : undefined
      if (!coordinatorStartRefusal(ap, t, all, runs, now, false, { pace: pace?.verdict, engine: true, holds })) { next = t; break }
    }
    if (!next) continue
    // No room on any allowed machine: held, with why on its card, until a later tick finds room.
    const placed = await placeFor(deps, next, { waits: pace?.waits })
    if ('hold' in placed) { if (next.held !== placed.hold) await store.logTask({ ...next, held: placed.hold }, 'engine', placed.hold); continue }
    if (machines.has(placed.machine)) continue
    machines.add(placed.machine)
    forgetMemory(placed.machine)
    const r = await startTask(deps, next.id, { on: placed.machine }).catch((e: Error) => startedElsewhere(e) ? null : ({ ...next, state: 'waiting' as const, waiting: e.message }))
    if (!r) continue
    if (!r.sameFiles) await store.logTask((await store.task(next.id))!, 'engine', r.state === 'working' ? `started: ${next.after} done` : `could not start after ${next.after}: ${r.waiting ?? r.held ?? ''}`)
    started.push(next.id)
  }
  return started
}

// Tasks a wake or an automation would have started, held for room: each
// starts once a machine the project allows has room, one per machine and tick
// (the next reading counts the new agent). Chained ones are startChained's. A wake's task
// still holds to its autopilot (on, limits, hours, pace), an automation's to
// the pace: over a limit it waits, with why; the autopilot off drops the hold.
export async function startHeld(deps: PmLaunchDeps, now = Date.now()) {
  const { store } = deps
  const projects = await store.projects(), started: string[] = [], machines = new Set<string>()
  for (const t of (await store.tasks()).filter(x => x.held && x.state === 'todo' && !x.after && !x.sameFiles)) {
    const p = projects.find(x => x.key === t.project), runs = await store.runs() // a start above counts in the limits
    if (!p) continue
    const pace = pacedStart(t, 'wake') ? await paceOf(store, p, t, now) : undefined
    // An engine start its machine was out of reach for: already decided, it only waits for a machine.
    const why = t.machineWait ? undefined : originOf(t) === 'automation' ? paceRefusal(pace?.verdict)
      : await pilotOf(store, projects, p.key).then(o => coordinatorStartRefusal(o.ap, t, o.all, runs, now, true, { pace: pace?.verdict, holds: o.holds }))
    if (why && /autopilot on/.test(why)) { await store.logTask({ ...t, held: undefined }, 'engine', `no longer held: ${why}`); continue }
    const placed = why ? { hold: `Waits: ${why}` } : await placeFor(deps, t, { waits: pace?.waits })
    if ('hold' in placed) { if (placed.hold !== t.held) await store.saveTask({ ...t, held: placed.hold }); continue }
    if (machines.has(placed.machine)) continue
    machines.add(placed.machine)
    forgetMemory(placed.machine)
    const r = await startTask(deps, t.id, { on: placed.machine }).catch((e: Error) => startedElsewhere(e) ? null : ({ ...t, state: 'waiting' as const, waiting: e.message }))
    if (!r) continue
    if (!r.sameFiles) await store.logTask((await store.task(t.id))!, 'engine', r.state === 'working' ? (t.machineWait ? 'started: a machine is back' : t.autopilot && !(await launched(store, r)) ? UNCONFIRMED : AUTOPILOT_STARTED.room) : `could not start: ${r.waiting ?? r.held ?? ''}`)
    started.push(t.id)
  }
  return started
}

// The worker fixing a failed step action (release.ts fixWatch): its quiet
// time kept; stopped or ended without its report, the step is the user's again.
async function noteFixWork(deps: PmLaunchDeps, task: Task, plan: PlannedStep[], run: Run, now: number): Promise<Task> {
  if (!task.step || !retriesAction(plan, task.step)) return task
  let status: Parameters<typeof fixWatch>[2] = 'gone'
  if (run.terminal && run.state !== 'ended') {
    const st = await deps.call<{ status?: string | { state?: string } }>('terminal.get', { terminal: run.terminal }, 3000).catch(() => null)
    const s = typeof st?.status === 'string' ? st.status : st?.status?.state
    status = !st ? undefined : s === 'idle' || s === 'done' ? 'idle' : 'working'
  }
  const step = fixWatch(plan, task.step, status, now)
  if (!step) return task
  return step.yourTurn ? deps.store.logTask({ ...task, step }, 'engine', step.yourTurn.badge) : deps.store.saveTask({ ...task, step })
}

// The task's worker as this pass sees it; undefined: unknown (unread, still
// starting, the task stopped by the user). Ended on a machine paused for its project:
// 'paused'. Stopped, then the task started again (its step held by no agent): gone.
async function workerNow(deps: PmLaunchDeps, run: Run): Promise<WorkerNow | undefined> {
  const task = await deps.store.task(run.task)
  const gone = async () => {
    const p = (await deps.store.projects()).find(x => x.key === task?.project)
    return p && isPaused(p, run.machine) ? 'paused' as const : 'gone' as const
  }
  if (run.state === 'ended') return run.endedBy === 'stopped' && (!task || task.stopped) ? undefined : gone()
  const m = deps.machines().find(x => x.key === run.machine)
  if (m && !m.local && m.status !== 'online') return 'offline'
  if (!run.terminal) return
  const st = await deps.call<{ state?: string }>('terminal.get', { terminal: run.terminal }, 3000)
    .catch((e: unknown) => (e instanceof CoreError && e.kind === 'not_found' ? { state: 'finished' } : null))
  return !st ? undefined : st.state === 'finished' ? gone() : 'alive'
}

// Work the engine handed the worker (handedWatch): its worker ended, started
// again with it; it cannot be, the step says why it waits and the
// coordinator is woken once (none: it is the user's).
async function noteHandedWork(deps: PmLaunchDeps, task: Task, plan: PlannedStep[], run: Run, now: number): Promise<Task> {
  const s = task.step
  if (!s?.agent || task.state !== 'working' || s.done) return task
  const todo = handedWatch(plan, s, await workerNow(deps, run))
  if (!todo) return task
  if ('back' in todo) return deps.store.logTask({ ...task, step: agentWaits(s, undefined) }, 'engine', `${s.agent.kind}: the worker is back on it`)
  if ('waits' in todo) return handedWaits(deps, task, todo.waits, now)
  if (run.state !== 'ended') await deps.store.saveRun({ ...run, state: 'ended', endedBy: 'exit' })
  let hold: string | undefined
  await reviveWorker(deps, task.id, `${s.agent.kind}: its agent ended`, s.agent.text, h => { hold = h })
  const fresh = (await deps.store.task(task.id))!
  if (hold) return handedWaits(deps, fresh, hold, now)
  if (!fresh.step?.agent) return fresh
  // Started (or not: the task waits with why): never started again for this work.
  const step = agentWaits(fresh.step, undefined)
  return deps.store.saveTask({ ...fresh, step: { ...step, agent: { ...step.agent!, revived: now } } })
}

// The user's Start the worker on a merge that waits on it (board.ts mergeStuck):
// the worker, started again in its worktree when it ended, gets the work the
// engine handed it, else the conflict or the red checks. The merge goes on once it is in.
export async function startWorkerFor(deps: PmLaunchDeps, id: string, by = 'user'): Promise<Task> {
  const { store } = deps
  const task = await store.task(id), s = task?.step
  const run = (await store.runs()).filter(r => r.task === id && r.role === 'worker').sort((a, b) => b.startedAt - a.startedAt)[0]
  if (!s?.started || s.done || !run) throw new HerdrError('not_found', 'The task has no merge waiting on its worker')
  const base = s.catchUp?.base
  const text = s.agent?.text ?? (base
    ? `The PR conflicts with ${base}. Merge origin/${base} into your branch, resolve the conflicts, commit, then stop: the engine pushes it.`
    : redCiText(['the PR'], task!.ci?.head ?? 'HEAD'))
  const kind = s.agent?.kind ?? (base ? 'catch-up' : 'ci-to-agent')
  if (await workerNow(deps, run) === 'alive') await deps.call('terminal.send', { terminal: run.terminal, text: showIds(await store.projects(), text) }, 30000)
  else {
    if (run.state !== 'ended') await store.saveRun({ ...run, state: 'ended', endedBy: 'exit' })
    let hold: string | undefined
    const started = await reviveWorker(deps, id, `${kind}: the ${by} started it`, text, h => { hold = h })
    if (hold) throw new HerdrError('refused', `The worker cannot start now: ${hold}`)
    if (started?.state !== 'working') throw new HerdrError('refused', `The worker could not start: ${started?.waiting ?? 'unknown reason'}`)
  }
  const fresh = (await store.task(id))!
  const step = handToAgent(fresh.step!, kind, s.agent?.head ?? s.catchUp?.from ?? task!.ci?.head, Date.now(), text)
  return store.logTask({ ...fresh, step: { ...step, agent: { ...step.agent!, revived: Date.now() } } }, by, `${kind}: the ${by} started the worker with it`)
}

// The task's machine offline, or paused for its project: why it waits; undefined: up.
async function machineDown(deps: PmLaunchDeps, task: Task, run: Run) {
  const m = deps.machines().find(x => x.key === run.machine)
  if (m && !m.local && m.status !== 'online') return MACHINE_OFFLINE
  const p = (await deps.store.projects()).find(x => x.key === task.project)
  return p && isPaused(p, run.machine) ? MACHINE_PAUSED : undefined
}

// A wake the engine does not send: noted for each coordinator it would have woken (autopilot show); how many.
async function skipWake(deps: PmLaunchDeps, task: Task, why: string, now: number) {
  const { store } = deps
  const own = coordinatorKey(task.project, await store.projects()) // a member's: its workspace's
  const coords = new Map([[own, await store.coordinator(own)], [MAIN, await store.coordinator(MAIN)]])
  const keys = wakesFor([own, MAIN], k => coords.get(k) ?? undefined, now)
  for (const key of keys) {
    const c = coords.get(key)!, skips = addSkip(c.skips, { at: now, what: 'engine', why })
    if (skips) await store.saveCoordinator({ ...c, skips })
  }
  return keys.length
}

// The handed work waits for `why`: said on the step, the coordinator woken once (none: the user's).
// Waiting only for its machine (offline, paused): no wake; the engine starts the
// worker again with it once the machine is back, and wakes only if that fails
// (no coordinator to wake: the user's, as before). Waiting for room: no wake
// either, until it has lasted 30 minutes (roomWakeDue), then once.
async function handedWaits(deps: PmLaunchDeps, task: Task, why: string, now: number): Promise<Task> {
  const work = task.step!.agent!
  const room = isRoomHold(why)
  if (work.waits === why && !(room && roomWakeDue(work, now))) return task
  if (why === MACHINE_OFFLINE || why === MACHINE_PAUSED) {
    const n = await skipWake(deps, task, showIds(await deps.store.projects(), `${task.id} (${task.title}): ${work.kind} handed to its worker, which ${why.toLowerCase()}.`), now)
    return deps.store.logTask({ ...task, step: agentWaits(task.step!, why, work.told ?? (n ? undefined : 'user'), now) }, 'engine', `${work.kind}: ${why}.${n ? ' No wake: the engine goes on once the machine is back.' : ' In Your turn.'}`)
  }
  const step = agentWaits(task.step!, why, work.told, now)
  if (room && !roomWakeDue(step.agent!, now)) {
    // Its numbers changed (free memory): saved, not logged again.
    return work.waits && isRoomHold(work.waits) ? deps.store.saveTask({ ...task, step })
      : deps.store.logTask({ ...task, step }, 'engine', `${work.kind}: ${why}. The coordinator is woken if that lasts 30 minutes.`)
  }
  const cannot = room ? 'which has waited 30 minutes for room on its machine' : 'which cannot do it'
  const told = work.told ?? ((await wakeCoordinators(deps, task, showIds(await deps.store.projects(), `${task.id} (${task.title}): ${work.kind} was handed to its worker, ${cannot}: ${why}. \`wherdr pm tell ${task.id} "<what to do>" --fix ${work.kind === 'catch-up' ? 'base' : 'ci'} --reason "<why>"\` starts it again with it.`), now)).length ? 'coordinator' : 'user')
  const woke = work.told ? '' : told === 'coordinator' ? ' Woke its coordinator.' : ' In Your turn.'
  return deps.store.logTask({ ...task, step: agentWaits(task.step!, why, told, now) }, 'engine', `${work.kind}: ${why}.${woke}`)
}

// Keep the board busy (shared/pm/autopilot.ts busyNext): each project's next
// to-do task starts by itself while a machine it allows has room, within its
// autopilot's limits, hours and pace; no coordinator wake for it. One per
// project, one per machine and tick. Started another way meanwhile: dropped.
// A workspace's: one autopilot for it and its members, their tasks in board order.
export async function startNext(deps: PmLaunchDeps, now = Date.now()) {
  const { store } = deps
  const runs = await store.runs(), started: string[] = [], machines = new Set<string>(), projects = await store.projects()
  for (const p of projects.filter(x => coordinatorKey(x.key, projects) === x.key)) {
    const { ap, all: mine, holds, held } = await pilotOf(store, projects, p.key)
    const first = ap?.on ? busyQueue(mine)[0] : undefined
    if (!first) continue
    const pace = await paceOf(store, held.find(x => x.key === first.project)!, first, now)
    const next = busyNext(ap, mine, runs, now, { pace: pace.verdict, holds })
    if (!('task' in next)) continue
    const placed = await placeFor(deps, first, { waits: pace.waits })
    if ('hold' in placed || machines.has(placed.machine)) continue
    machines.add(placed.machine)
    forgetMemory(placed.machine)
    const r = await startTask(deps, first.id, { on: placed.machine })
      .catch((e: Error) => (startedElsewhere(e) ? null : { ...first, state: 'waiting' as const, waiting: e.message }))
    if (!r || r.sameFiles) continue
    const label = deps.machines().find(m => m.key === placed.machine)?.label ?? placed.machine
    const t = (await store.task(first.id))!
    await store.logTask(r.state === 'working' ? { ...t, autopilot: true } : t, 'engine', r.state === 'working' ? (await launched(store, r) ? `${AUTOPILOT_STARTED.busy}room on ${label}` : UNCONFIRMED) : `the autopilot could not start it: ${r.waiting ?? r.held ?? ''}`)
    started.push(first.id)
  }
  return started
}

// Kept for the board: since when the agent holding the step sits idle while
// the step waits for its report (pm/blocked.ts), also past its timeout. Unread
// status: unchanged. Idle, then seen working: back to work (backToWork).
async function noteIdle(deps: PmLaunchDeps, task: Task, plan: PlannedStep[], runs: Run[], now: number): Promise<Task> {
  const open = task.step?.yourTurn?.reason === 'timeout' ? { ...task, step: { ...task.step, yourTurn: undefined } } : task
  const step = awaitsHolder(open, plan) ? plan[task.step!.at] : undefined
  const holder = step && runs.filter(r => r.task === task.id && r.role === step.holder && r.state !== 'ended' && r.terminal).sort((a, b) => b.startedAt - a.startedAt)[0]
  let idle: number | undefined
  if (holder) {
    const st = await deps.call<{ status?: string | { state?: string } }>('terminal.get', { terminal: holder.terminal }, 3000).catch(() => null)
    if (!st) return task
    const s = typeof st.status === 'string' ? st.status : st.status?.state
    idle = s === 'idle' || s === 'done' ? task.idle ?? now : undefined
    if (task.idle !== undefined && s === 'working') {
      const saved = await deps.store.saveTask({ ...task, idle })
      return noteBack(deps.store, saved, plan, 'engine', `the ${step!.holder} is working again`, now)
    }
  }
  return idle === task.idle ? task : deps.store.saveTask({ ...task, idle })
}

// doing: told each stage, for the log of a pass that outlasts its interval (server/plugins/pm.ts).
export async function mechanicTick(deps: PmLaunchDeps, now = Date.now(), doing: (what: string) => void = () => {}) {
  const { store } = deps
  if (!(await store.enabled())) return []
  const stage = <T>(what: string, fn: () => Promise<T>) => { doing(what); return fn().catch(() => null) }
  await stage('syncWaits', () => syncWaits(deps))
  await stage('advanceTick', () => advanceTick(deps, now))
  // Before the chain: a resumed task's followers then see it working.
  const resumes = await stage('resumeInterrupted', () => resumeInterrupted(deps, now))
  if (resumes) await stage('wakeIncidents', () => wakeIncidents(deps, resumes.busy, now))
  await stage('releaseIdle', () => releaseIdle(deps, now))
  await stage('startChained', () => startChained(deps, now))
  await stage('startHeld', () => startHeld(deps, now))
  await stage('syncFiles', () => syncFiles(deps, now))
  await stage('startFileWaits', () => startFileWaits(deps))
  await stage('startNext', () => startNext(deps, now))
  await stage('samplePeaks', () => samplePeaks(deps))
  await stage('watchAgents', () => watchAgents(deps, (task, why) => wakeCoordinators(deps, task, why, now), now))
  doing('the tasks\' moves')
  const projects = await store.projects(), runs = await store.runs()
  const made: { task: string, move: Move['kind'] }[] = []
  const seen: Seen[] = []
  for (const each of await store.tasks()) {
    // One task's error is logged on it, once, and never stops the others' pass.
    const one = await followTask(deps, each, projects, runs, now).catch(async (e) => { await noteTaskError(store, each.id, e) })
    if (one) seen.push(one)
  }
  await queueTick(deps, seen)
  for (const { facts, run, sh } of seen) {
    const t = await moveTask(deps, facts, run, sh, now).catch(async (e) => { await noteTaskError(store, facts.task.id, e) })
    if (t) made.push(t)
  }
  // Last: every working task quiet with no stated reason is re-entered (pmSentinel.ts).
  await stage('sentinelTick', () => sentinelTick(deps, now))
  return made
}

// One task's facts for this tick; undefined: nothing to move (why, if any, on its card).
async function followTask(deps: PmLaunchDeps, task: Task, projects: Project[], runs: Run[], now: number): Promise<Seen | undefined> {
  const { store } = deps
  if (task.state === 'todo' || task.step?.done) {
    prSeen.delete(task.id)
    if (task.queue) { const { queue: _, queueOut: __, ...t } = task; await store.saveTask(t) }
    return
  }
  // Its step action runs (outside the tick): followed once it ended, never from an older copy.
  if (actionRunning(task.id)) return
  const p = projects.find(x => x.key === task.project)
  const t = p ? await store.workflow(p.key) : null
  if (!p || !t) { await noteCannotFollow(store, task, 'its project or workflow is missing'); return }
  const run = runs.filter(r => r.task === task.id && r.role === 'worker').sort((a, b) => b.startedAt - a.startedAt)[0]
  if (!run) { await noteCannotFollow(store, task, 'it has no worker run'); return }
  const plan = taskPlan(t, task, p)
  // Before the machine is reached: work handed to a worker on a machine gone offline says so.
  task = await noteHandedWork(deps, task, plan, run, now)
  let on: string | undefined
  try { on = runOn(deps, run) } catch (e) { await noteCannotFollow(store, task, `its machine: ${(e as Error).message}`); return }
  const sh = actionShell(deps, on)
  task = await noteIdle(deps, task, plan, runs, now)
  task = await noteFixWork(deps, task, plan, run, now)
  const facts: MechFacts = { task, plan, guards: taskGuards(t, task.type), branch: run.branch, agentBusy: false, now }
  if (task.state === 'waiting' && task.waitKind === 'auth') {
    facts.loggedIn = (await exec(deps, on, `${PATH_SETUP}\n${LOGIN_SCRIPT}`, [run.program]).catch(() => null))?.code === 0
  } else if (task.step && plan.slice(0, task.step.at).some(s => s.action?.kind === 'github.pr')) {
    const r = await sh(SCRIPT.prInfo, [run.worktree, run.branch])
    const info = r.code === 0 ? readPrInfo(r.out) : undefined
    // Its action ran or started while the PR was read: this copy is old, the next tick follows it.
    if (await changed(deps, task)) return
    if (!info) { await noteCannotFollow(store, task, `could not read the PR: ${lastLine(r.out) || (r.code === 0 ? 'unreadable answer' : `exit ${r.code}`)}`); return }
    facts.pr = info.prs[0]
    facts.head = info.head
    // The worker pushed the work the engine handed it: the step's Your turn, if any, comes back.
    const work = task.step?.agent
    if (work?.head && facts.pr && facts.pr.headRefOid !== work.head) {
      const retry = retriesAction(plan, task.step!)
      facts.task = task = await store.logTask({ ...task, step: agentBack(task.step!) }, 'engine', `${work.kind}: the worker pushed it${retry ? `, ${plan[task.step!.at]!.id} is tried again` : ''}`)
      // Started outside the tick: nothing more is written from this copy, the next tick follows it.
      if (retry) { startAction(deps, task.id); return }
    }
    // Kept for the board: a task is stalled only while its CI is still red (pm/blocked.ts).
    const ci = ciOf(facts.pr, facts.head)
    if (ci && (ci.head !== task.ci?.head || ci.red !== task.ci?.red || !!ci.running !== !!task.ci?.running)) facts.task = task = (await store.updateTask(task.id, x => ({ ...x, ci }))) ?? task
    const seen = prNow(facts.pr, requiredChecks(plan))
    if (seen) prSeen.set(task.id, seen)
    else prSeen.delete(task.id)
    facts.task = task = await keepPrBase(store, task, facts.pr)
    // Updated with its base and read clean by GitHub at that commit: the user's turn again.
    const settled = task.step?.caughtUp && caughtUpSettled(task.step.caughtUp, facts.pr, now) ? task.step.caughtUp : undefined
    if (settled) facts.task = task = (await store.updateTask(task.id, (x) => {
      if (!x.step || JSON.stringify(x.step.caughtUp) !== JSON.stringify(settled)) return x
      const { caughtUp: _, ...step } = x.step
      return { ...x, step }
    })) ?? task
    const st = run.terminal ? await deps.call<{ status?: string | { state?: string } }>('terminal.get', { terminal: run.terminal }, 3000).catch(() => null) : null
    const s = typeof st?.status === 'string' ? st.status : st?.status?.state
    facts.agentBusy = s === 'working' || s === 'blocked'
    // Red, neither re-run nor sent back yet: its log says whether the code failed or the infrastructure.
    if (ci?.red && !facts.agentBusy && !task.mech?.[`rerun:${ci.head}`] && !task.mech?.[`red:${ci.head}`])
      facts.infra = infraLog((await sh(SCRIPT.failedLog, [run.worktree, ci.head]).catch(() => null))?.out ?? '')
  } else if (prLink(task)) {
    // A PR its worker opened (no PR step): read for its base only, the branch
    // line's; the one linked, not another PR of the branch. Not found: left as it was.
    const link = prLink(task), r = await sh(SCRIPT.prInfo, [run.worktree, run.branch]).catch(() => null)
    // Unreadable: read again next tick.
    const pr = linkedPr(r?.code === 0 ? readPrInfo(r.out)?.prs ?? [] : [], link)
    if (pr) facts.task = task = await keepPrBase(store, task, pr)
  }
  if (await changed(deps, task)) return
  // A stall: the coordinator's wake, one nudge, then the user's (pmStall.ts).
  facts.task = task = await noteStall(deps, task, plan, runs, run.worktree, sh, now).catch(() => task)
  facts.task = task = await noteCannotFollow(store, task)
  return { facts, run, sh }
}

// The task moved on since this copy was read (its step action started, ran or
// ended meanwhile): nothing is written from the copy, the next tick reads it again.
async function changed(deps: PmLaunchDeps, task: Task) {
  if (actionRunning(task.id)) return true
  const fresh = await deps.store.task(task.id)
  return !fresh || JSON.stringify(fresh.step) !== JSON.stringify(task.step) || JSON.stringify(fresh.log?.at(-1)) !== JSON.stringify(task.log?.at(-1))
}

// At most one mechanical move for a followed task; returns it, if made.
async function moveTask(deps: PmLaunchDeps, facts: MechFacts, run: Run, sh: Seen['sh'], now: number): Promise<{ task: string, move: Move['kind'] } | undefined> {
  const { store } = deps
  let task = facts.task
  // Its step action runs, or ran since the task was read: no move beside it, the next tick reads its result.
  if (await changed(deps, task)) return
  const block = blockOf(task)
  if (block && !fixOf(task, block)) task = (await store.updateTask(task.id, x => ({ ...x, selfFix: noteFix(x, block, now) }))) ?? task
  const next = nextMove({ ...facts, task })
  const fix = block && next && FIX_MOVE[block] === next.move.kind ? block : undefined
  // No move, or past its tries: the coordinator's, once.
  if (!next || (fix && !mayTry(task, fix))) { await escalate(deps, task, run, now); return }
  const tried = fix && { selfFix: noteFix(task, fix, now, TRY_TEXT[next.move.kind]) }
  const noted = (await store.updateTask(task.id, x => ({ ...x, mech: { ...x.mech, [next.key]: now }, ...tried })))!
  const text = await perform(deps, noted, run, next.move, facts, sh).catch((e: Error) => `failed: ${e.message}`)
  // Not delivered (the agent's terminal is gone): tried again on a later tick.
  if (text === null) {
    await store.updateTask(task.id, (x) => { const { [next.key]: _, ...mech } = x.mech ?? {}; return { ...x, mech } })
    return
  }
  await store.updateTask(task.id, x => x, { by: 'engine', text: `${next.move.kind}: ${text}` })
  return { task: task.id, move: next.move.kind }
}

// The step's action, started outside the tick: its result is logged when it ends.
const actionStarted = (deps: PmLaunchDeps, id: string) =>
  startAction(deps, id) ? 'the step action started' : 'the step action runs already'

// What a try on a block is, in the coordinator's wake.
const TRY_TEXT: Partial<Record<Move['kind'], string>> = {
  'catch-up': 'an update with the base (a conflict goes to the worker)',
  'sync-push': 'a sync of the branch with its remote, then the push again',
  'retry-action': 'the action again',
}

// The engine gives up on a block: the project's coordinator and the main one
// woken once with what was tried, each whose autopilot wakes it for stuck
// tasks (as its 'stuck' event would have); else the user's (Your turn).
// Its machine offline or paused: no wake, the incident covers it; tried again once the machine is back.
async function escalate(deps: PmLaunchDeps, task: Task, run: Run, now: number) {
  const why = showIds(await deps.store.projects(), escalation(task, now))
  if (!why) return
  const down = await machineDown(deps, task, run)
  if (down) { await skipWake(deps, task, `${why} Not sent: it ${down.toLowerCase()}.`, now); return }
  const woken = await wakeCoordinators(deps, task, why, now)
  await deps.store.logTask({ ...task, selfFix: { ...task.selfFix!, woke: now } }, 'engine', `gave up: ${why}${woken.length ? ` Woke ${woken.join(' and ')}.` : ''}`)
}

async function perform(deps: PmLaunchDeps, task: Task, run: Run, move: Move, f: MechFacts, sh: ReturnType<typeof actionShell>): Promise<string | null> {
  // A worker that ended (released, or on its own) starts again with it; no
  // room on its machine: handed all the same, waiting with why (null: not delivered, tried again later).
  const tell = async (text: string): Promise<string | { hold: string } | null> => {
    const now = await workerNow(deps, run)
    if (now === 'alive') return deps.call('terminal.send', { terminal: run.terminal, text: showIds(await deps.store.projects(), text) }, 30000).then(() => 'sent to the agent', () => null)
    if (now !== 'gone') return now === 'offline' ? { hold: MACHINE_OFFLINE } : now === 'paused' ? { hold: MACHINE_PAUSED } : null
    if (run.state !== 'ended') await deps.store.saveRun({ ...run, state: 'ended', endedBy: 'exit' })
    let hold: string | undefined
    const t = await reviveWorker(deps, task.id, move.kind, text, h => { hold = h })
    return hold ? { hold } : t ? (t.state === 'working' ? 'started the worker again with it' : 'could not start the worker again') : null
  }
  // Work handed to the worker: the task leaves Your turn, its agents stay, until a push or its report.
  const hand = async (text: string) => {
    const r = await tell(text)
    if (!r || (typeof r === 'string' && r.startsWith('could not'))) return r
    const t = (await deps.store.task(task.id))!
    if (!t.step) return typeof r === 'string' ? r : r.hold
    const step = handToAgent(t.step, move.kind, f.pr?.headRefOid ?? f.head!, Date.now(), text)
    const revived = r === 'started the worker again with it' ? { ...step, agent: { ...step.agent!, revived: Date.now() } } : step
    const saved = await deps.store.saveTask({ ...t, step: revived })
    if (typeof r === 'string') return r
    await handedWaits(deps, saved, r.hold, f.now ?? Date.now())
    return `handed to the worker, which waits: ${r.hold}`
  }
  switch (move.kind) {
    case 'restart':
      // The agent stopped on its login may still sit in its terminal: one agent per task.
      if (run.terminal && run.state !== 'ended') await killTerminal(deps, run.terminal).catch(() => {})
      await deps.store.saveRun({ ...run, state: 'ended', endedBy: 'exit' })
      await deps.store.saveTask({ ...task, waitKind: undefined })
      return `the login is back; ${(await startTask(deps, task.id)).state}`
    case 'retry-action': case 'merge':
      return actionStarted(deps, task.id)
    case 'sync-push': {
      // The remote's commits in the worktree, then the push again; a conflict is the worker's.
      const r = await sh(SCRIPT.sync, [run.worktree, run.branch])
      if (r.code === CODE.SEND_BACK) return hand(`${lastLine(errorText(r))}. Merge origin/${run.branch} into your branch, resolve the conflicts, commit, then say you are done.`)
      if (r.code !== 0) return lastLine(errorText(r))
      return `${lastLine(r.out)}; ${actionStarted(deps, task.id)}`
    }
    case 'fix-base': {
      const refused = guardAction(f.guards, { kind: 'github.pr', base: move.base }, { branch: run.branch, by: 'engine' })
      if (refused) return refused
      const r = await sh(SCRIPT.pr, [run.worktree, run.branch, move.base, `${shownTaskId(await deps.store.projects(), task.id)}: ${task.title}`], task.description || task.title)
      return r.code === 0 ? `PR base set to ${move.base}` : lastLine(errorText(r))
    }
    case 'catch-up': {
      // A merge step waiting for the user: the card says it is updating, until the PR is clean.
      const waiting = waitsToMerge(f.plan[task.step!.at])
      const from = task.step!.catchUp?.from ?? f.head!
      if (waiting && !task.step!.catchUp) await stepEvent(deps, task.id, f.plan, { kind: 'catch-up', base: move.base, head: f.head! })
      const r = await sh(SCRIPT.catchUp, [run.worktree, move.base, run.branch])
      if (r.code === CODE.SEND_BACK) {
        return hand(waiting
          ? `${lastLine(errorText(r))}. Merge origin/${move.base} into your branch, resolve the conflicts, commit, then stop: the engine pushes it.`
          : `${lastLine(errorText(r))}. Merge origin/${move.base} into your branch, fix it, commit, then say you are done.`)
      }
      if (waiting) {
        const head = r.code === 0 ? lastLine(r.out) : undefined
        const since = reviewedCommit(f.plan, task.step!) ?? from
        await stepEvent(deps, task.id, f.plan, head
          ? { kind: 'caught-up', head, ...(f.head !== from ? { review: { since, head } } : {}) }
          : { kind: 'caught-up', error: `update with ${move.base}: ${lastLine(errorText(r))}` })
      }
      if (r.code === 0) return `caught up with ${move.base}`
      return catchUpGaveUp(task, f.head) ? `${lastLine(errorText(r))} (failed ${CATCH_UP_TRIES} times: wherdr stops updating this commit)` : lastLine(errorText(r))
    }
    case 'take-update': {
      const at = await sh(SCRIPT.headOf, [run.worktree, f.pr!.headRefOid, f.pr!.baseRefName])
      if (at.code !== 0 || lastLine(at.out) !== 'update') return 'the PR head is not a GitHub update: left as it is'
      const u = await takeUpdate(sh, run.worktree, run.branch, f.guards, 'engine')
      if (!u.ok && u.toAgent) return hand(`${u.error}. Merge origin/${run.branch} into your branch, resolve the conflicts, commit, then say you are done.`)
      if (!u.ok) return u.error
      // A merge step waiting for the user: recorded as a clean update with its base, the reviewed commit moving with it.
      if (waitsToMerge(f.plan[task.step!.at]) && !task.step!.catchUp) {
        await stepEvent(deps, task.id, f.plan, { kind: 'catch-up', base: f.pr!.baseRefName, head: f.head! })
        await stepEvent(deps, task.id, f.plan, { kind: 'caught-up', head: u.head })
      }
      return `took GitHub's update of the PR in, fixed and pushed at ${u.head.slice(0, 7)}`
    }
    case 'rerun-ci': {
      const r = await sh(SCRIPT.rerun, [run.worktree, f.head!])
      return r.code === 0 ? `ran ${move.checks.join(', ')} again` : lastLine(errorText(r))
    }
    case 'ci-to-agent': return hand(redCiText(move.checks, f.head!))
  }
}

interface Seen { facts: MechFacts, run: Run, sh: ReturnType<typeof actionShell> }

// Each project's merge queue (shared/pm/mergeQueue.ts): every task's place,
// and why it stepped out of line, kept on it; logged as it enters or comes first.
// One that merges after a stopped or abandoned task wakes its coordinator once.
async function queueTick(deps: PmLaunchDeps, seen: Seen[], now = Date.now()) {
  const queued = seen.filter(x => inMergeQueue(x.facts.task, x.facts.plan, x.facts.guards, x.facts.pr))
  const all = queued.some(x => x.facts.task.mergeAfter) ? await deps.store.tasks() : []
  for (const project of new Set(seen.map(x => x.facts.task.project))) {
    const mine = queued.filter(x => x.facts.task.project === project)
    for (const x of mine) {
      x.facts.queueOut = queueOut(x.facts, all)
      const wake = mergeAfterWake(x.facts.task, all)
      if (!wake) continue
      await wakeCoordinators(deps, x.facts.task, wake.why, now)
      x.facts.task = (await deps.store.updateTask(x.facts.task.id, t => ({ ...t, mech: { ...t.mech, [wake.key]: now } }), { by: 'engine', text: wake.why })) ?? x.facts.task
    }
    const order = mergeOrder(mine.map(({ facts: { task, pr, queueOut: out } }) => ({
      id: task.id, files: (pr!.files ?? []).map(f => f.path), size: (pr!.additions ?? 0) + (pr!.deletions ?? 0), out, order: task.order,
    })))
    for (const x of mine) {
      const place = order.indexOf(x.facts.task.id) + 1, out = x.facts.queueOut
      x.facts.queue = place
      if (x.facts.task.queue === place && x.facts.task.queueOut === out) continue
      const said = !x.facts.task.queue ? `in the merge queue${out ? `, out of line: ${out}` : `, ${ordinal(place)}`}`
        : place === 1 && !out && (x.facts.task.queue !== 1 || x.facts.task.queueOut) ? 'first in the merge queue: it merges now' : undefined
      // Its place only, on the task as it is now: a step action that ended meanwhile stays.
      x.facts.task = (await deps.store.updateTask(x.facts.task.id, (fresh) => {
        const { queueOut: _, ...t } = { ...fresh, queue: place }
        return out ? { ...t, queueOut: out } : t
      }, said ? { by: 'engine', text: said } : undefined)) ?? x.facts.task
    }
  }
  // Out of the queue (merged, stopped, waiting for the user): its place goes.
  for (const x of seen.filter(y => y.facts.task.queue && !queued.includes(y))) {
    x.facts.task = (await deps.store.updateTask(x.facts.task.id, ({ queue: _, queueOut: __, ...t }) => t)) ?? x.facts.task
  }
}

// A step event the mechanic gives a task, on its fresh state; its log lines go to the task's log.
async function stepEvent(deps: PmLaunchDeps, id: string, plan: PlannedStep[], ev: StepEvent) {
  const task = (await deps.store.task(id))!
  const r = onEvent(plan, task.step!, ev, Date.now())
  if (r.refused) return
  const log = r.effects.flatMap(e => (e.kind === 'log' ? [e.text] : [])).join('; ')
  await (log ? deps.store.logTask({ ...task, step: r.state }, 'engine', log) : deps.store.saveTask({ ...task, step: r.state }))
}

// The PR's base and commit count kept on the task (the branch line), saved only
// when they change; kept once the task is done, so it still says where it went.
export async function keepPrBase(store: PmStore, task: Task, pr: PrInfo | undefined): Promise<Task> {
  const want = pr ? { base: pr.baseRefName, ...(pr.commits ? { commits: pr.commits.length } : {}) } : undefined
  if (JSON.stringify(want) === JSON.stringify(task.prBase)) return task
  // On the task as it is now: a step action that ended meanwhile stays.
  return (await store.updateTask(task.id, ({ prBase: _, ...rest }) => (want ? { ...rest, prBase: want } : rest))) ?? task
}
