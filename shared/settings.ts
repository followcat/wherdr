// Settings kept on the server (DATA_DIR/settings.json) so they follow the
// user from one device to another. Each value is the text the app used to
// keep under the same key in localStorage, so every setting is still read by
// its own parser on the client. Anything not listed here stays on the device
// (screen-dependent widths, the last tab or filter, drafts, the session…).

export const SYNCED_SETTINGS = [
  // Notification policy follows the user across every device.
  'notificationRules',
  // Appearance
  'theme', 'focusBorder', 'backdrop', 'backdropPackets',
  // Machine bar and groups
  'machineBar', 'machineBarOrder', 'machineBarHidden', 'machineGroups',
  // Home list (compactListV2: 2.0's key, see app/utils/compactCard.ts; the
  // 1.x `compactList` is no longer read)
  'compactListV2', 'homeGrouping', 'individualAgentList', 'collapsedMachines', 'collapsedRepos',
  'showShells', 'showCounters', 'showQuotas', 'quotaDisplay',
  'autoReorderReady', 'readySort', 'hiddenAgents',
  // Conversation
  'typewriterSpeed', 'encryptedText', 'replyStyle', 'defaultViewMode',
  // Board
  'boardGrouping', 'boardDone', 'boardFolds',
  // Files
  'wherdr.files.hidden', 'wherdr.files.md',
] as const

export type SyncedSetting = typeof SYNCED_SETTINGS[number]
export type SettingsMap = Partial<Record<SyncedSetting, string>>
// A change: a value, or null to forget the key (back to its default).
export type SettingsPatch = Partial<Record<SyncedSetting, string | null>>

// Largest value accepted (collapsed repos and board folds keep at most 200
// entries; machine groups are a few names and keys).
export const SETTING_MAX = 16 * 1024

const known = new Set<string>(SYNCED_SETTINGS)
export const isSyncedSetting = (key: string): key is SyncedSetting => known.has(key)

// The valid part of a change sent by a client: known keys only, each a text
// up to SETTING_MAX, or null. Null when nothing valid is left.
export function cleanSettingsPatch(raw: unknown): SettingsPatch | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: SettingsPatch = {}
  let any = false
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSyncedSetting(key)) continue
    if (value === null || (typeof value === 'string' && value.length <= SETTING_MAX)) {
      out[key] = value
      any = true
    }
  }
  return any ? out : null
}

// The stored settings, read from the file's content (known keys, text values).
export function cleanSettings(raw: unknown): SettingsMap {
  const out: SettingsMap = {}
  const patch = cleanSettingsPatch(raw)
  for (const [key, value] of Object.entries(patch || {})) {
    if (typeof value === 'string') out[key as SyncedSetting] = value
  }
  return out
}

// Applies a change. `onlyMissing` (the first device's migration) never
// replaces a key the server already has. Returns the new settings and the
// keys that actually changed (with their new value, null when removed).
export function applySettingsPatch(current: SettingsMap, patch: SettingsPatch, onlyMissing = false): { next: SettingsMap, changed: SettingsPatch } {
  const next: SettingsMap = { ...current }
  const changed: SettingsPatch = {}
  for (const [k, value] of Object.entries(patch)) {
    const key = k as SyncedSetting
    if (onlyMissing && key in next) continue
    if (value === null || value === undefined) {
      if (!(key in next)) continue
      delete next[key]
      changed[key] = null
    } else {
      if (next[key] === value) continue
      next[key] = value
      changed[key] = value
    }
  }
  return { next, changed }
}
