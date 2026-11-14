import { notificationEvents, NotificationPresence, paneNotificationSource, parseNotificationSettings, type NotificationEvent, type NotificationSource } from '../../shared/notificationRules'
import { readSettings } from './settings'
import { getMachine, machineOfPane } from './machines'
import type { HerdrState, Pane } from '../../shared/types'

export const notificationPresence = new NotificationPresence()

export async function notificationAllowed(event: NotificationEvent, state: Pick<HerdrState, 'workspaces'>,
  pane?: Pick<Pane, 'id' | 'workspace'>, fallback?: NotificationSource): Promise<boolean> {
  const settings = parseNotificationSettings((await readSettings()).notificationRules)
  const machine = pane ? machineOfPane(pane.id) : null
  const source = pane ? paneNotificationSource(pane, state, [],
    machine?.info().baseKey ?? machine?.key ?? fallback?.machine) : fallback
  if (!source) return false
  // Resolve session machine keys to the base machine used by the menus. A
  // board event keeps its task's conversation (for visibility) but is not a
  // sub-agent's message: it follows the default or its project coordinator.
  const boardEvent = fallback?.board === true
  const resolved = { ...source, project: source.project ?? fallback?.project, session: source.session ?? fallback?.session, board: boardEvent,
    subagent: !boardEvent && Boolean(source.subagent || fallback?.subagent), coordinator: boardEvent ? undefined : source.coordinator ?? fallback?.coordinator,
    machine: getMachine(source.machine)?.info().baseKey ?? source.machine }
  return notificationEvents(settings, resolved).includes(event)
    && !(source.conversation && notificationPresence.viewed(source.conversation))
}
