// A coordinator's autopilot: what wakes it on its own, its goal and its
// limits, stored with the coordinator. Only the user changes it (Settings, the
// passkey session); the coordinator reads it with `wherdr pm autopilot show`.
import { byBoardOrder } from './boardOrder'
import type { Run, Task } from './run'
import type { PlannedStep } from './steps'
import { chainState } from './advance'
import { resumeWait } from './recovery'
import { escalated, recovering } from './incident'
import { parseSchedule } from './schedule'
import type { PaceVerdict } from './pacing'
import { pacedStart, paceRefusal } from './pace'
import { engineOwns } from './selfFix'

// Routine events: off by default, the user turns them on in the Autopilot tab.
export const AUTOPILOT_EVENTS = ['added', 'done', 'stuck', 'ready'] as const
export type AutopilotEvent = typeof AUTOPILOT_EVENTS[number]
// What needs judgment wakes the coordinator whatever its events: an agent's
// question (a permission request stays the user's) and the choice after N send-backs.
export type JudgmentEvent = 'question' | 'decide'

export interface Autopilot {
  on: boolean
  goal: string
  every?: string // duration (30m, 2h): a wake with the goal, in hours
  at?: string // fixed times (daily 08:00, mon,thu 09:00, a cron): a wake with the goal, too
  events: AutopilotEvent[]
  perDay: number | null // tasks started per day; null: no daily limit
  atOnce: number | null // tasks working at once (waiting and ready ones take no slot); null: Auto, as many as the machines take
  hours?: { from: number, to: number } // local hours, to excluded; from > to spans midnight
  lookForWork?: true // keep the scheduled wakes when there is nothing to do (goals that add their own tasks)
  lookPerDay?: number // with lookForWork: tasks those wakes may add a day (LOOK_PER_DAY when unset)
  keepBusy?: false // Keep the board busy, on unless turned off: the engine starts the next to-do task itself (busyQueue)
  health?: string // the health check's interval (30m, 3h), or 'off'; HEALTH_EVERY when unset (health.ts)
}

export const LOOK_PER_DAY = 3
export const MAX_PER_DAY = 1000

// A project with no saved autopilot (one added before Auto) keeps 10 a day and
// 2 at once; a new one is saved with no daily limit and Auto: the account's pace
// and the machines' room still hold its automatic work.
export const DEFAULT_AUTOPILOT: Autopilot = { on: false, goal: '', events: [], perDay: 10, atOnce: 2 }
export const NEW_AUTOPILOT: Autopilot = { ...DEFAULT_AUTOPILOT, perDay: null, atOnce: null }
// Saved before routine events went off by default (WHR-161): the old default
// events, done and stuck, are dropped once (CoordinatorRecord.quiet marks it).
export const OLD_DEFAULT_EVENTS: AutopilotEvent[] = ['done', 'stuck']
export const quietEvents = (ap: Autopilot): Autopilot =>
  ap.events.length === OLD_DEFAULT_EVENTS.length && OLD_DEFAULT_EVENTS.every(e => ap.events.includes(e)) ? { ...ap, events: [] } : ap
// Still on those older defaults: the Autopilot tab hints they can be cleared.
export const oldDefaults = (ap: Autopilot) => ap.perDay === DEFAULT_AUTOPILOT.perDay && ap.atOnce === DEFAULT_AUTOPILOT.atOnce

