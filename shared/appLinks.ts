// In-app links: the one list of wherdr addresses an agent may give the user
// ("open #/settings?section=phone"), and how a chat message recognises one.
// The app runs in hash mode, so an address is `#/<path>?<query>`; a chat link
// or an inline code span holding exactly that opens the place inside the app
// (utils/markdown.ts, ChatMarkdown.vue), without a reload.
import { PROJECT_TABS, type ProjectTab } from './pm/places'

// Settings sections, by their ?section= key (SettingsView.vue reads it).
export const SETTINGS_SECTIONS = ['appearance', 'conversation', 'terminal', 'agents', 'machines', 'projects', 'plugins', 'phone', 'notifications', 'security', 'shortcuts', 'about'] as const
export type SettingsSection = typeof SETTINGS_SECTIONS[number]
// Old section ids still linked from elsewhere: ?section=pacing opens Agents,
// pointing at its Pace group (a target of shared/uiTargets.ts).
export const SETTINGS_ALIASES: Record<string, { section: SettingsSection, target: string }> = {
  pacing: { section: 'agents', target: 'agents.pace' },
}
// Settings › Conversation's tabs, by their ?tab= key: Display by default.
export const CONVERSATION_TABS = ['display', 'dictation', 'read-aloud'] as const
export type ConversationTab = typeof CONVERSATION_TABS[number]
export const conversationTab = (q: unknown): ConversationTab => (CONVERSATION_TABS as readonly unknown[]).includes(q) ? q as ConversationTab : 'display'

const query = (q: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1])).toString()
  return s ? `?${s}` : ''
}
export const settingsLink = (section: SettingsSection | 'pacing') => `#/settings${query({ section })}`
// The board, filtered by project and tag, or with a task's sheet open.
export const boardLink = (o: { project?: string, tag?: string, task?: string } = {}) => `#/board${query({ project: o.project?.toUpperCase(), tag: o.tag, task: o.task })}`
// A project's sheet (Settings › Projects › KEY) on one of its tabs; its
// Autopilot tab holds the coordinator's autopilot panel.
export const projectLink = (key: string, tab: ProjectTab = 'general') => `#/settings${query({ section: 'projects', project: key.toUpperCase(), tab })}`
export const DECISIONS_LINK = '#/decisions'

// What an agent's role text lists: each place, its address, and what it shows.
export function appLinkList(): string[] {
  return [
    `- Home: \`#/\`; Decisions (what waits for the user's choice): \`${DECISIONS_LINK}\`.`,
    `- The board: \`${boardLink()}\`; one project: \`${boardLink({ project: 'KEY' })}\`; one tag: \`${boardLink({ tag: 'TAG' })}\`; a task's sheet: \`${boardLink({ task: 'ID' })}\`.`,
    `- A Settings section: \`#/settings?section=<section>\`, section one of ${SETTINGS_SECTIONS.join(', ')}; the agents' Pace group: \`${settingsLink('pacing')}\`; a Conversation tab: \`#/settings?section=conversation&tab=<tab>\`, tab one of ${CONVERSATION_TABS.join(', ')}.`,
    `- A project's sheet: \`#/settings?section=projects&project=KEY&tab=<tab>\`, tab one of ${PROJECT_TABS.join(', ')} (autopilot: its coordinator's autopilot).`,
  ]
}

// A whole in-app address: `#/`, a path of plain segments, an optional query,
// no space or quote. Anything else (`#heading`, `https://…`) is not one.
export const isAppLink = (s: string) => /^#\/(?:[\w.-]+(?:\/[\w.:-]+)*)?(?:\?[\w.~%&=+:,-]*)?$/.test(s)
// The task of a task's sheet address (`#/board?task=X`, nothing else): it
// opens over the current page.
export const linkedTask = (s: string) => /^#\/board\?task=([\w.-]+)$/.exec(s)?.[1] ?? null
// The router path of an in-app address (`#/board?task=X` → `/board?task=X`).
export const appRoute = (s: string) => s.slice(1)
