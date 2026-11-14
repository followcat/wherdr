// A project's automations: each firing adds an ordinary task from the
// project's template and starts it at once; nothing goes through the
// coordinator. Fired by a schedule (schedule.ts) or by an event on the
// project's tasks. Stored in DATA_DIR/projects/automations/<KEY>.json. The
// coordinator or Alfred proposes a change (`wherdr pm automation propose`),
// the user accepts or refuses it; the user alone switches one on or off.
import type { Task } from './run'
import { nextRun, parseSchedule } from './schedule'
import { isPrUrl } from './board'

export const AUTOMATION_EVENTS = ['added', 'approval', 'review-failed', 'failed', 'needs-you', 'merged'] as const
export type AutomationEvent = typeof AUTOMATION_EVENTS[number]

// held: its task was added and waits for a machine with room (error says why).
export interface Firing { at: number, by: 'schedule' | 'event' | 'user', cause?: string, task?: string, error?: string, held?: true }

export interface Automation {
  id: string
  name: string
  prompt: string // the task's description
  type?: string // a task type of the template; none: its first
  on: boolean
  schedule?: string
  event?: AutomationEvent
  filter?: string // glob on the task's title, or its branch (task/<id>, or its own): docs*, task/W3-*
  last?: number // the last firing, or when it was switched on: missed slots count from here
  firings?: Firing[] // newest last
}

export const FIRINGS_KEPT = 20
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
export const automationId = (name: string) => name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'automation'

// An automation as an agent wrote it, checked. `old`: the automation it changes (keeps its
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
    ...(s?.done && !s.abandoned && (t.links ?? []).some(l => isPrUrl(l.url)) ? { merged: true } : {}),
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
  && (!a.filter || globMatch(a.filter, e.task.title) || globMatch(a.filter, e.task.branch ?? `task/${e.task.id}`))

// The task a firing adds: its title says which automation and when.
export function firingTask(a: Automation, project: string, firstType: string, now: number, cause?: string) {
  const d = new Date(now), pad = (n: number) => String(n).padStart(2, '0')
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return {
    project, title: `${a.name} · ${when}`.slice(0, 200), type: a.type || firstType, auto: a.id, origin: 'automation' as const, addedBy: 'automation',
    description: cause ? `${a.prompt}\n\nTriggered by ${cause}.` : a.prompt,
  }
}

export const addFiring = (a: Automation, f: Firing): Automation =>
  ({ ...a, last: f.by === 'user' ? a.last : f.at, firings: [...(a.firings ?? []), f].slice(-FIRINGS_KEPT) })

// `wherdr pm automation list`: one line each, then the proposals.
export const proposalLine = (p: AutomationProposal) =>
  `${p.outcome ?? 'waiting for the user'}  ${p.action} ${p.automation.id}  ${new Date(p.at).toISOString()}`
export const automationLine = (a: Automation) =>
  `${a.on ? 'on ' : 'off'}  ${a.id}  ${a.schedule ?? `on ${a.event}${a.filter ? ` (${a.filter})` : ''}`}  ${a.name}${a.firings?.length ? `  · last ${new Date(a.firings.at(-1)!.at).toISOString()}${a.firings.at(-1)!.task ? ` ${a.firings.at(-1)!.task}` : ''}` : ''}`

// A change the coordinator or Alfred proposed, waiting for the user (no
// outcome) or answered. automation: the new one, or the one to remove.
// by: the project's key, or 'main' (Alfred); said: the user's message it follows.
export interface AutomationProposal {
  id: string, project: string, action: 'add' | 'change' | 'remove', automation: Automation, at: number, by: string, said?: string
  outcome?: 'accepted' | 'refused' | 'replaced', answeredAt?: number
}
export const PROPOSALS_KEPT = 10
// In the order proposed, the oldest answered ones dropped past PROPOSALS_KEPT.
function kept(l: AutomationProposal[]) {
  let drop = l.filter(p => p.outcome).length - PROPOSALS_KEPT
  return l.filter(p => !p.outcome || drop-- <= 0)
}

// `automation propose [<id>] [--remove]`: the project's proposals with this one
// added; one still waiting for the same automation is replaced.
export function proposeAutomation(
  file: { automations: Automation[], proposals?: AutomationProposal[] },
  ask: { id?: string, remove?: boolean, raw?: unknown, types: string[] },
  meta: { project: string, by: string, said?: string, now: number },
): { proposal: AutomationProposal, proposals: AutomationProposal[] } | { error: string } {
  const old = ask.id ? file.automations.find(a => a.id === ask.id) : undefined
  if (ask.remove && !old) return { error: `No automation ${ask.id ?? ''}: automation list gives their ids` }
  let automation = old
  if (!ask.remove) {
    const r = cleanAutomation({ ...(ask.raw as object), ...(ask.id ? { id: ask.id } : {}), on: old?.on ?? true }, old, meta.now)
    if ('error' in r) return r
    if (r.automation.type && !ask.types.includes(r.automation.type)) return { error: `type: one of the workflow's task types (${ask.types.join(', ') || 'none yet'})` }
    if (!old && file.automations.some(a => a.id === r.automation.id)) return { error: `An automation is already named ${r.automation.id}: name it to change it` }
    automation = r.automation
  }
  const proposal: AutomationProposal = { id: `${meta.now.toString(36)}${Math.random().toString(36).slice(2, 6)}-${automation!.id}`, project: meta.project, action: ask.remove ? 'remove' : old ? 'change' : 'add', automation: automation!, at: meta.now, by: meta.by, ...(meta.said ? { said: meta.said.slice(0, 500) } : {}) }
  const list = (file.proposals ?? []).map(p => (!p.outcome && p.automation.id === proposal.automation.id ? { ...p, outcome: 'replaced' as const, answeredAt: meta.now } : p))
  return { proposal, proposals: kept([...list, proposal]) }
}