// The user's settings, checked. Unknown fields dropped.
export function cleanAutopilot(raw: unknown): { autopilot: Autopilot } | { error: string } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const int = (v: unknown, max: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max ? v as number : null)
  const goal = typeof o.goal === 'string' ? o.goal.trim() : ''
  if (goal.length > 2000) return { error: 'goal: 2000 characters at most' }
  const duration = (v: unknown) => typeof v === 'string' && /^\d{1,4}[mh]$/.test(v) && Number.parseInt(v) > 0
  if (o.every !== undefined && o.every !== '' && !duration(o.every)) return { error: 'every: a duration like 30m or 2h' }
  const health = typeof o.health === 'string' ? o.health.trim() : ''
  if (o.health !== undefined && health !== '' && health !== 'off' && !duration(health)) return { error: 'health: a duration like 3h, or off' }
  const at = typeof o.at === 'string' ? o.at.trim() : ''
  const s = at ? parseSchedule(at) : null
  if (s && ('error' in s || 'every' in s)) return { error: 'at: fixed times like daily 08:00, mon,thu 09:00 or a cron' }
  const events = Array.isArray(o.events) ? o.events : []
  if (!events.every(e => (AUTOPILOT_EVENTS as readonly unknown[]).includes(e))) return { error: `events: ${AUTOPILOT_EVENTS.join(', ')}` }
  // Tasks / day left empty: no daily limit (null).
  const perDay = o.perDay === null || o.perDay === '' ? null : int(o.perDay, MAX_PER_DAY), atOnce = o.atOnce === null ? null : int(o.atOnce, 20)
  if ((perDay === null && o.perDay !== null && o.perDay !== '') || (atOnce === null && o.atOnce !== null)) return { error: `perDay (0-${MAX_PER_DAY}, or null for no limit) and atOnce (0-20, or null for Auto) are whole numbers` }
  const lookPerDay = o.lookPerDay === undefined ? undefined : int(o.lookPerDay, 20)
  if (lookPerDay === null) return { error: 'lookPerDay: a whole number, 0-20' }
  const h = o.hours as { from?: unknown, to?: unknown } | undefined
  if (h !== undefined && h !== null && (int(h.from, 23) === null || int(h.to, 24) === null || h.from === h.to)) return { error: 'hours: from 0-23, to 0-24, not equal' }
  return { autopilot: {
    on: o.on === true, goal, events: [...new Set(events as AutopilotEvent[])], perDay, atOnce,
    ...(typeof o.every === 'string' && o.every ? { every: o.every } : {}),
    ...(at ? { at } : {}),
    ...(h ? { hours: { from: h.from as number, to: h.to as number } } : {}),
    ...(o.lookForWork === true ? { lookForWork: true as const, lookPerDay: lookPerDay ?? LOOK_PER_DAY } : {}),
    ...(o.keepBusy === false ? { keepBusy: false as const } : {}),
    ...(health ? { health } : {}),
  } }
}

// Keep the board busy: with the autopilot on, unless the user turned it off.
export const keepsBusy = (ap: Autopilot | undefined) => !!ap?.on && ap.keepBusy !== false

// The to-do tasks the engine starts by itself to keep the board busy, in
// board order (boardOrder.ts: the coordinator's order, then oldest first). A chained task is startChained's (it waits for
// its 'after'), a start held for room startHeld's.
// A task behind another one's files starts from startFileWaits (pmFiles.ts).
export const busyQueue = (tasks: Task[]) =>
  tasks.filter(t => t.state === 'todo' && !t.after && !t.held && !t.sameFiles && !t.step?.started).sort(byBoardOrder)

