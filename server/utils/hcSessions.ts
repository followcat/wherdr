// Local hc sessions offered in Settings › Machines. The scan is explicit and
// fail-closed: sockets directly inside the herdr-core runtime directory only,
// never holder sockets, never anything the configuration already uses.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { coreRuntimeDir, filterAllowedHcSockets, hcSockets, type HcSocketFilterOptions } from './settings'
import { parseHcSocketsEnv } from './corePool'

export interface LocalHcSessionSocket { path: string, name: string }
export interface LocalHcSessions {
  directory: string | null
  primary: string
  envSockets: string[]
  settingsSockets: string[]
  available: LocalHcSessionSocket[]
}
export interface LocalHcSessionsOptions extends HcSocketFilterOptions { settingsFile?: string }

const expandHome = (p: string, home: string) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p)
const realOrSelf = async (p: string) => await fs.realpath(p).catch(() => p)
const unique = (list: readonly string[]) => [...new Set(list.filter(Boolean))]

export async function listLocalHcSessions(opts: LocalHcSessionsOptions = {}): Promise<LocalHcSessions> {
  const env = opts.env ?? process.env
  const home = opts.home ?? env.HOME ?? os.homedir()
  const resolveOne = (s: string) => path.resolve(expandHome(s.trim(), home))
  const primaryRaw = (opts.primary ?? env.HC_SOCKET ?? '').trim()
  const primary = primaryRaw ? await realOrSelf(resolveOne(primaryRaw)) : ''
  const settings = await hcSockets(opts.settingsFile, { ...opts, env, home })
  const envSockets = unique(await Promise.all(parseHcSocketsEnv(env.HC_SOCKETS, home).map(realOrSelf)))
    .filter(p => p !== primary)
  const settingsSockets = unique(settings).filter(p => p !== primary)
  const used = new Set([primary, ...envSockets, ...settingsSockets].filter(Boolean))

  const directory = coreRuntimeDir({ ...opts, env, home })
  if (!directory) return { directory, primary, envSockets, settingsSockets, available: [] }
  let names: string[] = []
  try {
    names = (await fs.readdir(directory))
      .filter(name => name.endsWith('.sock') && !name.includes('holder'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  } catch {
    return { directory, primary, envSockets, settingsSockets, available: [] }
  }
  const candidates = names.map(name => path.join(directory, name))
  const valid = await filterAllowedHcSockets(candidates, { ...opts, env, home })
  const available = valid
    .filter(p => !used.has(p))
    .map(p => ({ path: p, name: path.basename(p).replace(/\.sock$/, '') }))
  return { directory, primary, envSockets, settingsSockets, available }
}