// The user's answer: accepted, the automations as they are now with it applied
// (a new one switched on; a changed one keeps its switch and firings).
export function answerAutomation(file: { automations: Automation[], proposals?: AutomationProposal[] }, id: string, accept: boolean, now: number) {
  const p = file.proposals?.find(x => x.id === id && !x.outcome)
  if (!p) return { error: 'This proposal no longer waits' }
  let automations = file.automations
  if (accept) {
    const old = automations.find(a => a.id === p.automation.id)
    if (p.action === 'add' && old) return { error: `An automation is already named ${old.id}: ask for the change again` }
    if (p.action !== 'add' && !old) return { error: 'This automation was removed since' }
    if (p.action === 'remove') automations = automations.filter(a => a !== old)
    else {
      const r = cleanAutomation({ ...p.automation, on: old?.on ?? true }, old, now)
      if ('error' in r) return r
      automations = old ? automations.map(a => (a === old ? r.automation : a)) : [...automations, r.automation]
    }
  }
  const proposals = kept(file.proposals!.map(x => (x === p ? { ...x, outcome: accept ? 'accepted' as const : 'refused' as const, answeredAt: now } : x)))
  return { automations, proposals }
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const and = (l: (string | number)[]) => l.join(', ').replace(/, ([^,]*)$/, ' and $1')
const clock = (h: number, m: number) => `${h}:${String(m).padStart(2, '0')}`
// k when the list is 0, k, 2k… up to `hi` (a */k field), else 0.
const stepOf = (l: number[], hi: number) => {
  const k = l[1] ?? 0
  return l.length > 1 && l[0] === 0 && k > 1 && l.length === Math.floor(hi / k) + 1 && l.every((v, i) => v === i * k) ? k : 0
}
const span = (l: number[]) => l.length > 1 && l.every((v, i) => !i || v === l[i - 1]! + 1)

// "every weekday at 9:00", "every 15 minutes", "every hour at :30 from 9:00
// to 17:59 on weekdays": a schedule in words, a cron too.
export function scheduleWords(raw: string) {
  const s = parseSchedule(raw)
  if ('error' in s) return raw
  if ('every' in s) {
    const m = s.every / 60_000
    return m % 60 ? `every ${m === 1 ? 'minute' : `${m} minutes`}` : `every ${m === 60 ? 'hour' : `${m / 60} hours`}`
  }
  const { min, hour } = s, d = s.dow?.join(',')
  const allHours = hour.length === 24, hs = stepOf(hour, 23), ms = stepOf(min, 59)
  const week = !s.dow || d === '0,1,2,3,4,5,6' ? '' : d === '1,2,3,4,5' ? 'weekday' : d === '0,6' ? 'Saturday and Sunday' : and(s.dow.map(x => DAY_NAMES[x]!))
  // Both day fields restricted: cron fires on either (schedule.ts), so "or";
  // a weekday list naming every day then makes it daily, the day of month moot.
  const dom = s.dow && !week ? null : s.dom
  const days = dom ? '' : week
  const dates = [dom ? `on day ${and(dom)} of the month${week ? ` or on ${week === 'weekday' ? 'weekdays' : week}` : ''}` : '', s.mon ? `in ${and(s.mon.map(x => MONTHS[x - 1]!))}` : ''].filter(Boolean).join(' ')
  // At set times of the day: "every Monday at 9:00 and 14:00".
  if (min.length === 1 && !allHours && !hs && hour.length <= 4 && !span(hour))
    return [`every ${days || (dom ? '' : 'day')}`.trim(), `at ${and(hour.map(h => clock(h, min[0]!)))}`, dates].filter(x => x && x !== 'every').join(' ')
  const often = min.length === 60 ? 'every minute' : ms ? `every ${ms} minutes`
    : min.length === 1 ? `every ${hs ? `${hs} hours` : 'hour'} at :${String(min[0]).padStart(2, '0')}`
    : `at minutes ${and(min)}`
  const hours = allHours || (min.length === 1 && hs) ? '' : span(hour) ? `from ${clock(hour[0]!, 0)} to ${clock(hour.at(-1)!, 59)}` : hs ? `every ${hs} hours` : `in the hours ${and(hour.map(h => clock(h, 0)))}`
  return [often, hours, days ? `on ${days === 'weekday' ? 'weekdays' : days}` : '', dates].filter(Boolean).join(' ')
}

// When a switched-on schedule fires next (a missed slot: at the next tick), in
// the server's time zone: the server computes it for the tab.
export function nextFiring(a: Automation, now: number) {
  const s = a.on && a.schedule ? parseSchedule(a.schedule) : null
  const n = s && !('error' in s) ? nextRun(s, a.last ?? now) : null
  return n === null ? undefined : Math.max(n, now)
}

// A firing as the timeline shows it: a task added and started, added and
// waiting for room (held), skipped (the pace held it), or failed (a start
// that failed, its task added or not).
export const firingKind = (f: Firing) => (!f.error ? 'fired' : f.held ? 'waits' : !f.task && f.error.startsWith('paced') ? 'skipped' : 'failed')
