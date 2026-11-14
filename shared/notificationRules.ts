// One synchronized policy, evaluated identically by the server and the UI:
// a default for everything, and exceptions to that default.
import type { LinkedCoordinator, MachineLinks } from './boardLinks'
import type { HerdrState, Pane } from './types'
import { machineOf } from './ids'
import { MAIN } from './pm/coordinator'

export const NOTIFICATION_EVENTS = ['needs-you', 'finished', 'message', 'scheduled'] as const
export type NotificationEvent = typeof NOTIFICATION_EVENTS[number]

// One ordered scale, used by the default, the exceptions and the menus.
export const NOTIFICATION_LEVELS = ['muted', 'needs-you', 'finished', 'all'] as const
export type NotificationLevel = typeof NOTIFICATION_LEVELS[number]
export const LEVEL_EVENTS: Record<NotificationLevel, NotificationEvent[]> = {
  'muted': [],
  'needs-you': ['needs-you'],
  'finished': ['needs-you', 'finished'],
  'all': [...NOTIFICATION_EVENTS],
}
// The level these events make, or 'custom' when they match none.
export function levelOf(events: readonly NotificationEvent[]): NotificationLevel | 'custom' {
  const set = new Set(events)
  return NOTIFICATION_LEVELS.find(l => LEVEL_EVENTS[l].length === set.size && LEVEL_EVENTS[l].every(e => set.has(e))) ?? 'custom'
}
// Louder (1), quieter (-1), the same (0) or neither (null: different events).
export function compareEvents(a: readonly NotificationEvent[], b: readonly NotificationEvent[]): 1 | 0 | -1 | null {
  const inA = a.filter(e => !b.includes(e)).length
  const inB = b.filter(e => !a.includes(e)).length
  return inA && inB ? null : inA ? 1 : inB ? -1 : 0
}

export interface NotificationPolicy {
  events: NotificationEvent[]
  // Default: task agents (workers, reviewers, attempts) notify at this level.
  // Exception: its board's task agents follow this exception, not the default.
  subagents: boolean
}
// `coordinator`: id is coordinatorKey(), stable across `coordinator new` and
// restarts. `conversation`: a standalone agent's pane id.
export type NotificationTargetKind = 'coordinator' | 'conversation'
export interface NotificationTarget { kind: NotificationTargetKind, machine: string, id: string, label: string }
export interface NotificationException extends NotificationTarget {
  // null: follows the default once a timed mute ends.
  events: NotificationEvent[] | null
  subagents: boolean
  // A timed mute: silent until then, then `events`.
  until: number | null
}
export interface NotificationSettings {
  version: 2
  default: NotificationPolicy
  exceptions: NotificationException[]
}
export interface NotificationSource {
  machine: string
  project?: string
  conversation?: string
  // Its coordinatorKey() when the conversation is a board coordinator.
  coordinator?: string
  // A task agent (worker, reviewer, attempt, planner).
  subagent?: boolean
  // A task's Herdr session (its coordinators' folder), when the board says.
  session?: string
  // A board event (a task waiting for approval, failed…): never a sub-agent's.
  board?: boolean
}

export const EXCEPTIONS_MAX = 100
export const defaultNotifications = (): NotificationSettings => ({
  version: 2, default: { events: [...LEVEL_EVENTS.finished], subagents: false }, exceptions: [],
})
export const coordinatorKey = (c: Pick<LinkedCoordinator, 'level' | 'repo' | 'session'>) => `${c.session ?? ''}/${c.level}/${c.repo ?? ''}`
// Today's coordinators: Alfred (the main one, MAIN) and one per project, by
// key. One of each across machines and restarts: no session.
export const coordinatorTarget = (project: string) => coordinatorKey(project === MAIN ? { level: 'top' } : { level: 'project', repo: project })
export function parseCoordinatorKey(key: string) {
  const [session = '', level = '', repo = ''] = key.split('/')
  return { session, level: level as LinkedCoordinator['level'], repo: repo || undefined }
}
export const sameNotificationTarget = (a: Pick<NotificationTarget, 'kind' | 'machine' | 'id'>, b: Pick<NotificationTarget, 'kind' | 'machine' | 'id'>) =>
  a.kind === b.kind && a.machine === b.machine && a.id === b.id

const eventsOf = (value: unknown): NotificationEvent[] => Array.isArray(value)
  ? NOTIFICATION_EVENTS.filter(e => value.includes(e)) : []
const validUntil = (v: unknown) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v) && v > 0)
const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max