// The goal as a sentence in a wake's text: one final period, never two.
export const sentence = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`)

export function inHours(hours: Autopilot['hours'], d: Date) {
  if (!hours) return true
  const h = d.getHours()
  return hours.from < hours.to ? h >= hours.from && h < hours.to : h >= hours.from || h < hours.to
}

// Where a task stands for the autopilot.
// stalled: working, nothing moves (blocked.ts); it still holds its slot.
// One the engine resumes after an incident (recovery.ts) is working: not stuck, not the user's.
export type TaskStatus = 'todo' | 'working' | 'stalled' | 'waiting' | 'ready' | 'done'
export const taskStatus = (t: Task): TaskStatus =>
  t.step?.done ? 'done' : recovering(t) ? 'working' : t.state === 'waiting' ? 'waiting' : t.step?.yourTurn ? 'ready' : t.state === 'working' && t.stall ? 'stalled' : t.state

// A working task whose step holds no agent (a PR or merge waiting for checks
// or the queue, a user step) takes no slot, unless the engine handed its
// worker work on its own (a catch-up, red CI). Without its plan: it holds one.
export const holdsSlot = (t: Task, plan?: Pick<PlannedStep, 'holder'>[]) =>
  !plan || !t.step || !!t.step.agent || (plan[t.step.at]?.holder ?? 'none') !== 'none'
export type SlotOf = (t: Task) => boolean

// What is left of today's limits. Started today: tasks whose first worker run
// started since local midnight. Working: only tasks that hold a slot (holds:
// holdsSlot with each task's plan).
export function limitsLeft(ap: Autopilot, tasks: Task[], runs: Run[], now: number, holds: SlotOf = () => true) {
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const ids = new Set(tasks.map(t => t.id))
  const first = new Map<string, number>()
  for (const r of runs) if (ids.has(r.task) && r.role === 'worker') first.set(r.task, Math.min(first.get(r.task) ?? Infinity, r.startedAt))
  const started = [...first.values()].filter(at => at >= midnight).length
  const working = tasks.filter(t => ['working', 'stalled'].includes(taskStatus(t)) && holds(t)).length
  return { started, perDay: ap.perDay, startLeft: Math.max(0, Math.min((ap.perDay ?? Infinity) - started, (ap.atOnce ?? Infinity) - working)), working, atOnce: ap.atOnce }
}

// The autopilot limit one more start goes past now, if any: its refusal, and
// the word a user's start gets for going on anyway.
function limitHit(ap: Autopilot, tasks: Task[], runs: Run[], now: number, holds?: SlotOf) {
  const l = limitsLeft(ap, tasks, runs, now, holds)
  if (l.perDay !== null && l.started >= l.perDay) return { refusal: `Today's limit is reached (${l.perDay} tasks started)`, past: `past the autopilot's limit of ${l.perDay} tasks a day` }
  if (l.atOnce !== null && l.working >= l.atOnce) return { refusal: `${l.working} tasks already work at once (limit ${l.atOnce})`, past: `past the autopilot's limit of ${l.atOnce} at once` }
  if (!inHours(ap.hours, new Date(now))) return { refusal: 'Outside the autopilot\'s hours', past: 'outside the autopilot\'s hours' }
}

// Why the autopilot may not start one more task now, or undefined. `pace`:
// the verdict of the worker's account, given only for automatic work; while
// its account burns, tasks at once are Auto (the machines' room decides).
export function startRefusal(ap: Autopilot, tasks: Task[], runs: Run[], now: number, pace?: PaceVerdict, holds?: SlotOf): string | undefined {
  return limitHit(pace?.go && pace.burning ? { ...ap, atOnce: null } : ap, tasks, runs, now, holds)?.refusal ?? paceRefusal(pace)
}

// A start the user asked for goes past the autopilot's limits: the word its
// output gives ('past the autopilot's limit of 3 at once'), or undefined.
// It still counts in the day's starts and at once, so automatic work sees it.
export const pastLimit = (ap: Autopilot | undefined, tasks: Task[], runs: Run[], now: number, holds?: SlotOf) =>
  limitHit(ap ?? DEFAULT_AUTOPILOT, tasks, runs, now, holds)?.past

// The task log's line for each start of the autopilot's own (the Autopilot tab's timeline reads them).
// A launch not confirmed yet (no terminal) gets UNCONFIRMED instead, never counted.
export const AUTOPILOT_STARTED = { busy: 'started by the autopilot: ', wake: 'started the task in a wake', room: 'started: there is room' } as const
export const UNCONFIRMED = 'start sent, not confirmed yet (its terminal is not seen)'

// Starts a stopped task may have had for a wake to start it again.
export const WAKE_RETRIES = 2

