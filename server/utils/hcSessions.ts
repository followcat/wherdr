// Automatic discovery of the hc sessions of this computer. The scan stays
// fail-closed: sockets directly inside the herdr-core runtime directory only,
// owned by this user, never holder sockets; a candidate joins only after a
// bounded herdr-core hello answers.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { coreCall } from './core'
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
const sessionName = (socketPath: string) => path.basename(socketPath).replace(/\.sock$/, '')
const holderSocket = (name: string) => /\.holder\.[^/]*\.sock$/.test(name)

// Cheap proof that a socket is an hc core, not another Unix socket in the same directory.
export async function probeHcCore(socketPath: string, timeoutMs = 800): Promise<boolean> {
  try {
    const hello = await coreCall<{ generation?: unknown, framed?: unknown, version?: unknown, methods?: unknown }>(
      socketPath,
      'hello',
      { generation: 1, framed: false },
      timeoutMs,
    )
    return hello?.generation === 1 && typeof hello.version === 'string' && Array.isArray(hello.methods)
  } catch {
    return false
  }
}

// Live hc session sockets directly inside the runtime directory. `probeTimeoutMs`
// is small: a stale socket or another service must not hold the scan back.
export async function scanHcSessionSockets(opts: HcSocketFilterOptions & { probeTimeoutMs?: number } = {}): Promise<string[]> {
  const env = opts.env ?? process.env
  const home = opts.home ?? env.HOME ?? os.homedir()
  const directory = coreRuntimeDir({ ...opts, env, home })
  if (!directory) return []
  let names: string[] = []
  try {
    names = (await fs.readdir(directory))
      .filter(name => name.endsWith('.sock') && !holderSocket(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  } catch {
    return []
  }
  const candidates = names.map(name => path.join(directory, name))
  const safe = await filterAllowedHcSockets(candidates, { ...opts, env, home, log: () => {} })
  const live = await Promise.all(safe.map(async socketPath => await probeHcCore(socketPath, opts.probeTimeoutMs ?? 800) ? socketPath : null))
  return live.filter((p): p is string => Boolean(p))
}

// The old explicit scan used by Settings. Kept as a read-only inventory endpoint
// for compatibility; the running pool no longer depends on settingsSockets.
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
  const discovered = await scanHcSessionSockets({ ...opts, env, home })
  const available = discovered
    .filter(p => !used.has(p))
    .map(p => ({ path: p, name: sessionName(p) }))
  return { directory, primary, envSockets, settingsSockets, available }
}
