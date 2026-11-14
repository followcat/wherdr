// A task under way whose current step's holder has no running agent (released,
// ended on its own, lost in a restart): once that lasts AGENTLESS_MS, the
// engine starts it again (server/utils/pmWatchdog.ts). A try that fails is
// said on the status line; at the second, the coordinator is woken once. Pure.
import type { Task } from './run'
import { durationMs, type PlannedStep } from './steps'
import { waitsForUser, waitsInQueue } from './release'
import { backToWork } from './blocked'

export const AGENTLESS_MS = 3 * 60_000

// Why a worker the watchdog starts again was stopped (its handover note).
export const AGENTLESS_WHY = 'its agent was no longer running while the task was under way, so the engine started a new one'

// The role whose agent the task needs now: working, its step under way and held
// by an agent, nothing asked of the user, no engine action or handed work
// (handedWatch's), not waiting in the merge queue. Undefined: none.
export function agentNeeded(task: Task, plan: PlannedStep[]): 'worker' | 'reviewer' | undefined {
  const s = task.step
  if (task.state !== 'working' || task.stopped || !s?.started || s.done || s.acting || s.agent || s.yourTurn) return
  // A review waiting in its account's queue: no agent is missing.
  if (waitsForUser(task) || waitsInQueue(task) || task.reviewWait) return
  const holder = plan[s.at]?.holder
  return holder === 'worker' || holder === 'reviewer' ? holder : undefined
}

// Since when the agent is missing, the failed tries, the coordinator woken.
export interface AgentWatch { since: number, fails: number, woke?: true }

// This pass: the watch carried on (undefined: nothing is missing) and whether a try is due.
export function watchAgent(prev: AgentWatch | undefined, missing: boolean, now: number): { watch?: AgentWatch, due: boolean } {
  if (!missing) return { due: false }
  const watch = prev ?? { since: now, fails: 0 }
  return { watch, due: now - watch.since >= AGENTLESS_MS }
}

// A try failed: counted, the next one AGENTLESS_MS later; wake: the second
// failure, the coordinator is woken (once, never again for this watch).
export function watchFailed(w: AgentWatch, now: number): { watch: AgentWatch, wake: boolean } {
  const fails = w.fails + 1, wake = fails >= 2 && !w.woke
  return { watch: { since: now, fails, ...(w.woke || wake ? { woke: true as const } : {}) }, wake }
}

// Why the review cannot start again now; undefined: it can (its step is the
// reviewer's, under way, the task working, no engine action running).
export function reviewRestartRefusal(task: Task, plan: PlannedStep[]): string | undefined {
  const s = task.step
  if (task.stopped) return 'The task was stopped: start it again instead'
  if (!s?.started || s.done || plan[s.at]?.holder !== 'reviewer') return 'The task is not at its review step'
  // Waiting on a failure (its reviewer exited right after starting): the restart is the way out.
  const failed = task.state === 'waiting' && !task.waitKind
  if ((task.state !== 'working' && !failed) || s.acting) return 'The task is busy with something else now'
}

// The review started again: its timeout in Your turn or its failure goes, the
// step's time limit starts again from now, and its holder is told again, so
// the next advance pass starts a new reviewer on the branch's current head
// (its old run ended by the caller).
export function reviewRestarted(task: Task, plan: PlannedStep[], now: number): Task {
  const back = backToWork(task, plan, now) ?? task
  const { told: _, ...step } = back.step!
  const timeout = plan[step.at]?.timeout
  const failed = back.state === 'waiting' && !back.waitKind
  return {
    ...back, held: undefined,
    ...(failed ? { state: 'working' as const, waiting: undefined } : {}),
    step: { ...step, ...(step.yourTurn?.reason === 'timeout' ? { yourTurn: undefined } : {}), ...(timeout ? { deadline: now + durationMs(timeout) } : {}) },
  }
}
