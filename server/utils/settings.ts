// Settings that follow the user across devices (shared/settings.ts): one
// file in the data folder, written atomically, one write at a time. Every
// change is pushed to the open apps over /ws/events.
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from './atomicWrite'
import { applySettingsPatch, cleanSettings, readHcSockets, type SettingsMap, type SettingsPatch } from '../../shared/settings'
import { DATA_DIR, log } from './env'
import { readNamedAgents, type NamedAgent } from '../../shared/pm/namedAgents'
import { HerdrError } from './herdr'

export interface HcSocketFilterOptions {
  primary?: string
  env?: NodeJS.ProcessEnv
  home?: string
  uid?: number
  log?: (message: string) => void
}

const expandHome = (p: string, home: string) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p)

// Runtime directory allowed for browser-configured hcSockets: the primary
// HC_SOCKET directory, defaulting to $XDG_RUNTIME_DIR/herdr-core/.
export function coreRuntimeDir(opts: Pick<HcSocketFilterOptions, 'primary' | 'env' | 'home'> = {}): string | null {
  const env = opts.env ?? process.env
  const home = opts.home ?? env.HOME ?? os.homedir()
  const primary = (opts.primary ?? env.HC_SOCKET ?? '').trim()
  const raw = primary
    ? path.dirname(path.resolve(expandHome(primary, home)))
    : env.XDG_RUNTIME_DIR?.trim()
      ? path.resolve(expandHome(path.join(env.XDG_RUNTIME_DIR.trim(), 'herdr-core'), home))
      : ''
  if (!raw) return null
  try { return fsSync.realpathSync(raw) } catch { return raw }
}

// Fail-closed validation for browser/settings.json hcSockets: each entry must
// resolve via realpath to a user-owned Unix socket directly inside coreRuntimeDir.
export async function filterAllowedHcSockets(raw: unknown, opts: HcSocketFilterOptions = {}): Promise<string[]> {
  const candidates = readHcSockets(raw)
  if (!candidates.length) return []
  const warn = opts.log ?? log
  const dirRaw = coreRuntimeDir(opts)
  if (!dirRaw) {
    for (const _ of candidates) warn('hcSockets: dropped entry (no runtime directory)')
    return []
  }
  let rtDir: string
  try { rtDir = await fs.realpath(dirRaw) } catch {
    for (const _ of candidates) warn('hcSockets: dropped entry (runtime directory unavailable)')
    return []
  }
  const expectedUid = opts.uid ?? process.getuid?.()
  const seen = new Set<string>()
  const accepted: string[] = []
  for (const entry of candidates) {
    if (!path.isAbsolute(entry)) {
      warn('hcSockets: dropped entry (outside runtime directory)')
      continue
    }
    let real: string
    try { real = await fs.realpath(entry) } catch {
      warn('hcSockets: dropped entry (unreadable or missing)')
      continue
    }
    if (path.dirname(real) !== rtDir) {
      warn('hcSockets: dropped entry (outside runtime directory)')
      continue
    }
    let st: fsSync.Stats
    try { st = await fs.stat(real) } catch {
      warn('hcSockets: dropped entry (unreadable or missing)')
      continue
    }
    if (expectedUid !== undefined && st.uid !== expectedUid) {
      warn('hcSockets: dropped entry (not owned by current user)')
      continue
    }
    if (!st.isSocket()) {
      warn('hcSockets: dropped entry (not a socket)')
      continue
    }
    if (!seen.has(real)) {
      seen.add(real)
      accepted.push(real)
    }
  }
  return accepted
}

export async function prepareSettingsPatch(patch: SettingsPatch, opts: HcSocketFilterOptions = {}): Promise<SettingsPatch> {
  if (!('hcSockets' in patch) || patch.hcSockets === null || patch.hcSockets === undefined) return patch
  const filtered = await filterAllowedHcSockets(patch.hcSockets, opts)
  return { ...patch, hcSockets: JSON.stringify(filtered) }
}

export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')

type Listener = (changed: SettingsPatch) => void
const listeners = new Set<Listener>()
export function onSettingsChange(fn: Listener) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// Only a missing file starts from empty. Any other failure (EMFILE, EIO,
// EACCES, a damaged file) throws: a patch written over it would drop every
// other key and reset chatFilesLevel to its widest default.
export async function loadSettings(file = SETTINGS_FILE): Promise<SettingsMap> {
  let text: string
  try { text = await fs.readFile(file, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    console.error(new Date().toISOString(), 'Settings file unreadable, not written', error)
    throw new HerdrError('settings_unreadable', 'The settings file cannot be read; nothing was saved')
  }
  try { return cleanSettings(JSON.parse(text)?.settings) }
  catch {
    console.error(new Date().toISOString(), `Settings file damaged (invalid JSON), not written: ${file}`)
    throw new HerdrError('settings_damaged', 'The settings file is damaged; nothing was saved')
  }
}

// For display only: an unreadable file shows the defaults (logged above).
// Never decide on it (a security setting, a value sent back): use loadSettings.
export async function readSettings(file = SETTINGS_FILE): Promise<SettingsMap> {
  return loadSettings(file).catch(() => ({}))
}

// The named agents (Settings › Agents) the engine starts tasks with.
export const namedAgents = async (file = SETTINGS_FILE): Promise<NamedAgent[]> => readNamedAgents((await readSettings(file)).namedAgents)

// Extra hc session socket paths explicitly configured in settings.json, validated fail-closed.
export const hcSockets = async (file = SETTINGS_FILE, opts: HcSocketFilterOptions = {}): Promise<string[]> =>
  filterAllowedHcSockets((await readSettings(file)).hcSockets, opts)

const writeSettings = (settings: SettingsMap, file: string) => writeFileAtomic(file, JSON.stringify({ v: 1, settings }) + '\n')

// Writes one after another: two devices changing settings at the same time
// each get their keys in; for the same key, the last one to arrive wins. A
// patch that depends on the current settings is an updater: it runs in the
// queue, on the settings as they are then (it may throw to refuse).
let queue: Promise<unknown> = Promise.resolve()

export function patchSettings(patch: SettingsPatch | ((now: SettingsMap) => SettingsPatch), opts: { onlyMissing?: boolean, file?: string } = {}): Promise<SettingsMap> {
  const file = opts.file || SETTINGS_FILE
  const run = queue.then(async () => {
    const now = await loadSettings(file)
    const { next, changed } = applySettingsPatch(now, typeof patch === 'function' ? patch(now) : patch, opts.onlyMissing)
    if (!Object.keys(changed).length) return next
    await writeSettings(next, file)
    for (const fn of listeners) {
      try { fn(changed) }
      catch { /* a listener's failure does not undo the write */ }
    }
    return next
  })
  queue = run.catch(() => {})
  return run
}
