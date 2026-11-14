// The engine's liveness rule: a started task that is not done always has
// someone on it (an agent, an action running), or is retried with backoff, or
// says why it waits. The sentinel (server/utils/pmSentinel.ts, at the end of
// each mechanic tick) looks at every working task with no stated reason: past
// SENTINEL_MS with no log, no move and no step change, it says what it sees,
// runs the step again, looks again after 2N, 4N…, and wakes the coordinator
// once per task and step. Pure.
import type { Task } from './run'
import type { PlannedStep, StepState } from './steps'

export const SENTINEL_MS = 20 * 60_000
// Its own log lines start so; they are no progress.
export const SENTINEL_LOG = 'no progress for'
// A working task the mechanic cannot follow (no worker run, its PR unreadable): its card says why.
export const READ_HOLD = 'The engine cannot follow it: '
export const isReadHold = (held?: string) => !!held?.startsWith(READ_HOLD)

// step: the step it watches (index, id, start); n: its tries there; next: its next look.
export interface Sentinel { step: string, n: number, next: number, woke?: true }

// Why nobody need move it now; undefined: no reason is stated. An agent
// holding the step is the stall's and the watchdog's; handed work whose
// worker works is checked by the caller, which knows the terminals.
export function statedReason(task: Task, plan: PlannedStep[]): string | undefined {
  const s = task.step
  if (task.state !== 'working') return task.waiting || task.state
  if (task.stopped) return 'stopped'
  const why = task.held || task.queueOut || task.reviewWait || task.machineWait || s?.yourTurn?.badge || s?.agent?.waits
  if (why) return why
  if ((task.queue ?? 1) > 1) return 'waits for its turn in the merge queue'
  if (task.ci?.running) return 'its checks run'
  if (s?.watch) return 'its action checks again shortly'
  if (s?.paused) return 'its clock is paused'
  const holder = s && plan[s.at]?.holder
  if (holder === 'worker' || holder === 'reviewer') return `its ${holder} holds the step`
}

// The last sign of life: a log line (not the sentinel's), a move, a step change.
export function lastProgress(task: Task): number {
  const log = (task.log ?? []).filter(e => !e.text.startsWith(SENTINEL_LOG)).at(-1)?.at ?? 0
  return Math.max(task.createdAt, task.step?.since ?? 0, task.marks?.at(-1)?.at ?? 0, log, ...Object.values(task.mech ?? {}))
}

const stepKey = (task: Task, plan: PlannedStep[]) => `${task.step!.at}:${plan[task.step!.at]?.id ?? ''}:${task.step!.since ?? 0}`

// The step the sentinel looks at now; undefined: not due.
export function sentinelDue(task: Task, plan: PlannedStep[], now: number, ms = SENTINEL_MS): string | undefined {
  const s = task.step
  if (!s?.started || s.done || statedReason(task, plan)) return
  const key = stepKey(task, plan)
  const prev = task.sentinel?.step === key ? task.sentinel : undefined
  if (now - lastProgress(task) < ms || (prev && now < prev.next)) return
  return key
}

// One more try at this step: the next look after 2N, 4N…
export function sentinelFired(prev: Sentinel | undefined, key: string, now: number, ms = SENTINEL_MS): Sentinel {
  const same = prev?.step === key ? prev : undefined
  const n = (same?.n ?? 0) + 1
  return { step: key, n, next: now + ms * 2 ** n, ...(same?.woke ? { woke: true as const } : {}) }
}

// What the engine sees of a quiet task, for its log and the coordinator's wake.
export function seenBy(task: Task, plan: PlannedStep[]): string {
  const s = task.step!, step = plan[s.at]
  const parts = [
    `at step ${step?.id ?? s.at}${step?.action ? ` (${step.action.kind})` : ''}`,
    s.acting ? 'its action is marked running but none runs' : '',
    s.agent ? `${s.agent.kind} handed to its worker, which is not working` : '',
    task.log?.length ? `last: "${task.log.at(-1)!.text.slice(0, 160)}"` : '',
  ]
  return parts.filter(Boolean).join(', ')
}

// A step ending on its action, stranded with none running (moved there by a
// workflow change, an action that never started): marked running for one
// more attempt, so the engine's step action runs it again. Undefined: not such a step.
export function strandedAction(s: StepState, plan: PlannedStep[]): StepState | undefined {
  const step = plan[s.at]
  if (!step?.action || step.ends !== 'action' || s.acting || s.yourTurn) return
  return { ...s, acting: true, tries: { ...s.tries, [step.id]: (s.tries?.[step.id] ?? 0) + 1 } }
}
