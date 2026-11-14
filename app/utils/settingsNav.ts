// Settings: sections and Back button.

export { SETTINGS_ALIASES, SETTINGS_SECTIONS, type SettingsSection } from '../../shared/appLinks'

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
