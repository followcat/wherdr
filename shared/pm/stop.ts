// Stopping a task and taking it up again. A stop ends the agent that holds the
// step and keeps the worktree, the branch and the work; the task waits for
// the user, with who stopped it and why. Pure: server/utils/pmStop.ts ends the
// agents and saves the task.
import type { Task } from './run'
import { afterIds, dueText, mergeAfterIds } from './advance'
import type { PlannedStep, StepState } from './steps'

export interface Stopped { by: string, why: string, at: number }

// continue: the current step's agent again, same worktree, with a handover
// note. as-is: on to the next step (the review). archive: the task ends, its
// worktree removed, its branch kept.
export const RESUMES = ['continue', 'as-is', 'archive'] as const
export type Resume = typeof RESUMES[number]

// Who asks: the user, or the coordinator in a turn of the user or in a wake.
export type Stopper = { who: 'user' } | { who: 'coordinator', wake: boolean }

// The autopilot's own tasks: started or added by the coordinator in a wake.
const autopilots = (t: Task) => !!t.autopilot

// Why the task may not be stopped now, or undefined. In a wake, the
// coordinator stops only its autopilot's own tasks.
export function stopRefusal(task: Task, by: Stopper): string | undefined {
  if (task.step?.done) return `${task.id} is done`
  if (task.stopped) return `${task.id} is already stopped`
  if (task.state === 'todo' || !task.step?.started) return `${task.id} has not started`
  if (by.who === 'coordinator' && by.wake && !autopilots(task)) return `In a wake, you stop only the tasks your autopilot started: ${task.id} is the user's`
}

export const stoppedText = (s: Stopped) => `Stopped by ${s.by}: ${s.why}`

// The task once stopped: waiting for the user, on no agent's question.
export const stoppedTask = (task: Task, s: Stopped): Task =>
  ({ ...task, state: 'waiting', waiting: stoppedText(s), waitKind: undefined, stopped: s })

// The step of an archived task: done, no longer acting nor waiting for the user.
export const archivedStep = (s: StepState): StepState =>
  ({ ...s, done: true, abandoned: true, acting: undefined, yourTurn: undefined })

// A done task still marked as the user's turn (archived before archivedStep):
// the same task without it, or undefined when there is nothing to repair.
export const doneTurnRepair = (task: Task): Task | undefined =>
  task.step?.done && (task.step.yourTurn || task.step.acting || task.state === 'waiting')
    ? { ...task, state: task.state === 'waiting' ? 'working' : task.state, waiting: undefined, waitKind: undefined, step: { ...task.step, acting: undefined, yourTurn: undefined } }
    : undefined

// Why the task may not be taken up that way, or undefined. The coordinator
// only continues (its `task start`), and in a wake only its autopilot's tasks.
export function resumeRefusal(task: Task, how: Resume, by: Stopper, step: PlannedStep | undefined): string | undefined {
  if (!task.stopped) return `${task.id} is not stopped`
  if (!RESUMES.includes(how)) return `How to go on: ${RESUMES.join(', ')}`
  if (by.who === 'coordinator' && how !== 'continue') return 'Taking a stopped task as it is, or archiving it, is the user\'s'
  if (by.who === 'coordinator' && by.wake && (!autopilots(task) || task.stopped.by === 'the user')) return `${task.id} was stopped by ${task.stopped.by}: going on is the user's call`
  if (how === 'as-is' && !step?.ends) return 'This step has no end to skip'
}

// The note a continued worker reads first: why it stopped, where the work is,
// and what its step asks now (a send-back's findings, or the step's text).
export function handoverText(task: Task, plan: PlannedStep[], branch: string): string {
  const s = task.step!, st = task.stopped!
  const due = dueText(plan, { ...s, told: undefined, yourTurn: undefined })
  const log = (task.log ?? []).slice(-5).map(e => `- ${new Date(e.at).toISOString().slice(0, 16)} ${e.by}: ${e.text.split('\n')[0]!.slice(0, 200)}`)
  return [
    '## Handover', '',
    `An earlier agent worked on this task and was stopped by ${st.by}: ${st.why}`,
    'Its work is in this worktree as it left it: read `git status` and '
    + `\`git log $(git config branch.${branch}.wherdrstart)..HEAD\` before you change anything.`, '',
    ...(log.length ? ['The task\'s last log lines:', ...log, ''] : []),
    ...(due?.holder === 'worker' ? [`Your step now (${plan[s.at]!.id}):`, '', due.text.replace(/\n\nWhen done: .*$/s, ''), ''] : []),
  ].join('\n')
}

// Not started: no step, no agent ever ran, so no worktree and no branch. Only
// such a task can be removed; a started one is stopped, then archived.
export const notStarted = (task: Task, runs: { task: string }[]) =>
  task.state === 'todo' && !task.run && !task.step?.started && !task.stopped && !runs.some(r => r.task === task.id)

// Why the task may not be removed, or undefined. In a wake, the coordinator
// removes only a task its autopilot added. A task others wait for (after) is
// refused, naming them: their chain is the user's or the coordinator's to fix first.
export function removeRefusal(task: Task, runs: { task: string }[], tasks: Task[], by: Stopper): string | undefined {
  if (!notStarted(task, runs)) return `${task.id} has started: stop it, then archive it`
  if (by.who === 'coordinator' && by.wake && !autopilots(task)) return `In a wake, you remove only the tasks your autopilot added: ${task.id} is the user's`
  const waiting = tasks.filter(t => t.id !== task.id && !t.step?.done && [...afterIds(t), ...mergeAfterIds(t)].includes(task.id))
  if (waiting.length) return `${waiting.map(t => t.id).join(', ')} wait${waiting.length > 1 ? '' : 's'} for ${task.id} (after): remove ${waiting.length > 1 ? 'them' : 'it'} first`
}