export function parseNotificationSettings(raw: string | null | undefined): NotificationSettings {
  const fallback = defaultNotifications()
  try {
    const v = JSON.parse(raw || 'null')
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fallback
    if (v.version !== 2) return migrateNotificationSettings(v)
    const d = v.default && typeof v.default === 'object' ? v.default : {}
    const exceptions: NotificationException[] = []
    if (Array.isArray(v.exceptions)) for (const r of v.exceptions.slice(0, EXCEPTIONS_MAX)) {
      if (!r || !['coordinator', 'conversation'].includes(r.kind) || !str(r.machine, 80) || !str(r.id, 512)
        || !str(r.label, 120) || !r.id || !validUntil(r.until) || (r.events !== null && !Array.isArray(r.events))) continue
      addException(exceptions, { kind: r.kind, machine: r.machine, id: r.id, label: r.label,
        events: r.events === null ? null : eventsOf(r.events), subagents: r.subagents === true, until: r.until ?? null })
    }
    return { version: 2, default: { events: Array.isArray(d.events) ? eventsOf(d.events) : fallback.default.events, subagents: d.subagents === true }, exceptions }
  } catch { return fallback }
}
function addException(list: NotificationException[], e: NotificationException) {
  const old = list.findIndex(x => sameNotificationTarget(x, e))
  if (old >= 0) list.splice(old, 1)
  list.push(e)
}

// Settings saved by #156 (machine → project → conversation rules). Machine and
// project rules go; a permanent machine rule becomes the default (it was what
// that machine did), conversation rules stay as exceptions. A conversation
// that is a coordinator is re-keyed on its stable identity by the app.
interface OldRule { scope?: unknown, machine?: unknown, id?: unknown, label?: unknown, mode?: unknown, events?: unknown, until?: unknown }
export function migrateNotificationSettings(v: { defaults?: unknown, muteSubagents?: unknown, rules?: unknown }): NotificationSettings {
  const rules: OldRule[] = Array.isArray(v.rules) ? v.rules.filter((r): r is OldRule => !!r && typeof r === 'object') : []
  const machine = rules.find(r => r.scope === 'machine' && (r.mode === 'on' || r.mode === 'muted') && (r.until === null || r.until === undefined))
  const old = eventsOf(v.defaults)
  // The old default left coordinators at "needs you + finished": keep that
  // unless the human chose something for ordinary conversations or machines.
  const events = machine ? (machine.mode === 'muted' ? [] : eventsOf(machine.events)) : old.length ? old : [...LEVEL_EVENTS.finished]
  const exceptions: NotificationException[] = []
  for (const r of rules.slice(0, EXCEPTIONS_MAX)) {
    if (r.scope !== 'conversation' || (r.mode !== 'on' && r.mode !== 'muted') || !str(r.machine, 80) || !str(r.id, 512) || !r.id
      || !str(r.label, 120) || !validUntil(r.until)) continue
    const until = typeof r.until === 'number' ? r.until : null
    addException(exceptions, { kind: 'conversation', machine: r.machine as string, id: r.id as string, label: r.label as string,
      events: r.mode === 'on' ? eventsOf(r.events) : until ? null : [], subagents: false, until: r.mode === 'muted' ? until : null })
  }
  return { version: 2, default: { events, subagents: v.muteSubagents === false }, exceptions }
}

// The exception that decides for this source, if any (timed mutes that ended
// and left nothing behind no longer count).
export const exceptionLive = (e: NotificationException, now = Date.now()) => e.events !== null || (e.until !== null && e.until > now)
export function notificationException(settings: NotificationSettings, source: NotificationSource, now = Date.now()): NotificationException | undefined {
  // A coordinator's exception follows it on any machine.
  const live = (e: NotificationException) => (e.kind === 'coordinator' || e.machine === source.machine) && exceptionLive(e, now)
  const task = source.subagent || source.board
  // Task agents never have an exception of their own (only the Sub-agents
  // switches), even one migrated from the older per-conversation rules.
  const own = settings.exceptions.find(e => live(e) && ((e.kind === 'conversation' && !task && e.id === source.conversation)
    || (e.kind === 'coordinator' && !task && source.coordinator !== undefined && e.id === source.coordinator)))
  if (own) return own
  if (!task) return undefined
  // A board event whose task's session is unknown (no pane or space linked:
  // the board's links leave it out) cannot be tied to a coordinator safely.
  if (source.board && source.session === undefined) return undefined
  // A task belongs to its project's coordinator in its own session; else to
  // that session's main, then machine coordinator. The closest coordinator
  // with an exception decides: its Sub-agents switch off means the default.
  // Board events follow the project coordinator's exception of their own
  // session, switch or not, and the default when their session is unknown.
  const at = (level: string) => settings.exceptions.find(e => {
    if (!live(e) || e.kind !== 'coordinator') return false
    const k = parseCoordinatorKey(e.id)
    return k.level === level && (source.session === undefined || k.session === source.session)
      && (level !== 'project' || k.repo === source.project)
  })
  const project = source.project ? at('project') : undefined
  if (source.board) return project
  const closest = project ?? at('top') ?? at('machine')
  return closest?.subagents ? closest : undefined
}

export function notificationEvents(settings: NotificationSettings, source: NotificationSource, now = Date.now()): NotificationEvent[] {
  const e = notificationException(settings, source, now)
  if (e) return e.until !== null && e.until > now ? [] : e.events ?? defaultEvents(settings, source)
  return defaultEvents(settings, source)
}
const defaultEvents = (settings: NotificationSettings, source: NotificationSource) =>
  source.subagent && !source.board && !settings.default.subagents ? [] : settings.default.events