// Why the coordinator (or the engine, for a chained task) may not start
// `task` now, or undefined. In a wake, only with the autopilot on, within its
// limits and hours; the user's turn goes past them (pastLimit says so), the
// engine's chained start does not. A task stopped on a failure starts again
// too, from its step; in a wake only while it has had few worker runs.
// `pace`: the worker's account verdict, held to only for automatic work
// (pacedStart); `engine`: the engine starts it, after its chain.
export function coordinatorStartRefusal(ap: Autopilot | undefined, task: Task, tasks: Task[], runs: Run[], now: number, wake: boolean, { pace, engine, holds }: { pace?: PaceVerdict, engine?: boolean, holds?: SlotOf } = {}): string | undefined {
  const stopped = task.state === 'waiting' && !task.waitKind && !task.step?.done
  if (task.state !== 'todo' && !stopped) return `${task.id} is not to do (${taskStatus(task)})`
  // Starts, not attempts: an agent that exits at once gets a second run in the same start.
  const tries = runs.filter(r => r.task === task.id && r.role === 'worker' && r.attempt === 1).length
  if (stopped && wake && tries >= WAKE_RETRIES) return `${task.id} already ran ${tries} times: starting it again is the user's call`
  const chain = task.after ? chainState(task, tasks) : 'go'
  if (chain !== 'go') return chain && 'wait' in chain ? chain.wait : chain ? resumeWait(chain.resumes) : `${task.id} starts after ${task.after}, which is not done`
  if (wake && !ap?.on) return 'A task starts only on a request from the user, sent from wherdr, or in a wake with the autopilot on'
  if (!wake && !engine) return
  const paced = pacedStart(task, engine ? 'engine' : 'wake')
  return startRefusal(ap ?? DEFAULT_AUTOPILOT, tasks, runs, now, paced ? pace : undefined, holds)
}

// What keeping the board busy starts next in a project (its tasks): the
// next to-do task, or why none starts now (off, nothing to do, a limit, the
// hours, the pace). Room on a machine is placement's, checked by the engine.
export function busyNext(ap: Autopilot | undefined, tasks: Task[], runs: Run[], now: number, { pace, holds }: { pace?: PaceVerdict, holds?: SlotOf } = {}): { task: Task } | { why: string } {
  if (!keepsBusy(ap)) return { why: ap?.on ? 'Keep the board busy is off' : 'The autopilot is off' }
  const task = busyQueue(tasks)[0]
  if (!task) return { why: 'No task to do' }
  const why = coordinatorStartRefusal(ap, task, tasks, runs, now, true, { pace, holds })
  return why ? { why } : { task }
}

// The coordinator's last wake: when, and where its tasks stood then.
export interface LastWake { at?: number, seen?: Record<string, TaskStatus> }

// Nothing for a scheduled wake to do: every task done (none under way, to do,
// waiting for the user or ready for them) and nothing changed since the
// coordinator's last wake (no task added, removed or moved, no message of the
// user). Never known before a first wake.
export function nothingToDo(tasks: Task[], last: LastWake, userAt?: number) {
  if (!last.seen || (userAt ?? 0) > (last.at ?? 0)) return false
  const ids = Object.keys(last.seen)
  return tasks.length === ids.length && tasks.every(t => taskStatus(t) === 'done' && last.seen![t.id] === 'done')
}

// Nothing a scheduled wake could act on changed since the last wake: every
// task where it stood then (no new block, no answer, none added or removed),
// no message of the user, and no to-do task startable now (each waits for its
// after, its files, room or a machine; with Keep the board busy on, the
// engine starts the others itself).
export function unchanged(ap: Autopilot, tasks: Task[], last: LastWake, userAt?: number) {
  if (!last.seen || (userAt ?? 0) > (last.at ?? 0) || tasks.length !== Object.keys(last.seen).length) return false
  return tasks.every(t => last.seen![t.id] === taskStatus(t)) && (keepsBusy(ap) || !busyQueue(tasks).length)
}

// A scheduled wake with nothing to do: skipped ('idle'), unless the user asked
// it to look for new work ('look'), within the tasks those wakes may add a
// day ('limit' once reached: asleep until tomorrow). 'send': there is work.
// 'waits': tasks are left, but nothing it could act on changed: skipped.
// 'paced': there is work, but the worker's account is ahead of its pace (a
// scheduled wake is automatic work): skipped too.
export type ScheduledWake = 'send' | 'look' | 'idle' | 'limit' | 'waits' | 'paced'
export function scheduledWake(ap: Autopilot, tasks: Task[], last: LastWake, userAt: number | undefined, lookAdded: number, pace?: PaceVerdict): ScheduledWake {
  const kind = !nothingToDo(tasks, last, userAt) ? (unchanged(ap, tasks, last, userAt) ? 'waits' : 'send') : !ap.lookForWork ? 'idle' : lookAdded >= (ap.lookPerDay ?? LOOK_PER_DAY) ? 'limit' : 'look'
  return (kind === 'send' || kind === 'look') && pace && !pace.go ? 'paced' : kind
}

