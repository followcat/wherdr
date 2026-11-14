// Crash recovery (WHR-186): a task whose agent an incident took (incident.ts)
// waits for the engine, not the user. Once the cause is gone (its machine
// back, the account's limit over; a restart or a crash at once), the engine
// resumes it in its worktree, the tasks before it first. The same cause again
// soon after a resume goes to the coordinator instead. Pure:
// server/utils/pmRecovery.ts reads the machines and starts the agents.
import { afterIds } from './advance'
import { CAUSE_TEXT, incidentLine, recovering, type Incident, type Recovery } from './incident'
import type { Task } from './run'

// A new failure this soon after the engine's resume, for the same cause, is "in a row".
export const IN_A_ROW_MS = 60 * 60_000

const resumesWhen = (r: Pick<Recovery, 'cause' | 'label'>) =>
  r.cause === 'offline' ? `once ${r.label} is back` : r.cause === 'limit' ? 'once the account\'s limit resets' : 'now'

// The task as the incident leaves it: waiting for the engine's resume, or,
// the same cause again right after one, for the coordinator (escalate: its wake's reason).
export function interrupted(task: Task, i: Pick<Incident, 'id' | 'cause' | 'machine' | 'label'>, now: number): { task: Task, escalate?: string } {
  const prev = task.recovery
  const again = !!prev?.resumedAt && prev.cause === i.cause && now - prev.resumedAt < IN_A_ROW_MS
  const recovery: Recovery = { incident: i.id, cause: i.cause, machine: i.machine, label: i.label, ...(task.run ? { run: task.run } : {}), at: now, n: again ? prev!.n + 1 : 1 }
  const base = { ...task, state: 'waiting' as const, waitKind: undefined, held: undefined, sameFiles: undefined }
  if (!again) return { task: { ...base, waiting: `${incidentLine(i)}: wherdr resumes it ${resumesWhen(i)}`, recovery: { ...recovery, waits: true } } }
  return {
    task: { ...base, waiting: `${incidentLine(i)}, again right after wherdr resumed it: the coordinator was told; start the task again to go on`, recovery },
    escalate: `${task.id} stopped again right after the engine resumed it: ${CAUSE_TEXT[i.cause]} (${i.label}, incident ${i.id}; wherdr pm incidents). It is not resumed again by itself: start it again once that is fixed, or tell the user.`,
  }
}

// Whether the cause is gone, from what the engine reads now: a machine still
// offline keeps its tasks waiting, whatever the cause.
export const causeGone = (r: Pick<Recovery, 'cause'>, now: { online: boolean, limited: boolean }) =>
  now.online && !(r.cause === 'limit' && now.limited)

// The recovering tasks the engine may resume, oldest first: none whose
// earlier tasks (after) are still recovering. Those wait for them.
export function resumeOrder(tasks: Task[]): Task[] {
  const waiting = new Set(tasks.filter(recovering).map(t => t.id))
  return tasks.filter(t => waiting.has(t.id) && !afterIds(t).some(id => waiting.has(id))).sort((a, b) => a.createdAt - b.createdAt)
}

// A follower of a task the engine resumes waits for it quietly, never as stopped.
export const resumeWait = (id: string) => `Waits for ${id} to resume`
export const isResumeWait = (s?: string) => !!s && /^Waits for \S+ to resume$/.test(s)

// The first message of a resumed conversation; why a new agent's handover says it stopped.
export const resumeText = (r: Pick<Recovery, 'cause'>, instructions: string) =>
  `You were interrupted (${CAUSE_TEXT[r.cause]}). Check git status and continue where you left off; your instructions are in ${instructions}.`
export const interruptedWhy = (r: Pick<Recovery, 'cause'>) => `its agent was interrupted (${CAUSE_TEXT[r.cause]}); check git status and continue where it left off`
