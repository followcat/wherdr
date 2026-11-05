// Settings that follow the user across devices (shared/settings.ts). The
// server's file is the reference; localStorage keeps a copy under the same
// keys, so the first paint and offline use read the last known values at
// once. A change is written to the copy and sent to the server shortly after;
// a value from the server (load, or another device's change over /ws/events)
// updates the copy and the bound settings without being sent back.
import { SYNCED_SETTINGS, isSyncedSetting, type SettingsMap, type SettingsPatch, type SyncedSetting } from '../../shared/settings'

export interface LocalStore {
  get: (key: string) => string | null
  set: (key: string, value: string) => void
  remove: (key: string) => void
}

export interface SettingsTransport {
  get: () => Promise<SettingsMap>
  post: (patch: SettingsPatch, migrate: boolean) => Promise<SettingsMap>
}

export type SettingApplier = (raw: string | null) => void

// The changes not yet accepted by the server, kept with the copy: a change
// made just before a reload, or offline, still goes out on the next load.
export const PENDING_KEY = 'syncedSettingsPending'
// Set once this browser's values have been merged into the server's (the
// first load after the update, on each device).
export const MIGRATED_KEY = 'syncedSettingsMigrated'

function readPending(raw: string | null): Map<SyncedSetting, string | null> {
  const out = new Map<SyncedSetting, string | null>()
  try {
    const v: unknown = JSON.parse(raw || '{}')
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [key, value] of Object.entries(v)) {
        if (isSyncedSetting(key) && (value === null || typeof value === 'string')) out.set(key, value)
      }
    }
  } catch { /* nothing pending */ }
  return out
}

export function createSettingsSync(opts: { local: LocalStore, transport?: SettingsTransport, delay?: number }) {
  const { local } = opts
  let transport = opts.transport
  const delay = opts.delay ?? 300
  const appliers = new Map<string, Set<SettingApplier>>()
  // Changes not yet accepted by the server (offline, within the delay, or
  // left by the previous page).
  const pending = readPending(local.get(PENDING_KEY))
  function savePending() {
    if (pending.size) local.set(PENDING_KEY, JSON.stringify(Object.fromEntries(pending)))
    else local.remove(PENDING_KEY)
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  let sending: Promise<boolean> | null = null
  let loading: Promise<void> | null = null

  function keep(key: string, raw: string | null) {
    if (raw === null) local.remove(key)
    else local.set(key, raw)
  }

  // Server values: copied and applied, except keys changed here and not yet
  // sent (this device's newer write wins). `full`: the server's whole map, so
  // a key it lacks goes back to its default.
  function applyServer(map: SettingsPatch, full: boolean) {
    const keys = full ? SYNCED_SETTINGS : Object.keys(map).filter(isSyncedSetting)
    for (const key of keys) {
      if (pending.has(key)) continue
      const raw = map[key] ?? null
      if (raw === local.get(key)) continue
      keep(key, raw)
      for (const fn of appliers.get(key) || []) fn(raw)
    }
  }

  async function flush(): Promise<boolean> {
    if (timer) { clearTimeout(timer); timer = null }
    if (sending) await sending.catch(() => {})
    if (!transport || !pending.size) return true
    const sent = Object.fromEntries(pending) as SettingsPatch
    const run = (async () => {
      try {
        const map = await transport!.post(sent, false)
        // A key changed again during the request stays pending.
        for (const [key, raw] of Object.entries(sent)) {
          if (pending.get(key as SyncedSetting) === raw) pending.delete(key as SyncedSetting)
        }
        savePending()
        applyServer(map, true)
        return true
      } catch { return false }
    })()
    sending = run
    try { return await run }
    finally { if (sending === run) sending = null }
  }

  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; flush() }, delay)
  }

  return {
    setTransport(t: SettingsTransport) { transport = t },
    // A setting's live value follows the server's: `apply` gets the new text.
    bind(key: SyncedSetting, apply: SettingApplier) {
      if (!appliers.has(key)) appliers.set(key, new Set())
      appliers.get(key)!.add(apply)
      return () => { appliers.get(key)?.delete(apply) }
    },
    // A change made on this device.
    write(key: SyncedSetting, raw: string | null) {
      if (raw === local.get(key) && !pending.has(key)) return
      keep(key, raw)
      pending.set(key, raw)
      savePending()
      if (transport) schedule()
    },
    // At startup and on every reconnection. The first time on each device
    // (migration), this browser's values are merged into the server's: the
    // server takes the keys it lacks and keeps the ones it has, so a second
    // device's own settings (groups built only there…) are not lost. Afterwards
    // the server is the reference. Changes not sent yet go out, then the
    // server's values apply.
    load(): Promise<void> {
      if (loading) return loading
      loading = (async () => {
        if (!transport) return
        let map: SettingsMap
        if (local.get(MIGRATED_KEY) !== '1') {
          const mine: SettingsPatch = {}
          for (const key of SYNCED_SETTINGS) {
            const raw = local.get(key)
            if (raw !== null) mine[key] = raw
          }
          map = Object.keys(mine).length ? await transport.post(mine, true) : await transport.get()
          local.set(MIGRATED_KEY, '1')
        } else map = await transport.get()
        // flush applies the server's answer itself.
        if (pending.size) await flush()
        else applyServer(map, true)
      })().catch(() => { /* offline: the copy stays, retried on reconnection */ }).finally(() => { loading = null })
      return loading
    },
    // Another device's change (/ws/events).
    receive(changed: SettingsPatch) { applyServer(changed, false) },
    flush,
    get pendingKeys() { return [...pending.keys()] },
  }
}