// Skipped: the slot counts as run, the paid turn is saved.
export const skippedWake = (k: ScheduledWake | null) => k === 'idle' || k === 'limit' || k === 'waits' || k === 'paced'
// Why, in `autopilot show`.
export const SKIP_WHY: Record<'idle' | 'limit' | 'waits' | 'paced', string> = {
  idle: 'nothing to do',
  limit: 'today\'s limit of new work is reached',
  waits: 'nothing changed since the last wake: no task startable now, no new block, no answer',
  paced: 'the worker\'s account is ahead of its pace',
}

// The reason a look-for-new-work wake starts with: its turn counts the tasks it adds.
export const LOOK_REASON = 'Nothing is under way: look for new work toward your goal.'

// A count of the day (local): scheduled wakes skipped, tasks added by look wakes.
export interface DayCount { day: string, n: number }
export const dayKey = (now: number) => new Date(now).toDateString()
export const today = (s: DayCount | undefined, now: number) => (s?.day === dayKey(now) ? s.n : 0)
export const bump = (s: DayCount | undefined, now: number): DayCount => ({ day: dayKey(now), n: today(s, now) + 1 })

// `task add` in a look wake's turn: within the tasks those wakes may add today.
export const lookAddRefusal = (ap: Autopilot | undefined, added: number) => {
  const max = ap?.lookPerDay ?? LOOK_PER_DAY
  return added >= max ? `Today's limit of new work is reached (${max} tasks added by look-for-new-work wakes): back to sleep until tomorrow` : undefined
}

// Added by this coordinator (`by`: how it signs the task log): `addedBy`, or
// for a task made before it, the first log entry ("added the task").
export const addedBySelf = (t: Pick<Task, 'addedBy' | 'log'>, key: string, by: string) =>
  t.addedBy !== undefined ? t.addedBy === key : t.log?.[0]?.by === by && t.log[0].text.startsWith('added the task')

// The events since the last tick: tasks added (by someone else than this
// coordinator, `self`), done, stuck (waiting, stalled, an action refused or
// failing) or ready, among those the autopilot wakes for; and, always, an
// agent's question or a choice after N send-backs (JudgmentEvent).
// `seen`: each task's last status. A stopped task is not stuck: someone chose to stop it.
// Nor is a block the engine fixes itself (selfFix.ts): it wakes the coordinator once it gives up;
// nor a task stopped again right after the engine resumed it: the engine woke the coordinator for it (recovery.ts).
// skipped: questions not woken for, already answered by a tell (Task.answered).
export function autopilotEvents(ap: Autopilot, tasks: Task[], seen: Record<string, TaskStatus>, self?: { key: string, by: string }) {
  const now: Record<string, TaskStatus> = {}, reasons: string[] = [], skipped: string[] = []
  for (const t of tasks) {
    const s = now[t.id] = taskStatus(t)
    const failed = s === 'ready' && t.step?.yourTurn?.reason === 'action'
    const moved = t.id in seen && seen[t.id] !== s
    // A question a coordinator's tell answered, back while its agent's label stays: no second wake.
    const again = s === 'waiting' && t.waitKind === 'question' && !!t.answered
    if (moved && again) skipped.push(`${t.id} (${t.title}): its question was answered already`)
    const judgment: JudgmentEvent | undefined = !moved || t.stopped || again ? undefined
      : s === 'waiting' && t.waitKind === 'question' ? 'question' : s === 'ready' && t.step?.yourTurn?.reason === 'rounds' ? 'decide' : undefined
    const ev: AutopilotEvent | undefined = !(t.id in seen) ? (self && addedBySelf(t, self.key, self.by) ? undefined : 'added') : !moved || judgment ? undefined
      : s === 'waiting' || s === 'stalled' || failed ? (t.stopped || engineOwns(t) || escalated(t) ? undefined : 'stuck') : s === 'done' || s === 'ready' ? s : undefined
    const why = s === 'stalled' ? t.stall?.reason : failed || judgment === 'decide' ? t.step?.yourTurn?.badge : t.waiting
    const kind = judgment ?? (ev && ap.events.includes(ev) ? ev : undefined)
    if (kind) reasons.push(`${t.id} (${t.title}): ${kind}${kind !== 'added' && kind !== 'done' && kind !== 'ready' && why ? `: ${why.split('\n')[0]}` : ''}`)
  }
  return { seen: now, reasons, skipped }
}

