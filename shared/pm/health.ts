// The health lines of a scheduled wake: a short summary of the project since
// the last slot, under the goal line. Nothing wrong: it acks at once. Nothing
// to say and nothing to act on: no wake (pmWakes.ts).
import { busyQueue, taskStatus, type Autopilot, type TaskStatus } from './autopilot'
import type { Task } from './run'

// The old health check's default interval, before it joined the scheduled wake.
export const HEALTH_EVERY = '3h'
// A stall this long is stuck for long.
export const STUCK_LONG_MS = 3_600_000
const MAX_LISTED = 8

// Saved before the health check joined the scheduled wake (WHR-341): its own
// interval (`health`, HEALTH_EVERY when unset, or 'off') becomes Every when
// shorter, or when Every was unset; off leaves Every as it was. Once (CoordinatorRecord.oneWake).
const minutes = (d: string) => Number.parseInt(d) * (d.endsWith('h') ? 60 : 1)
export function oneSchedule(ap: Autopilot & { health?: string }): Autopilot {
  const { health, ...rest } = ap
  const h = health || HEALTH_EVERY
  return h === 'off' || (rest.every && minutes(rest.every) <= minutes(h)) ? rest : { ...rest, every: h }
}

export const HEALTH_ACK = 'If none of this needs you, ack at once, with no further work.'

const list = (items: string[]) =>
  `${items.slice(0, MAX_LISTED).join('; ')}${items.length > MAX_LISTED ? `; and ${items.length - MAX_LISTED} more` : ''}.`
const firstLine = (s?: string) => s?.split('\n')[0]

// The summary's lines since the last check (`seen`: each task's status then).
// idleMachines: the project's machines with no agent at work, by name; adopted: the
// repositories a workspace adopted since (adoptedSince). Empty: nothing to say.
export function healthSummary(tasks: Task[], seen: Record<string, TaskStatus>, now: number, idleMachines: string[], adopted: string[] = []): string[] {
  const name = (t: Task, why?: string) => `${t.id} (${t.title})${why ? `: ${why}` : ''}`
  const done = tasks.filter(t => taskStatus(t) === 'done' && seen[t.id] !== 'done').map(t => name(t))
  const user = tasks.filter(t => ['waiting', 'ready'].includes(taskStatus(t)))
    .map(t => name(t, firstLine(t.state === 'waiting' ? t.waiting ?? t.stopped?.why : t.step?.yourTurn?.badge)))
  const stuck = tasks.filter(t => taskStatus(t) === 'stalled' && t.stall && now - t.stall.since >= STUCK_LONG_MS)
    .map(t => name(t, `${firstLine(t.stall!.reason)}, for ${Math.floor((now - t.stall!.since) / 3_600_000)} h`))
  const todo = busyQueue(tasks).length
  const lines = [
    done.length ? `Done since the last check: ${list(done)}` : '',
    user.length ? `Waiting for the user: ${list(user)}` : '',
    stuck.length ? `Stuck for over ${STUCK_LONG_MS / 3_600_000} h: ${list(stuck)}` : '',
    adopted.length ? `Repositories adopted since the last check: ${list(adopted)}` : '',
    todo && idleMachines.length ? `Machines idle while ${todo} to-do task${todo > 1 ? 's' : ''} wait${todo > 1 ? '' : 's'}: ${list(idleMachines)}` : '',
  ].filter(Boolean)
  return lines.length ? [...lines, HEALTH_ACK] : []
}

// Sent again with the same lines at most this often.
export const HEALTH_REPEAT_MS = 12 * 3_600_000
// The last check sent: its lines and when.
export interface HealthSent { lines: string[], at: number }
// A summary whose every line the last one sent already had, within 12 h: skipped.
export const healthRepeats = (lines: string[], sent: HealthSent | undefined, now: number) =>
  !!sent && now - sent.at < HEALTH_REPEAT_MS && lines.every(l => sent.lines.includes(l))