// Board files identify coordinators and every helper (including attempts).
// Repo keys from Herdr are shared by worktrees; board repo names are used when
// the board owns the conversation.
export function paneNotificationSource(pane: Pick<Pane, 'id' | 'workspace'>, state: Pick<HerdrState, 'workspaces'>,
  boards: MachineLinks[], baseMachine = machineOf(pane.id)): NotificationSource {
  const ws = state.workspaces.find(w => w.id === pane.workspace)
  for (const board of boards) {
    const coordinator = board.coordinators.find(c => c.pane === pane.id)
    if (coordinator) return { machine: board.machine, project: coordinator.repo, conversation: pane.id, coordinator: coordinatorKey(coordinator) }
    const task = board.tasks.find(t => t.panes.some(p => p.id === pane.id) || (t.workspace !== null && t.workspace === pane.workspace))
    if (task) {
      // Each Herdr session has its own key prefix: its coordinators share the task's.
      // The task file names its session; older links: its coordinators share the task's key prefix.
      const key = machineOf(pane.id)
      const session = task.session ?? board.coordinators.find(c => c.session !== undefined && machineOf(c.pane ?? c.workspace) === key)?.session
      return { machine: board.machine, project: task.repo, conversation: pane.id, subagent: true, ...(session === undefined ? {} : { session }) }
    }
  }
  const board = boards.find(b => b.machine === baseMachine)
  const linked = board?.tasks.find(t => ws?.repo && state.workspaces.find(w => w.id === t.workspace)?.repo === ws.repo)
  const repo = board?.repos?.find(r => r.root === ws?.repo || `${r.root}/.git` === ws?.repo || r.repo === ws?.repoName)
  return { machine: baseMachine, project: linked?.repo || repo?.repo || ws?.repoName || ws?.repo || undefined, conversation: pane.id }
}

// Keeps saved exceptions to what the model allows: migrated conversation
// exceptions that name a coordinator's current pane move to its stable
// identity, those that name a task agent go (the Sub-agents switch decides),
// and ended timed mutes that left nothing behind go. Null: nothing changes.
export function tidyNotificationExceptions(settings: NotificationSettings, boards: MachineLinks[], now = Date.now()): NotificationSettings | null {
  let changed = false
  const exceptions: NotificationException[] = []
  for (const e of settings.exceptions) {
    if (!exceptionLive(e, now)) { changed = true; continue }
    const board = e.kind === 'conversation' ? boards.find(b => b.machine === e.machine) : undefined
    const c = board?.coordinators.find(c => c.pane === e.id)
    const space = e.id.replace(/:p[0-9a-z]+$/i, '')
    if (board && !c && board.tasks.some(t => t.panes.some(p => p.id === e.id) || t.workspace === space)) { changed = true; continue }
    if (c) { changed = true; addException(exceptions, { ...e, kind: 'coordinator', id: coordinatorKey(c) }) }
    else addException(exceptions, e)
  }
  return changed ? { ...settings, exceptions } : null
}

// Coordinator exceptions of the older model (one per Herdr session: main,
// machine and project coordinators) move to today's: the main one to Alfred, a
// project one to its project's coordinator while that project exists, labelled
// with its current name. A machine coordinator or a gone project can match
// nothing any more: dropped. Duplicates merge (the last wins). projects: the
// project keys, null when unknown (projects off or not loaded yet): project
// exceptions then stay as they are. Null: nothing changes.
export function migrateCoordinatorExceptions(settings: NotificationSettings, projects: readonly string[] | null,
  name: (project: string) => string): NotificationSettings | null {
  const exceptions: NotificationException[] = []
  let changed = false
  for (const e of settings.exceptions) {
    if (e.kind !== 'coordinator') { addException(exceptions, e); continue }
    const k = parseCoordinatorKey(e.id)
    const project = k.level === 'top' ? MAIN : k.level === 'project' && k.repo ? k.repo : null
    if (project && project !== MAIN && !projects) { addException(exceptions, e); continue }
    if (!project || (project !== MAIN && !projects!.includes(project))) { changed = true; continue }
    const id = coordinatorTarget(project)
    if (id === e.id && e.machine === '') { addException(exceptions, e); continue }
    changed = true
    addException(exceptions, { ...e, machine: '', id, label: name(project).slice(0, 120) })
  }
  return changed || exceptions.length !== settings.exceptions.length ? { ...settings, exceptions } : null
}

// A lease uses server time only. A hidden, disconnected or idle tab cannot
// suppress push forever; the last visible heartbeat expires after 30 seconds.
export class NotificationPresence {
  private leases = new Map<string, { pane: string, at: number }>()
  heartbeat(client: string, pane: string | null, visible: boolean, now = Date.now()) {
    this.prune(now)
    if (visible && pane) this.leases.set(client, { pane, at: now })
  }
  private prune(now: number) {
    for (const [id, lease] of this.leases) if (now - lease.at >= 30_000) this.leases.delete(id)
  }
  viewed(pane: string, now = Date.now()) {
    this.prune(now)
    return [...this.leases.values()].some(lease => lease.pane === pane)
  }
}
