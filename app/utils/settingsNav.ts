// Settings: sections and Back button.

import type { SettingsSection } from '../../shared/appLinks'

export { SETTINGS_ALIASES, SETTINGS_SECTIONS, type SettingsSection } from '../../shared/appLinks'

// The sections' names and icons (Settings, the ⌘K palette).
export const settingsSectionIcons: Record<SettingsSection, string> = {
  appearance: 'i-lucide-palette', conversation: 'i-lucide-message-square', terminal: 'i-lucide-square-terminal',
  agents: 'i-lucide-bot', machines: 'i-lucide-server', projects: 'i-lucide-kanban', plugins: 'i-lucide-puzzle', phone: 'i-lucide-smartphone', notifications: 'i-lucide-bell', security: 'i-lucide-lock', shortcuts: 'i-lucide-keyboard', about: 'i-lucide-info',
}
export const settingsSectionLabels: Record<SettingsSection, string> = {
  appearance: 'Appearance', conversation: 'Conversation', terminal: 'Terminal', agents: 'Agents', machines: 'Machines', projects: 'Projects',
  plugins: 'Plugins', phone: 'Phone', notifications: 'Notifications', security: 'Security', shortcuts: 'Shortcuts', about: 'About',
}

// Phone: an open section is a history entry (?section=…), above
// the list: Back pops it (like Android's Back button); opened
// directly (link, reload), without a list underneath, it is replaced by the
// list. Otherwise we go back to the view we came from (previous entry of
// the router history), or to the home screen when Settings were opened
// directly.
export function settingsBack(opts: { desk: boolean, section: string | null, historyBack: unknown }): 'list' | 'history' | 'home' {
  const b = opts.historyBack
  if (!opts.desk && opts.section) return b === '/settings' ? 'history' : 'list'
  return typeof b === 'string' && b.startsWith('/') && !b.startsWith('/settings') ? 'history' : 'home'
}
