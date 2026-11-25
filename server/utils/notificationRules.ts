import { notificationEvents, NotificationPresence, paneNotificationSource, parseNotificationSettings, type NotificationEvent, type NotificationSource } from '../../shared/notificationRules'
import { machineOf } from '../../shared/ids'
import { loadSettings } from './settings'
import { getMachine, machineOfPane } from './machines'
import type { HerdrState, Pane } from '../../shared/types'

export const notificationPresence = new NotificationPresence()
// The rules last read: an unreadable settings file (logged by loadSettings)
// keeps them, never the defaults in their place. None read yet (undefined):
// nothing is notified until the file can be read.
let lastRules: string | null | undefined

export async function notificationAllowed(event: NotificationEvent, state: Pick<HerdrState, 'workspaces' | 'machines'>,
  pane?: Pick<Pane, 'id' | 'workspace' | 'backlotRole' | 'machine'>, fallback?: NotificationSource): Promise<boolean> {
  const rules = await loadSettings().then(s => (lastRules = s.notificationRules ?? null), () => lastRules)
  if (rules === undefined) return false
  const settings = parseNotificationSettings(rules)
  const info = pane ? (machineOfPane(pane.id)?.info() ?? state.machines?.find(m => m.key === (pane.machine ?? machineOf(pane.id)))) : undefined
  const source = pane ? paneNotificationSource(pane, state, [],
    info?.baseKey ?? info?.key ?? fallback?.machine) : fallback
  if (!source) return false
  // Resolve session machine keys to the base machine used by the menus. A
  // board event keeps its task's conversation (for visibility) but is not a
  // sub-agent's message: it follows the default or its project coordinator.
  const boardEvent = fallback?.board === true
  const resolved = { ...source, project: source.project ?? fallback?.project, session: source.session ?? fallback?.session, board: boardEvent,
    subagent: !boardEvent && Boolean(source.subagent || fallback?.subagent), coordinator: boardEvent ? undefined : source.coordinator ?? fallback?.coordinator,
    machine: getMachine(source.machine)?.info().baseKey ?? state.machines?.find(m => m.key === source.machine)?.baseKey ?? source.machine }
  return notificationEvents(settings, resolved).includes(event)
    && !(source.conversation && notificationPresence.viewed(source.conversation))
}
