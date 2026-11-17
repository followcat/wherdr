// Which Cline CLI session a pane shows. Each session is a folder under
// <data dir>/sessions, `<id>/<id>.json` (a manifest: session_id, pid, started_at,
// cwd, workspace_root, model) plus `<id>/<id>.messages.json` (the conversation).
// The data dir is `~/.cline/data` unless `--data-dir`, `CLINE_DATA_DIR` or
// `CLINE_SESSION_DATA_DIR` moves it.
//
// `--id <id>` in the launch arguments names a resumed session outright. With the
// local backend (`--yolo`, `--data-dir`) the manifest's pid is the engine
// `.cline` process under the pane's `node …/bin/cline`, so the PID matches. With
// the hub backend (`cline -i` alone) that pid is the shared hub daemon serving
// every session of the user, so the pane's folder and a start at or after the
// process start decide, newest first. No manifest (old directories) or no match
// resolves to nothing: a wrong guess would show another conversation.
import path from 'node:path'
import type { MachineFs } from './fsx'

export interface ClineProcess {
  pid?: number
  argv?: string[]
  // Exact argv (core's foreground process, or /proc/<pid>/cmdline).
  argvExact?: boolean
  // Upper bound on process birth, in ms (see devinProcesses.ts).
  startedAt?: number
}

export interface ClinePane {
  cwd: string | null
  // The terminal's creation time (herdr-core's created_ms).
  bornAt?: number
}

export interface ClineGuess { id: string, file: string }

// Session ids: `<epoch-ms>_<suffix>` today, an opaque token in general.
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
// A manifest is a few KB; anything far larger is not one.
const MAX_MANIFEST = 1024 * 1024
// Newest sessions first: the pane's conversation is among them, and a machine
// may hold hundreds of old sessions.
const MAX_MANIFESTS = 64

export const clineSessionId = (value: string | null | undefined): string | null =>
  value && ID.test(value) ? value : null

// Value of `--flag <value>` / `--flag=<value>` in a launch argv, before `--`.
function flag(argv: string[], name: string): string | null {
  for (let i = 1; i < argv.length && argv[i] !== '--'; i++) {
    const arg = argv[i]!
    if (arg === name) {
      const value = argv[i + 1]
      return value && !value.startsWith('-') ? value : null
    }
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return null
}

// Exact `--id <id>` of a resume; null for anything else.
export function clineIdFlag(argv: string[]): string | null {
  return clineSessionId(flag(argv, '--id'))
}

const stripSlash = (p: string) => p.replace(/\/+$/, '')

export function clineDataDir(home: string, procs: ClineProcess[], honorEnv = true): string {
  for (const proc of procs) {
    if (proc.argvExact !== true) continue
    const dir = flag(proc.argv || [], '--data-dir')
    if (dir && path.isAbsolute(dir)) return stripSlash(dir)
  }
  // The two variables are wherdr's own environment, not the pane's: they count
  // only when the wherdr service has them too. The agent's `/proc/<pid>/environ`
  // is never read (it holds secrets).
  if (honorEnv) {
    for (const name of ['CLINE_DATA_DIR', 'CLINE_SESSION_DATA_DIR']) {
      const dir = process.env[name]
      if (dir && path.isAbsolute(dir)) return stripSlash(dir)
    }
  }
  return path.join(home, '.cline/data')
}

// The local backend keeps one engine process per session, and its manifest
// names it; the hub backend's shared daemon does not.
export function clineLocalBackend(procs: ClineProcess[]): boolean {
  return procs.some(p => p.argvExact === true
    && (p.argv || []).some(a => a === '--yolo' || a === '--data-dir' || a.startsWith('--data-dir=')))
}

const normalizeDir = (p: string | null | undefined) => stripSlash(String(p || '').replace(/\\/g, '/'))
const startedMs = (value: unknown): number | null => {
  const at = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(at) ? at : null
}
// Newest first, by the epoch prefix then the whole id.
const newest = (a: { id: string }, b: { id: string }) =>
  (Number(b.id.split('_')[0]) - Number(a.id.split('_')[0])) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

function isMissing(e: unknown): boolean {
  const err = e as { code?: string, message?: string } | null
  if (!err) return false
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return true
  return err.code === 'remote' && /no such file|not a directory|introuvable/i.test(err.message || '')
}

const manifestFile = (dir: string, id: string) => path.join(dir, 'sessions', id, `${id}.json`)
export const clineMessagesFile = (dir: string, id: string) => path.join(dir, 'sessions', id, `${id}.messages.json`)

// Session folders whose manifest is present and readable, newest first.
// `accept` sees each manifest from the newest; the first one it takes ends the
// scan, so a machine with hundreds of old sessions reads only what it needs.
async function findManifest(
  fs: MachineFs, dir: string, accept: (manifest: Record<string, unknown>) => boolean, only?: string,
): Promise<string | null> {
  let names: string[]
  try { names = await fs.readdir(path.join(dir, 'sessions')) }
  catch (e) { if (isMissing(e)) return null; throw e }
  const ids = only
    ? (names.includes(only) ? [only] : [])
    : names.filter(n => clineSessionId(n)).sort((a, b) => newest({ id: a }, { id: b })).slice(0, MAX_MANIFESTS)
  if (!ids.length) return null
  // One round trip for the whole batch (a remote machine answers once).
  const stats = await fs.statMany(ids.map(id => manifestFile(dir, id)))
  const present = ids.filter((_, i) => stats[i]?.isFile && stats[i]!.size <= MAX_MANIFEST)
  for (const id of present) {
    let body: string
    try { body = await fs.readFile(manifestFile(dir, id)) }
    catch (e) { if (isMissing(e)) continue; throw e }
    let raw: unknown
    // A torn or foreign manifest is not one: skip it, it cannot name a session.
    try { raw = JSON.parse(body) } catch { continue }
    const manifest = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
    // The manifest names its own session; old folders without one are skipped.
    if (manifest && manifest.session_id === id && accept(manifest)) return id
  }
  return null
}

export async function clineSession(
  fs: MachineFs, home: string, procs: ClineProcess[], pane: ClinePane, honorEnv = true,
): Promise<ClineGuess | null> {
  if (!procs.length) return null
  const dir = clineDataDir(home, procs, honorEnv)
  const pick = (id: string | null): ClineGuess | null => (id ? { id, file: clineMessagesFile(dir, id) } : null)

  // 1. A resumed session named on the command line: its own manifest only.
  const named = procs.filter(p => p.argvExact === true).map(p => clineIdFlag(p.argv || [])).find(Boolean)
  if (named) return pick(await findManifest(fs, dir, () => true, named))

  // 2. Local backend: the engine process itself.
  if (clineLocalBackend(procs)) {
    const pids = new Set(procs.map(p => p.pid).filter((pid): pid is number => Number.isSafeInteger(pid) && pid! > 0))
    return pick(await findManifest(fs, dir, m => typeof m.pid === 'number' && pids.has(m.pid)))
  }

  // 3. Hub backend: the pane's folder, from the process start on, newest first.
  const cwd = normalizeDir(pane.cwd)
  if (!cwd) return null
  const starts = procs.map(p => p.startedAt).filter((at): at is number => typeof at === 'number' && Number.isFinite(at))
  const since = starts.length ? Math.min(...starts) : pane.bornAt
  return pick(await findManifest(fs, dir, (manifest) => {
    if (normalizeDir(manifest.cwd as string) !== cwd && normalizeDir(manifest.workspace_root as string) !== cwd) return false
    if (typeof since !== 'number') return true
    const at = startedMs(manifest.started_at)
    return at !== null && at >= since
  }))
}

