// What fires an automation, in words: "every weekday at 9:00", "when a task
// is merged · docs*" (the Automations tab and the proposal card).
import { scheduleWords, type Automation, type AutomationEvent } from '#shared/pm/automations'

const EVENT_WORDS: Record<AutomationEvent, string> = {
  'added': 'when a task is added', 'approval': 'when a task waits for approval', 'review-failed': 'when a review sends a task back',
  'failed': 'when a task fails', 'needs-you': 'when a task needs you', 'merged': 'when a task is merged',
}
export const automationTrigger = (a: Pick<Automation, 'schedule' | 'event' | 'filter'>) =>
  a.schedule ? tl(scheduleWords(a.schedule)) : `${tl(EVENT_WORDS[a.event!] ?? a.event ?? '')}${a.filter ? ` · ${a.filter}` : ''}`
