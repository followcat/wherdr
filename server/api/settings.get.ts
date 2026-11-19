import { loadSettings } from '../utils/settings'

// An unreadable file is an error, never {}: the apps would take {} for the
// server's whole map and drop their own copies (utils/syncedSettings.ts).
export default defineApi(async () => ({ settings: await loadSettings() }))
