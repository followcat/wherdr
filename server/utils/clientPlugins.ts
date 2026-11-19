// wherdr plugins (client side): DATA_DIR/plugins/<id>/manifest.json + bundle.
// An empty or missing folder is the normal case: no plugin.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR } from './env'
import { loadSettings, patchSettings } from './settings'
import { PLUGIN_FILE_RE, PLUGIN_ID_RE, SOURCE_FILE, communityOn, parseManifest, parseSource, type ClientPluginInfo, type PluginSource } from '../../shared/clientPlugins'

export const PLUGINS_DIR = path.join(DATA_DIR, 'plugins')

export async function listClientPlugins(dir = PLUGINS_DIR): Promise<ClientPluginInfo[]> {
  let names: string[]
  try { names = await fsp.readdir(dir) } catch { return [] }
  const out: ClientPluginInfo[] = []
  for (const id of names.sort()) {
    if (!PLUGIN_ID_RE.test(id)) continue
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(dir, id, 'manifest.json'), 'utf8'))
      const info = parseManifest(id, raw)
      const source = info && await readSource(dir, id)
      if (info) out.push(source ? { ...info, source } : info)
    } catch { /* no manifest or unreadable: not a plugin */ }
  }
  return out
}

// Where a plugin installed from GitHub came from, or null (copied by hand).
export async function readSource(dir: string, id: string): Promise<PluginSource | null> {
  try { return parseSource(JSON.parse(await fsp.readFile(path.join(dir, id, SOURCE_FILE), 'utf8'))) } catch { return null }
}

// Absolute path of a file of a plugin, or null when the name is not a plain file name.
export function pluginFile(id: string, file: string, dir = PLUGINS_DIR): string | null {
  if (!PLUGIN_ID_RE.test(id) || !PLUGIN_FILE_RE.test(file)) return null
  return path.join(dir, id, file)
}

// Whether Community plugins is on. The first read after the update writes the
// answer down, so a plugin installed later starts off until the user turns it on.
// An unreadable settings file means off, and nothing is written.
export async function communityPluginsOn(installed: number, file?: string): Promise<boolean> {
  let raw: string | undefined
  try { raw = (await loadSettings(file)).communityPlugins }
  catch { return false }
  const on = communityOn(raw, installed)
  if (raw !== '1' && raw !== '0') {
    await patchSettings({ communityPlugins: on ? '1' : '0' }, { onlyMissing: true, file }).catch(() => { /* logged by settings.ts */ })
  }
  return on
}
