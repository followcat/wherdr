// A project's automations: each firing adds an ordinary task from the
// project's template and starts it at once; nothing goes through the
// coordinator. Fired by a schedule (schedule.ts) or by an event on the
// project's tasks. Stored in DATA_DIR/projects/automations/<KEY>.json; only
// the user changes them, the coordinator reads them (`wherdr pm automation`).
import type { Task } from './run'
import { parseSchedule } from './schedule'

export const AUTOMATION_EVENTS = ['added', 'approval', 'review-failed', 'failed', 'needs-you', 'merged'] as const
export type AutomationEvent = typeof AUTOMATION_EVENTS[number]

export interface Firing { at: number, by: 'schedule' | 'event' | 'user', cause?: string, task?: string, error?: string }

export interface Automation {
  id: string
  name: string
  prompt: string // the task's description
  type?: string // a task type of the template; none: its first
  on: boolean
  schedule?: string
  event?: AutomationEvent
  filter?: string // glob on the task's title, or its branch (task/<id>): docs*, task/W3-*
  last?: number // the last firing, or when it was switched on: missed slots count from here
  firings?: Firing[] // newest last
}

export const FIRINGS_KEPT = 20
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
export const automationId = (name: string) => name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'automation'

// The user's form, checked. `old`: the automation it changes (keeps its
// firings; a new schedule or a switch-on counts missed slots from `now`).
export function cleanAutomation(raw: unknown, old: Automation | undefined, now: number): { automation: Automation } | { error: string } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '')
  const name = str('name'), prompt = str('prompt'), type = str('type'), schedule = str('schedule'), event = str('event'), filter = str('filter')
  if (!name || name.length > 80) return { error: 'name: 1 to 80 characters' }
  if (!prompt || prompt.length > 20000) return { error: 'prompt: 1 to 20000 characters' }
  if (!!schedule === !!event) return { error: 'a schedule or an event, one of the two' }
  if (schedule) { const s = parseSchedule(schedule); if ('error' in s) return { error: `schedule: ${s.error}` } }
  if (event && !(AUTOMATION_EVENTS as readonly string[]).includes(event)) return { error: `event: ${AUTOMATION_EVENTS.join(', ')}` }
  if (filter.length > 100) return { error: 'filter: 100 characters at most' }
  const id = old?.id ?? (typeof o.id === 'string' && ID_RE.test(o.id) ? o.id : automationId(name))
  const on = o.on === true
  const fresh = !old || (on && !old.on) || (old.schedule ?? '') !== schedule
  return { automation: {
    id, name, prompt, on,
    ...(type ? { type } : {}),
    ...(schedule ? { schedule } : { event: event as AutomationEvent, ...(filter ? { filter } : {}) }),
    ...(fresh ? { last: now } : old?.last !== undefined ? { last: old.last } : {}),
    ...(old?.firings ? { firings: old.firings } : {}),
  } }
}

// `feature/*`: * is any run of characters, the rest literal, case ignored.
export const globMatch = (glob: string, s: string) =>
  new RegExp(`^${glob.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(s)

// Where a task stands for the events, compared tick to tick.
export interface Mark { turn?: string, failed?: boolean, needs?: boolean, rounds: number, merged?: boolean }
export function markOf(t: Task): Mark {
  const s = t.step, rounds = Object.values(s?.rounds ?? {}).reduce((a, b) => a + b, 0)
  // Stopped by the user or the coordinator: their choice, neither a failure nor a new need.
  if (t.stopped) return { rounds, ...(s?.yourTurn?.reason === 'user' ? { turn: s.yourTurn.badge } : {}) }
  const failed = (t.state === 'waiting' && !t.waitKind) || s?.yourTurn?.reason === 'action'
  return {
    rounds,
    ...(s?.yourTurn?.reason === 'user' ? { turn: s.yourTurn.badge } : {}),
    ...(failed ? { failed } : {}),
    ...(s?.yourTurn || t.state === 'waiting' ? { needs: true } : {}),
    // Done with a PR: merged. A study task ends done without one.
    ...(s?.done && !s.abandoned && (t.links ?? []).some(l => /\/pull\/\d+/.test(l.url)) ? { merged: true } : {}),
  }
}

export interface TaskEvent { event: AutomationEvent, task: Task }

// The events since the last tick; `seen` undefined (first look) gives none.
// A task an automation added gives no "added", so that no automation feeds itself.
export function taskEvents(tasks: Task[], seen: Record<string, Mark> | undefined) {
  const now: Record<string, Mark> = {}, events: TaskEvent[] = []
  for (const t of tasks) {
    const m = now[t.id] = markOf(t), was = seen?.[t.id]
    if (!seen) continue
    const ev = (e: AutomationEvent) => events.push({ event: e, task: t })
    if (!was) { if (!t.auto) ev('added'); continue }
    if (m.turn && m.turn !== was.turn) ev('approval')
    if (m.rounds > was.rounds) ev('review-failed')
    if (m.failed && !was.failed) ev('failed')
    if (m.needs && !was.needs) ev('needs-you')
    if (m.merged && !was.merged) ev('merged')
  }
  return { seen: now, events }
}

// Does this event fire this automation? Never on a task an automation added:
// two automations cannot feed each other.
export const firesOn = (a: Automation, e: TaskEvent) =>
  a.on && a.event === e.event && !e.task.auto
  && (!a.filter || globMatch(a.filter, e.task.title) || globMatch(a.filter, `task/${e.task.id}`))

// The task a firing adds: its title says which automation and when.
export function firingTask(a: Automation, project: string, firstType: string, now: number, cause?: string) {
  const d = new Date(now), pad = (n: number) => String(n).padStart(2, '0')
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return {
    project, title: `${a.name} · ${when}`.slice(0, 200), type: a.type || firstType, auto: a.id, origin: 'automation' as const,
    description: cause ? `${a.prompt}\n\nTriggered by ${cause}.` : a.prompt,
  }
}

export const addFiring = (a: Automation, f: Firing): Automation =>
  ({ ...a, last: f.by === 'user' ? a.last : f.at, firings: [...(a.firings ?? []), f].slice(-FIRINGS_KEPT) })

// `wherdr pm automation list`: one line each.
export const automationLine = (a: Automation) =>
  `${a.on ? 'on ' : 'off'}  ${a.id}  ${a.schedule ?? `on ${a.event}${a.filter ? ` (${a.filter})` : ''}`}  ${a.name}${a.firings?.length ? `  · last ${new Date(a.firings.at(-1)!.at).toISOString()}${a.firings.at(-1)!.task ? ` ${a.firings.at(-1)!.task}` : ''}` : ''}`
