import { SETTING_MAX } from '#shared/settings'
import { machineOf } from '#shared/ids'
import { EXCEPTIONS_MAX, LEVEL_EVENTS, NOTIFICATION_LEVELS, coordinatorTarget, levelOf, migrateCoordinatorExceptions, notificationEvents, notificationException,
  paneNotificationSource, parseCoordinatorKey, parseNotificationSettings, tidyNotificationExceptions, sameNotificationTarget,
  type NotificationEvent, type NotificationException, type NotificationLevel, type NotificationSettings, type NotificationTarget } from '#shared/notificationRules'
import type { Pane } from '#shared/types'
import { MAIN } from '#shared/pm/coordinator'
import type { MenuItem } from './useUi'

export const notificationRules = syncedRef('notificationRules', parseNotificationSettings, JSON.stringify)
export const notificationClock = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
let clockUsers = 0
export function useNotificationClock() {
  onMounted(() => { clockUsers++; clock ||= setInterval(() => { notificationClock.value = Date.now() }, 10000) })
  onUnmounted(() => { if (!--clockUsers) { clearInterval(clock); clock = undefined } })
}

export const levelLabel = (l: NotificationLevel | 'custom') => ({
  'muted': t('Muted'), 'needs-you': t('Needs you'), 'finished': t('Needs you + finished'), 'all': t('All activity'), 'custom': t('Custom'),
})[l]
export const levelHint = (l: NotificationLevel) => ({
  'muted': t('Nothing.'),
  'needs-you': t('An agent is waiting for you.'),
  'finished': t('Also an agent that finished answering you.'),
  'all': t('Also every intermediate message.'),
})[l]
export const eventLabel = (e: NotificationEvent) => ({ 'needs-you': t('Needs you'), 'finished': t('Finished'), 'message': t('New message'), 'scheduled': t('Scheduled task') })[e]
export const defaultLevelLabel = () => levelLabel(levelOf(notificationRules.value.default.events))

const baseMachine = (key: string) => {
  const m = allSessionsState.value.machines?.find(x => x.key === key) ?? herdrState.value.machines?.find(x => x.key === key)
  return m?.baseKey ?? m?.key ?? key
}
// A machine id that matches no known machine (one removed since) is not shown raw.
export const notificationMachineName = (key: string) => machineName(key)
  || (allSessionsState.value.machines ?? herdrState.value.machines)?.find(m => m.key === key || m.baseKey === key)?.label || (key ? t('Unknown machine') : t('This machine'))
type NotifiedPane = Pick<Pane, 'id' | 'workspace'> & Partial<Pick<Pane, 'coreAddress'>>
export function notificationSource(pane: NotifiedPane) {
  const source = paneNotificationSource(pane, herdrState.value, [], baseMachine(machineOf(pane.id)))
  const c = coordinatorAtAddress(pane.coreAddress)
  return c ? { ...source, coordinator: coordinatorTarget(c.project) } : source
}
// The exception a conversation can have: its coordinator's (Alfred or a
// project's, kept across its restarts), else its own pane.
export function paneNotificationTarget(p: NotifiedPane & Pick<Pane, 'title'>): NotificationTarget {
  const c = coordinatorAtAddress(p.coreAddress)
  if (c) return { kind: 'coordinator', machine: '', id: coordinatorTarget(c.project), label: c.name.slice(0, 120) }
  const s = notificationSource(p)
  return { kind: 'conversation', machine: s.machine, id: p.id, label: (p.title || p.id).slice(0, 120) }
}
// A coordinator exception's current name ('' when its coordinator is unknown).
export const coordinatorExceptionName = (id: string) => {
  const k = parseCoordinatorKey(id)
  return k.session ? '' : k.level === 'top' ? coordinatorNameOf(MAIN) : k.level === 'project' && k.repo ? coordinatorNameOf(k.repo) : ''
}
export function paneNotificationsMuted(p: NotifiedPane) {
  return !notificationEvents(notificationRules.value, notificationSource(p), notificationClock.value).length
}
export const findException = (target: Pick<NotificationTarget, 'kind' | 'machine' | 'id'>) =>
  notificationRules.value.exceptions.find(e => sameNotificationTarget(e, target))

