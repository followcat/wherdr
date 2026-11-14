// A stalled task: it holds a slot, nothing moves, and the machine could still
// fix it (the agent fixes its CI, the idle agent goes on). When it begins, the
// engine wakes the coordinator (autopilot 'stuck') and nudges the agent once
// per cause; the board card shows a small warning with the reason. Unresolved
// HANDLE_AFTER_MS after it began, the task waits for the user (Your turn, the
// sidebar's Tasks to handle) and they get a notification. What already waits
// for the user (a refused merge, a failed action, a question) is in Your turn
// at once, not here. Pure: the engine's pass records what it reads (task.ci,
// task.idle, task.stalls), the board computes from it.
import { durationMs, type PlannedStep } from './steps'
import type { Task } from './run'
import { recovering } from './incident'

// Red CI sent to the agent, still red on that same commit, no other engine move.
export const RED_CI_WAIT_MS = 10 * 60_000
// The agent holding the step idle after its instructions were delivered.
export const IDLE_WAIT_MS = 5 * 60_000
// Still stalled this long after its nudge: its agent is restarted, once.
export const RESTART_AFTER_MS = 10 * 60_000
// A stall still there this long after it began: the user's.
export const HANDLE_AFTER_MS = 30 * 60_000

// cause: what stalls it, one nudge each (red:<commit>, idle:<step>:<attempt>); since: when it began.
export interface Stall { cause: string, reason: string, since: number }

const current = (task: Task, plan: PlannedStep[]) => {
  const s = task.step
  return s?.started && !s.done && !task.stopped && task.state === 'working' && !s.yourTurn ? { s, step: plan[s.at] } : undefined
}

// The step waits for its holder's report or verdict, and its instructions were delivered.
export function awaitsHolder(task: Task, plan: PlannedStep[]): boolean {
  const c = current(task, plan)
  return !!c?.step && !c.s.acting && (c.step.holder === 'worker' || c.step.holder === 'reviewer')
    && (c.step.ends === 'report' || c.step.ends === 'verdict') && c.s.told === c.s.since
}

export function stallOf(task: Task, plan: PlannedStep[], now: number): Stall | undefined {
  const c = current(task, plan)
  if (!c?.step) return
  const since = c.s.since ?? 0
  const sent = task.ci?.red ? task.mech?.[`red:${task.ci.head}`] : undefined
  const last = Math.max(0, ...Object.values(task.mech ?? {}))
  // A cause seen before keeps when it first began: an agent idle again after its nudge is not new.
  // Back to work since (backToWork): its clock starts again from then.
  const of = (cause: string, reason: string, from: number) => {
    const seen = task.stalls?.[cause]
    return { cause, reason, since: Math.max(seen?.back ?? 0, Math.min(from, seen?.since ?? from)) }
  }
  if (sent !== undefined && sent === last && sent >= since && now - sent >= RED_CI_WAIT_MS)
    return of(`red:${task.ci!.head}`, 'CI red, no new push for 10 min', sent + RED_CI_WAIT_MS)
  if (task.idle !== undefined && awaitsHolder(task, plan)) {
    const from = Math.max(task.idle, since) + IDLE_WAIT_MS
    if (now >= from) return of(`idle:${c.s.at}:${since}`, `The ${c.step.holder} stopped before saying it is done`, from)
  }
}

// Back to work: the coordinator or the user told the task's agent something or
// started the task again, or the step's agent is seen working again. A timeout
// in Your turn goes and the step's deadline starts again from now; a stall's
// clock starts again from now too (no hand-over yet, so it comes back if the
// agent stops again). What the user must do (a merge, an answer, a decision)
// stays. Undefined: nothing to clear.
export function backToWork(task: Task, plan: PlannedStep[], now: number): Task | undefined {
  const s = task.step, step = s?.started && !s.done ? plan[s.at] : undefined
  if (!s || !step) return
  const timeout = s.yourTurn?.reason === 'timeout' && !!step.timeout
  if (!timeout && !task.stall) return
  const stalls = task.stalls && Object.fromEntries(Object.entries(task.stalls).map(([k, v]) => [k, { ...v, back: now, handled: undefined }]))
  return {
    ...task,
    // Idle since before: counted from now, or the stall would be handed over at once.
    ...(task.idle !== undefined ? { idle: now } : {}),
    ...(timeout ? { step: { ...s, yourTurn: undefined, deadline: now + durationMs(step.timeout!) } } : {}),
    ...(task.stall ? { stall: { ...task.stall, since: now } } : {}),
    ...(stalls ? { stalls } : {}),
  }
}

// What the engine does for a stall this pass: nudge the agent, once per
// cause; restart it, once, RESTART_AFTER_MS after the nudge; hand it to the
// user (Tasks to handle, a notification), once, when still there
// HANDLE_AFTER_MS after it began.
export function stallMoves(task: Pick<Task, 'stalls'>, s: Stall, now: number) {
  const seen = task.stalls?.[s.cause]
  return {
    nudge: !seen?.nudged,
    restart: !!seen?.nudged && !seen.restarted && now - seen.nudged >= RESTART_AFTER_MS,
    handle: now - s.since >= HANDLE_AFTER_MS && !seen?.handled,
  }
}

// The failing tests named in a job's log (gh run view --log-failed): Vitest's
// and Playwright's FAIL and ✗ lines, each once, at most 10.
export function failingTests(log: string): string[] {
  const out = new Set<string>()
  for (const raw of log.split('\n')) {
    // gh prefixes each line with the job, the step and a timestamp.
    const line = raw.replace(/^[^\t]*\t[^\t]*\t/, '').replace(/^\S*\dT\d\S*Z\s/, '').replace(/\x1B\[[\d;]*m/g, '').trim()
    const m = /^(?:FAIL|[×✗✕✘])\s+(.+?)(?:\s+\d+m?s)?$/.exec(line)
    if (m) out.add(m[1]!.slice(0, 200))
  }
  return [...out].slice(0, 10)
}

// What the agent is told when it is nudged.
export const nudgeText = (s: Stall, tests: string[] = []) => s.cause.startsWith('red:')
  ? `CI is still red on commit ${s.cause.slice(4, 11)} and nothing was pushed since.${tests.length ? ` Failing: ${tests.join('; ')}.` : ''} Read the log (gh run view --log-failed), fix it, commit, then say you are done.`
  : 'Your step still waits for you: finish it, then say you are done (or ask, if something blocks you).'

// What the board says of a stalled task once it is the user's.
export const stallTurn = (s: Stall) => `Stalled: ${s.reason}`

// The step's holder cannot work (pauseClock): the task waits for room, a machine
// or the pace (held), for the engine to resume it after an incident, or the
// machine its agent runs on is offline or unreachable.
export const clockStops = (task: Pick<Task, 'state' | 'run' | 'recovery' | 'stopped' | 'waitKind' | 'held'>, machineOffline: boolean) =>
  machineOffline || recovering(task) || (!!task.held && (task.state === 'todo' || task.state === 'working'))
