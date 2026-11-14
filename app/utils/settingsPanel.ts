// Settings beside the conversation (computer, ≥ 1280 px): the panel lives in
// the conversation's own URL (`/a/<pane>?section=pacing`), so the sections and
// their sub-links (?project=…, ?group=…) work as on the full page.
import type { LocationQuery } from 'vue-router'
import { appRoute } from '../../shared/appLinks'

type At = { path: string, query: LocationQuery }

export const isConversationPath = (path: string) => /^\/(a|t)\/./.test(path)

// A move to /settings while a conversation is shown opens the panel instead,
// on the asked section (Appearance by default, or the one already open).
export function settingsPanelRoute(to: At, from: At, room: boolean): (At & { query: { section: string } }) | null {
  if (!room || !isConversationPath(from.path)) return null
  if (to.path !== '/settings' && to.path !== '/settings/desktop') return null
  const asked = to.path === '/settings/desktop' || to.query.section === 'desktop' ? 'conversation' : to.query.section
  const section = String(asked || from.query.section || 'appearance')
  return { path: from.path, query: { ...to.query, section } }
}

// An agent's `ui open` link (shared/uiOpen.ts, `#/settings?section=phone` or
// bare `#/settings`): the panel it opens beside the conversation, or null (no
// room, or not a Settings place) for the card above the message field.
export function uiOpenPanel(link: string, from: At, room: boolean) {
  const [path = '', search = ''] = appRoute(link).split('?')
  return settingsPanelRoute({ path, query: Object.fromEntries(new URLSearchParams(search)) }, from, room)
}