export function saveNotificationRules(next: NotificationSettings) {
  if (next.exceptions.length > EXCEPTIONS_MAX || JSON.stringify(next).length > SETTING_MAX) { toast(t('Too many exceptions. Remove an old one first.'), true); return }
  notificationRules.value = next
}
// Creates or replaces a target's exception; ended timed mutes are dropped.
export function setException(target: NotificationTarget, patch: Partial<Pick<NotificationException, 'events' | 'subagents' | 'until'>>) {
  const now = Date.now()
  const old = findException(target)
  const next: NotificationException = {
    kind: target.kind, machine: target.machine, id: target.id, label: target.label.slice(0, 120),
    events: old ? old.events : [...notificationRules.value.default.events],
    subagents: old?.subagents ?? false, until: old?.until ?? null, ...patch,
  }
  if (next.until !== null && next.until <= now) next.until = null
  const exceptions = notificationRules.value.exceptions.filter(e => !sameNotificationTarget(e, target) && (e.events !== null || (e.until ?? 0) > now))
  saveNotificationRules({ ...notificationRules.value, exceptions: [...exceptions, next] })
}
export function removeException(target: Pick<NotificationTarget, 'kind' | 'machine' | 'id'>) {
  saveNotificationRules({ ...notificationRules.value, exceptions: notificationRules.value.exceptions.filter(e => !sameNotificationTarget(e, target)) })
  toast(tl(`Back to the default: ${defaultLevelLabel()}`, `Retour au défaut : ${defaultLevelLabel()}`))
}

// Ended timed mutes that left nothing behind are dropped from the saved
// exceptions; older coordinator exceptions move to today's coordinators.
export function useNotificationRekey() {
  onMounted(() => { if (!coordinatorsLoaded.value) loadCoordinators(); if (!alfred.value) loadAlfred() })
  watch([notificationRules, notificationClock, coordinators, alfred], ([s, now]) => {
    const tidy = tidyNotificationExceptions(s, [], now)
    // Projects on: the list starts with the main coordinator.
    const projects = coordinators.value.some(c => c.main) ? projectCoordinators.value.map(c => c.project) : null
    const next = migrateCoordinatorExceptions(tidy ?? s, projects, p => coordinatorNameOf(p) || p)
    if (next || tidy) saveNotificationRules(next ?? tidy!)
  }, { immediate: true })
}

// Row menus show the effective state; the settings panel keeps the same rules.
export function notificationMenuItem(p: NotifiedPane & Pick<Pane, 'title'>, showState = false): MenuItem {
  const label = showState ? (paneNotificationsMuted(p) ? t('Unmute notifications') : t('Mute notifications')) : t('Notifications')
  return { label, icon: 'i-lucide-bell', run: () => openNotificationMenu(p) }
}
function openNotificationMenu(p: NotifiedPane & Pick<Pane, 'title'>) {
  const settings = { label: t('Notification settings'), icon: 'i-lucide-settings-2', run: () => navigateTo('/settings?section=notifications') }
  const target = paneNotificationTarget(p)
  const now = Date.now()
  const live = notificationException(notificationRules.value, notificationSource(p), now)
  const own = live && sameNotificationTarget(live, target) ? live : undefined
  const mutedUntil = own?.until && own.until > now ? own.until : null
  const current = mutedUntil ? 'muted' : levelOf(own?.events ?? notificationRules.value.default.events)
  const where = own ? t('Exception') : t('Default')
  const icons: Record<NotificationLevel, string> = { 'muted': 'i-lucide-bell-off', 'needs-you': 'i-lucide-message-circle-question-mark', 'finished': 'i-lucide-bell', 'all': 'i-lucide-bell-ring' }
  openMenu([
    ...NOTIFICATION_LEVELS.map(l => ({
      label: levelLabel(l), icon: l === current ? 'i-lucide-check' : icons[l],
      desc: l === current ? (mutedUntil ? tl(`${where} · until ${fmtTime(mutedUntil)}`, `${where} · jusqu’à ${fmtTime(mutedUntil)}`) : where) : undefined,
      run: () => setException(target, { events: [...LEVEL_EVENTS[l]], until: null }),
    })),
    { kind: 'separator' },
    { label: t('Mute for 1 hour'), icon: 'i-lucide-timer', run: () => setException(target, { until: Date.now() + 3600000, events: own ? own.events : null }) },
    { label: t('Mute for 8 hours'), icon: 'i-lucide-timer', run: () => setException(target, { until: Date.now() + 8 * 3600000, events: own ? own.events : null }) },
    { label: tl(`Follow the default (${defaultLevelLabel()})`, `Suivre le défaut (${defaultLevelLabel()})`), icon: own ? 'i-lucide-corner-up-left' : 'i-lucide-check',
      desc: own ? undefined : t('Current'), run: () => { if (own) removeException(target) } },
    { kind: 'separator' }, settings,
  ], `${t('Notifications')} · ${target.label}`)
}
