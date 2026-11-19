// A project's "On state change" command (the user's only): run on its home
// machine, in its clone, when one of its tasks starts, waits for the user, is
// done, or fails or is stopped. The facts go as environment variables, never
// into the command line. Each event runs at most once per task (Task.stateRan).
import type { Task } from './run'
import type { WorkflowError } from './workflow'
import { prLink } from './run'
import { waitsForUser } from './times'
import { tagOf } from './branchName'

// The events the user picks; 'failed' covers a task that fails or is stopped.
export const STATE_EVENTS = ['started', 'waits', 'done', 'failed'] as const
export type StateEvent = typeof STATE_EVENTS[number]
// WHERDR_TASK_STATE: the event, 'stopped' for a stop.
export type TaskStateName = 'started' | 'waits' | 'done' | 'failed' | 'stopped'
export interface OnStateChange { command: string, events: StateEvent[] }

export const ON_STATE_TIMEOUT = 30 // seconds
export const COMMAND_MAX = 2000
const isEvent = (e: unknown): e is StateEvent => (STATE_EVENTS as readonly unknown[]).includes(e)

// The setting from a project update: { command, events } (an empty command or
// no event clears it, ''), null clears it too.
export function cleanOnState(raw: unknown, errors: WorkflowError[]): OnStateChange | '' | undefined {
  if (raw === undefined) return
  if (raw === null || raw === '') return ''
  const o = (typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const command = typeof o.command === 'string' ? o.command.trim() : ''
  if (typeof o.command !== 'string' || command.length > COMMAND_MAX || command.includes('\0')) {
    errors.push({ path: 'onStateChange.command', message: `a shell command of at most ${COMMAND_MAX} characters` })
    return
  }
  if (!Array.isArray(o.events) || !o.events.every(isEvent)) {
    errors.push({ path: 'onStateChange.events', message: `a list of ${STATE_EVENTS.join(', ')}` })
    return
  }
  const events = STATE_EVENTS.filter(e => (o.events as unknown[]).includes(e))
  return command && events.length ? { command, events } : ''
}

// What a write changed, from the task on disk to the one written: one name
// per change (a stop is not also a wait), each event once per task.
export function stateChanges(before: Task | null | undefined, after: Task): TaskStateName[] {
  const was = before ?? undefined, s = after.step, fired = (e: StateEvent) => !!after.stateRan?.[e]
  const out: TaskStateName[] = []
  if (s?.started && !was?.step?.started && !fired('started')) out.push('started')
  const ended = !!s?.done && !was?.step?.done
  const failedNow = (ended && !!s?.abandoned) || (s?.yourTurn?.reason === 'action' && was?.step?.yourTurn?.reason !== 'action')
  if (ended && !s?.abandoned && !fired('done')) out.push('done')
  else if (after.stopped && !was?.stopped && !fired('failed')) out.push('stopped')
  else if (failedNow && !fired('failed')) out.push('failed')
  else if (!s?.done && waitsForUser(after) && !(was && waitsForUser(was)) && !fired('waits')) out.push('waits')
  return out
}
// The event a state name is picked under.
export const eventOf = (n: TaskStateName): StateEvent => (n === 'stopped' ? 'failed' : n)

// The command's environment.
export function stateEnv(task: Task, shownId: string, state: TaskStateName, project: string): Record<string, string> {
  return {
    WHERDR_TASK_ID: shownId,
    WHERDR_TASK_TAG: tagOf(task),
    WHERDR_TASK_TITLE: task.title,
    WHERDR_TASK_STATE: state,
    WHERDR_TASK_PR: prLink(task) ?? '',
    WHERDR_PROJECT: project,
  }
}

// The task log's line: 'on state change (done): exit 0', then the first lines of output.
export function stateLogText(state: TaskStateName, r: { code: number | null, out: string, err?: string } | { error: string }): string {
  if ('error' in r) return `on state change (${state}): not run (${r.error})`
  const head = `on state change (${state}): ${r.code === null ? `timed out after ${ON_STATE_TIMEOUT} s` : `exit ${r.code}`}`
  const lines = [r.out, r.err ?? ''].join('\n').split('\n').map(l => l.trimEnd()).filter(Boolean).slice(0, 3).map(l => l.slice(0, 200))
  return lines.length ? `${head}: ${lines.join(' / ')}` : head
}