// Commands that are the user's only, whatever the turn: the coordinator's
// token never merges, approves, changes settings or its own limits.
export const USER_ONLY: Record<string, string> = {
  approve: 'Approving is the user\'s: it waits in their Decisions',
  merge: 'Merging is the user\'s gesture, or the engine\'s where the branch rule allows it',
  settings: 'Settings change only in wherdr, by the user',
  'autopilot set': 'The autopilot\'s goal and limits change only in wherdr, by the user',
  pacing: 'The pace of each quota account changes only in wherdr, by the user',
  ...Object.fromEntries(['add', 'set', 'edit', 'remove', 'on', 'off', 'run'].map(v => [`automation ${v}`, 'Only the user switches an automation on or off or runs it, in wherdr: propose a new one, a change or a removal with automation propose'])),
}

// `task add`: on the user's request sent from wherdr, or in a wake with the autopilot on.
export const addRefusal = (ap: Autopilot | undefined, wake: boolean) =>
  wake && !ap?.on ? 'A task is added only on a request from the user, sent from wherdr, or in a wake with the autopilot on' : undefined

// What a wake may fix with `tell --fix`: a mechanical block, never a decision.
export const FIX_KINDS = ['base', 'ci', 'machine', 'stall'] as const
export type FixKind = typeof FIX_KINDS[number]
export const FIX_TEXT: Record<FixKind, string> = {
  base: 'merge the base into the branch and solve the conflict',
  ci: 'fix a red CI',
  machine: 'retry after a machine problem (disk, memory)',
  stall: 'restart a stalled agent',
}
// Fixes a wake may make per task and step; past them, the block is the user's.
export const FIXES_PER_STEP = 2
// The task's step, as `fixes` counts it: a new step starts a new count.
const stepKey = (t: Pick<Task, 'step'>) => `${t.step?.at ?? 0}:${t.step?.since ?? 0}`
export const fixesInStep = (t: Pick<Task, 'step' | 'fixes'>) => t.fixes?.step === stepKey(t) ? t.fixes.n : 0
export const countFix = (t: Pick<Task, 'step' | 'fixes'>) => ({ step: stepKey(t), n: fixesInStep(t) + 1 })

// `tell <task>`: in a wake, only to answer an agent's question, or with
// `fix` (a project coordinator, its autopilot on) to unblock a mechanical
// block, twice per task and step. A permission request stays the user's.
export function tellRefusal(task: Pick<Task, 'state' | 'waitKind' | 'step' | 'fixes' | 'stopped'>, wake: boolean, fix?: { autopilot?: Autopilot, main: boolean }): string | undefined {
  if (task.waitKind === 'permission') return 'A permission request is the user\'s to answer'
  if (!wake) return
  if (fix) {
    if (fix.main) return 'In a wake, only the project\'s coordinator fixes its tasks\' blocks'
    if (!fix.autopilot?.on) return 'In a wake, a block is fixed only with the autopilot on'
    // Going on after a stop is `task start`'s, with its checks; a finished task has nothing to fix.
    if (task.stopped) return 'The task was stopped: --fix does not start it again (use task start)'
    if (task.step?.done) return 'The task is done: nothing to fix'
    if (fixesInStep(task) >= FIXES_PER_STEP) return `Already fixed ${FIXES_PER_STEP} times in this step: this block is the user's now, tell them`
    return
  }
  if (!(task.state === 'waiting' && task.waitKind === 'question')) return 'In a wake, tell only answers an agent\'s question, or fixes a mechanical block with --fix'
}
