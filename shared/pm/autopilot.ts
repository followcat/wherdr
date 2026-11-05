// A coordinator's autopilot: what wakes it on its own, its goal and its
// limits, stored with the coordinator. Only the user changes it (Settings, the
// passkey session); the coordinator reads it with `wherdr pm autopilot show`.
import type { Run, Task } from './run'

export const AUTOPILOT_EVENTS = ['added', 'done', 'stuck', 'ready'] as const
export type AutopilotEvent = typeof AUTOPILOT_EVENTS[number]

export interface Autopilot {
  on: boolean
  goal: string
  every?: string // duration (30m, 2h): a wake with the goal, in hours
  events: AutopilotEvent[]
  perDay: number // tasks started per day
  atOnce: number // tasks working at once (waiting and ready ones take no slot)
  hours?: { from: number, to: number } // local hours, to excluded; from > to spans midnight
}

export const DEFAULT_AUTOPILOT: Autopilot = { on: false, goal: '', events: ['done', 'stuck'], perDay: 10, atOnce: 2 }

// The user's settings, checked. Unknown fields dropped.
export function cleanAutopilot(raw: unknown): { autopilot: Autopilot } | { error: string } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const int = (v: unknown, max: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max ? v as number : null)
  const goal = typeof o.goal === 'string' ? o.goal.trim() : ''
  if (goal.length > 2000) return { error: 'goal: 2000 characters at most' }
  if (o.every !== undefined && o.every !== '' && !(typeof o.every === 'string' && /^\d{1,4}[mh]$/.test(o.every) && Number.parseInt(o.every) > 0)) return { error: 'every: a duration like 30m or 2h' }
  const events = Array.isArray(o.events) ? o.events : []
  if (!events.every(e => (AUTOPILOT_EVENTS as readonly unknown[]).includes(e))) return { error: `events: ${AUTOPILOT_EVENTS.join(', ')}` }
  const perDay = int(o.perDay, 100), atOnce = int(o.atOnce, 20)
  if (perDay === null || atOnce === null) return { error: 'perDay (0-100) and atOnce (0-20) are whole numbers' }
  const h = o.hours as { from?: unknown, to?: unknown } | undefined
  if (h !== undefined && h !== null && (int(h.from, 23) === null || int(h.to, 24) === null || h.from === h.to)) return { error: 'hours: from 0-23, to 0-24, not equal' }
  return { autopilot: {
    on: o.on === true, goal, events: [...new Set(events as AutopilotEvent[])], perDay, atOnce,
    ...(typeof o.every === 'string' && o.every ? { every: o.every } : {}),
    ...(h ? { hours: { from: h.from as number, to: h.to as number } } : {}),
  } }
}

export function inHours(hours: Autopilot['hours'], d: Date) {
  if (!hours) return true
  const h = d.getHours()
  return hours.from < hours.to ? h >= hours.from && h < hours.to : h >= hours.from || h < hours.to
}

// Where a task stands for the autopilot.
export type TaskStatus = 'todo' | 'working' | 'waiting' | 'ready' | 'done'
export const taskStatus = (t: Task): TaskStatus =>
  t.step?.done ? 'done' : t.state === 'waiting' ? 'waiting' : t.step?.yourTurn ? 'ready' : t.state

// What is left of today's limits. Started today: tasks whose first worker run
// started since local midnight. Working: only tasks that hold a slot.
export function limitsLeft(ap: Autopilot, tasks: Task[], runs: Run[], now: number) {
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const ids = new Set(tasks.map(t => t.id))
  const first = new Map<string, number>()
  for (const r of runs) if (ids.has(r.task) && r.role === 'worker') first.set(r.task, Math.min(first.get(r.task) ?? Infinity, r.startedAt))
  const started = [...first.values()].filter(at => at >= midnight).length
  const working = tasks.filter(t => taskStatus(t) === 'working').length
  return { started, perDay: ap.perDay, startLeft: Math.max(0, Math.min(ap.perDay - started, ap.atOnce - working)), working, atOnce: ap.atOnce }
}

// Why the autopilot may not start one more task now, or undefined.
export function startRefusal(ap: Autopilot, tasks: Task[], runs: Run[], now: number): string | undefined {
  const l = limitsLeft(ap, tasks, runs, now)
  if (l.started >= l.perDay) return `Today's limit is reached (${l.perDay} tasks started)`
  if (l.working >= l.atOnce) return `${l.working} tasks already work at once (limit ${l.atOnce})`
  if (!inHours(ap.hours, new Date(now))) return 'Outside the autopilot\'s hours'
}

// The events since the last tick: tasks added, done, stuck (waiting) or
// ready, among those the autopilot wakes for. `seen`: each task's last status.
export function autopilotEvents(ap: Autopilot, tasks: Task[], seen: Record<string, TaskStatus>) {
  const now: Record<string, TaskStatus> = {}, reasons: string[] = []
  for (const t of tasks) {
    const s = now[t.id] = taskStatus(t)
    const ev: AutopilotEvent | undefined = !(t.id in seen) ? 'added' : seen[t.id] === s ? undefined : s === 'waiting' ? 'stuck' : s === 'done' || s === 'ready' ? s : undefined
    if (ev && ap.events.includes(ev)) reasons.push(`${t.id} (${t.title}): ${ev}${ev === 'stuck' && t.waiting ? `: ${t.waiting.split('\n')[0]}` : ''}`)
  }
  return { seen: now, reasons }
}

// Commands that are the user's only, whatever the turn: the coordinator's
// token never merges, approves, changes settings or its own limits.
export const USER_ONLY: Record<string, string> = {
  approve: 'Approving is the user\'s: it waits in their Decisions',
  merge: 'Merging is the user\'s gesture, or the engine\'s where the branch rule allows it',
  settings: 'Settings change only in wherdr, by the user',
  'autopilot set': 'The autopilot\'s goal and limits change only in wherdr, by the user',
}

// `tell <task>`: in a wake, only to answer an agent's question; a permission
// request always stays the user's.
export function tellRefusal(task: Pick<Task, 'state' | 'waitKind'>, wake: boolean): string | undefined {
  if (task.waitKind === 'permission') return 'A permission request is the user\'s to answer'
  if (wake && !(task.state === 'waiting' && task.waitKind === 'question')) return 'In a wake, tell only answers an agent\'s question'
}
