// wherdr plugins (client side): prebuilt ESM bundles in DATA_DIR/plugins/<id>/,
// described by a manifest.json. Shared by the server (list, serve) and the page.

import type { AgentStatus, MachineInfo, Pane } from './types'

/** Public read-only agent summary exposed to client plugins (never carries coreAddress, cwd, session, or socket paths). */
export interface PublicAgent {
  id: string
  machine: string | null
  name: string | null
  title: string | null
  agent: string | null
  status: AgentStatus | null
  labels: Record<string, string>
}

/** Public machine summary exposed to client plugins (never carries session or connection errors). */
export interface PublicMachine {
  id: string
  groupKey: string
  label: string
  local: boolean
  status: MachineInfo['status']
}

function cloneLabels(labels?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  if (!labels) return out
  for (const key of Object.keys(labels).sort()) {
    const value = labels[key]
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/** Copy a list of PublicAgent objects and their label maps so plugin mutations stay isolated. */
export function clonePublicAgents(list: readonly PublicAgent[]): PublicAgent[] {
  return list.map(a => ({
    id: a.id,
    machine: a.machine,
    name: a.name,
    title: a.title,
    agent: a.agent,
    status: a.status,
    labels: cloneLabels(a.labels),
  }))
}

/** Copy a list of PublicMachine objects so plugin mutations stay isolated. */
export function clonePublicMachines(list: readonly PublicMachine[]): PublicMachine[] {
  return list.map(m => ({
    id: m.id,
    groupKey: m.groupKey,
    label: m.label,
    local: m.local,
    status: m.status,
  }))
}

/** Project core Pane state held by the client into plugin-safe PublicAgent objects. */
export function projectAgents(panes: readonly Pane[]): PublicAgent[] {
  return panes.map(p => ({
    id: p.id,
    machine: p.machine || null,
    name: p.name || p.label || null,
    title: p.title ?? null,
    agent: p.agent ?? null,
    status: p.status ?? null,
    labels: cloneLabels(p.labels),
  }))
}

/** Project MachineInfo entries held by the client into plugin-safe PublicMachine objects. */
export function projectMachines(machines: readonly MachineInfo[]): PublicMachine[] {
  return machines.map(m => ({
    id: m.key,
    groupKey: m.baseKey ?? m.key,
    label: m.label,
    local: m.local,
    status: m.status,
  }))
}

export interface ClientPluginInfo {
  id: string
  name: string
  version: string
  description: string
  // Bundle file, relative to the plugin's folder.
  main: string
  // Installed from GitHub (pluginInstall.ts): the repo, the ref asked ('' = the
  // latest release, else the default branch) and the exact commit.
  source?: PluginSource
}

export interface PluginSource { repo: string, ref: string, commit: string }
// Next to the plugin's files; a dot file, so never served nor taken from a repo.
export const SOURCE_FILE = '.source.json'

export function parseSource(raw: unknown): PluginSource | null {
  const s = raw as Partial<PluginSource> | null
  if (!s || typeof s.repo !== 'string' || typeof s.commit !== 'string') return null
  return { repo: s.repo, ref: typeof s.ref === 'string' ? s.ref : '', commit: s.commit }
}

export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const PLUGIN_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

// Returns the cleaned manifest, or null when it is unusable.
export function parseManifest(id: string, raw: unknown): ClientPluginInfo | null {
  if (!PLUGIN_ID_RE.test(id) || !raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  const main = str(m.main, 128) || 'index.js'
  if (!PLUGIN_FILE_RE.test(main) || !/\.m?js$/.test(main)) return null
  return {
    id,
    name: str(m.name, 80) || id,
    version: str(m.version, 32),
    description: str(m.description, 300),
    main,
  }
}

// Persisted per device: which plugins the person turned off, and which ones
// were disabled after a failure (with the message shown in Settings).
export interface PluginPrefs { off: string[], failed: Record<string, string> }

export function readPrefs(raw: string | null): PluginPrefs {
  try {
    const p = JSON.parse(raw || '{}') as Partial<PluginPrefs>
    const failed: Record<string, string> = {}
    for (const [k, v] of Object.entries(p.failed && typeof p.failed === 'object' ? p.failed : {})) if (typeof v === 'string') failed[k] = v.slice(0, 300)
    return { off: Array.isArray(p.off) ? p.off.filter((x): x is string => typeof x === 'string') : [], failed }
  } catch { return { off: [], failed: {} } }
}

// The Community plugins switch, one for the server (settings.json). Unset is
// an install from before the switch: on when its plugins folder already holds
// plugins (they keep loading after the update), off otherwise.
export function communityOn(raw: string | null | undefined, installed: number): boolean {
  return raw === '1' || (raw !== '0' && installed > 0)
}
