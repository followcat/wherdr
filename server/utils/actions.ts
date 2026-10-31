// Actions : lancer un agent ou un terminal, dossiers, panneaux, photos.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { AGENT_KINDS, DATA_DIR, HOME, RESUME_ARGS, UPLOAD_DIR, UPLOAD_TTL_MS, log } from './env'
import { HerdrError, herdr, herdrOn, sleep } from './herdr'
import { panelOpen } from './choices'
import { addQueued, findPane, pendingPrompts, poll, pollFresh } from './state'
import { findNewPane } from './newPane'
import { type Machine, RemoteMachine, allMachines, getMachine, machineOfPane } from './machines'
import { type DirDenied, type DirEntryRaw, LIST_DIRS_SCRIPT, dirDeniedFromCode, dirDeniedFromError, listDirsLocal, parseDirList } from './fsx'
import { PANE_RE, joinId, toAgentName } from '../../shared/ids'
import { cleanLabel } from '../../shared/spaceActions'
import { safeUploadExtension } from '../../shared/uploadName'
import type { DirEntry, DirListing, MachineConfig } from '../../shared/types'
import { installedAgentKinds } from './agentAvailability'
import { fmt } from '../../shared/message'

const fsp = fs.promises
const px = path.posix

// Machine targeted by a request (`machine`: short key, empty = local), ready.
export function machineFor(key: unknown): Machine {
  const m = getMachine(String(key || ''))
  if (!m) throw new HerdrError('bad_machine', 'unknown machine')
  if (!m.local && (m.status !== 'online' || !m.home)) throw new HerdrError('unreachable', m.error ? fmt('{machine} is unreachable: {reason}', { machine: m.label, reason: m.error }) : fmt('{machine} is unreachable', { machine: m.label }))
  return m
}

export function underHome(p: unknown, home = HOME): string | null {
  const r = px.resolve(home, String(p || '').replace(/^~(?=$|\/)/, home))
  return r === home || r.startsWith(home + '/') ? r : null
}

export async function isGitRepo(dir: string, m: Machine = getMachine('')!) {
  try {
    await m.fs.stat(px.join(dir, '.git'))
    return true
  } catch { return false }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

// Path passed to the pane's shell, in single quotes.
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export async function createAgent(body: Json) {
  const kind = String(body.kind || '')
  // `shell`: a plain terminal, without an agent.
  if (kind !== 'shell' && !AGENT_KINDS.includes(kind)) throw new HerdrError('bad_kind', fmt('Unknown agent: {kind}', { kind }))
  // Existing pane (terminal just created by "Split"): the agent starts there,
  // on its machine and in its folder, without a new workspace.
  let target = body.pane_id ? findPane(String(body.pane_id)) || null : null
  // Pane just created ("Split", "New tab"): wherdr's pane list may not have
  // seen it yet. Its machine is in its id: fresh polls of that machine, for a
  // short while. Machine offline: said as such, not "Pane not found".
  if (body.pane_id && !target && PANE_RE.test(String(body.pane_id))) {
    const id = String(body.pane_id)
    const pm = machineOfPane(id)
    if (pm) {
      machineFor(pm.key)
      target = (await findNewPane(id, { find: findPane, refresh: () => pollFresh(pm), sleep })) || null
    }
  }
  if (body.pane_id) {
    if (!PANE_RE.test(String(body.pane_id)) || !target) throw new HerdrError('bad_pane', 'Pane not found')
    if (target.agent) throw new HerdrError('busy_pane', 'An agent is already running in this pane')
    if (body.worktree) throw new HerdrError('bad_worktree', 'No worktree in an existing pane')
  }
  // Machine where the agent is launched (local by default).
  const m = machineFor(target ? target.machine || '' : body.machine)
  if (kind !== 'shell' && !(await installedAgentKinds(m)).includes(kind)) throw new HerdrError('not_installed', fmt('{kind} is not installed on {machine}', { kind, machine: m.label }))
  const hx = <T = Json>(method: string, params: Record<string, unknown>, timeoutMs?: number) => herdrOn<T>(m.key, method, params, timeoutMs)
  const gid = (id: string) => joinId(m.key, id)
  const cwd = underHome(body.cwd || (target && target.cwd) || m.home, m.home)
  if (!cwd) throw new HerdrError('bad_cwd', fmt('The folder must be under {home}', { home: m.home }))
  try {
    if (!(await m.fs.stat(cwd)).isDir) throw new Error()
  } catch { throw new HerdrError('bad_cwd', fmt('Folder not found: {path}', { path: cwd })) }

  // Typed name, kept as typed (spaces, capitals): it names the new space, or
  // the pane in an existing space. Herdr's agent id must be a slug, so it is
  // derived from it (random when nothing usable is left, e.g. only emoji).
  const shown = cleanLabel(body.name)
  const name = toAgentName(shown) || `${kind}-${crypto.randomBytes(2).toString('hex')}`
  const label = cleanLabel(body.label) || shown || px.basename(cwd) || '~'

  // Worktree: the agent works on its own branch, in a separate folder
  // (~/.herdr/worktrees/<repo>/<branch>), without touching the original folder.
  // Herdr also opens the original repository if it is not open, and groups both.
  let created: Json
  if (body.worktree) {
    if (!(await isGitRepo(cwd, m))) throw new HerdrError('not_git', fmt('Not a Git repository: {path}', { path: cwd }))
    let branch = String(body.branch || '').trim()
    if (branch && !/^[\w][\w./-]{0,79}$/.test(branch)) throw new HerdrError('bad_branch', 'Invalid branch name')
    if (!branch) branch = `${kind === 'shell' ? 'shell' : kind}-${crypto.randomBytes(2).toString('hex')}`
    const params = { cwd, branch, label: cleanLabel(body.label) || shown || branch, focus: false, trust_repository: true }
    try {
      created = await hx('worktree.create', params, 30000)
    } catch (e) {
      // Seen once right after Herdr started: repository not recognized yet.
      if ((e as HerdrError).code !== 'not_git_worktree') throw e
      await sleep(1000)
      created = await hx('worktree.create', params, 30000)
    }
  } else if (!target) {
    created = await hx('workspace.create', { cwd, label, focus: false })
  }
  // IDs local to the machine -> app IDs (prefixed for a remote machine).
  const paneId: string = target ? target.id : gid(created.root_pane.pane_id)
  const wsId: string = target ? target.workspace : gid(created.workspace.workspace_id)
  // Existing pane in a folder other than the chosen one: cd there first.
  if (target && cwd !== target.cwd) {
    await herdr('pane.send_input', { pane_id: paneId, text: `cd ${shellQuote(cwd)}` })
    await herdr('pane.send_input', { pane_id: paneId, keys: ['enter'] })
  }
  if (kind === 'shell') {
    // Start command: typed right away, the terminal buffers it
    // until the shell shows its prompt.
    const cmd = String(body.prompt || '').trim()
    if (cmd) {
      await herdr('pane.send_input', { pane_id: paneId, text: cmd })
      await herdr('pane.send_input', { pane_id: paneId, keys: ['enter'] })
    }
    await rememberDir(cwd, m)
    poll()
    return { pane_id: paneId, workspace_id: wsId, name: null }
  }
  // The Herdr server may have a minimal PATH (service, SSH session). The
  // executables detected in the usual folders must also be visible
  // in the new pane's shell, before `agent.start`.
  const pathSetup = 'export PATH="$HOME/.local/bin:$HOME/.kimi-code/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"'
  await herdr('pane.send_input', { pane_id: paneId, text: pathSetup })
  await herdr('pane.send_input', { pane_id: paneId, keys: ['enter'] })
  await sleep(400)
  // The brand new pane's shell is not necessarily at its prompt yet:
  // agent.start refuses until it is, so we retry for a few seconds.
  let lastErr: HerdrError | null = null
  for (let i = 0; i < 16; i++) {
    try {
      const args = body.resume ? RESUME_ARGS[kind] || [] : []
      await herdr('agent.start', { name, kind, pane_id: paneId, timeout_ms: 60000, ...(args.length ? { args } : {}) }, 75000)
      lastErr = null
      break
    } catch (e) {
      lastErr = e as HerdrError
      if (lastErr.code === 'agent_not_ready') { lastErr = null; break } // started but blocked (e.g. folder trust)
      if (lastErr.code === 'timeout' || lastErr.code === 'unreachable' || /name/i.test(lastErr.code)) break
      await sleep(500)
    }
  }
  if (lastErr) {
    // The existing pane stays, as a plain terminal.
    if (!target) await herdr('workspace.close', { workspace_id: wsId }).catch(() => {})
    throw lastErr
  }
  // An existing space keeps its name: the typed one goes on the pane.
  if (target && shown) await herdr('pane.rename', { pane_id: paneId, label: shown }).catch(e => log(`pane.rename ${paneId}: ${(e as Error).message}`))
  // agent.start returns before the agent is ready (launch_pending), and it
  // may still stop on a prompt (folder trust). The first
  // message therefore waits its turn: it goes out on the first idle state.
  if (body.prompt && String(body.prompt).trim()) {
    pendingPrompts.set(paneId, { text: String(body.prompt), at: Date.now() })
    addQueued(paneId, body.prompt)
  }
  await rememberDir(cwd, m)
  poll()
  return { pane_id: paneId, workspace_id: wsId, name }
}

// Recent folders (the 30 last, most recent first): `dirs` for the local
// machine (old format), and `machines[<profile id>]` for the others.
const DIRS_FILE = path.join(DATA_DIR, 'dirs.json')
async function readDirsFile(): Promise<{ dirs?: string[], machines?: Record<string, string[]> }> {
  try { return JSON.parse(await fsp.readFile(DIRS_FILE, 'utf8')) || {} }
  catch { return {} }
}
const dirsKey = (m: Machine) => m.profileId || m.key
export async function recentDirs(m: Machine = getMachine('')!): Promise<string[]> {
  const f = await readDirsFile()
  return (m.local ? f.dirs : f.machines && f.machines[dirsKey(m)]) || []
}
async function rememberDir(d: string, m: Machine) {
  const f = await readDirsFile()
  const dirs = [d, ...(await recentDirs(m)).filter(x => x !== d)].slice(0, 30)
  if (m.local) f.dirs = dirs
  else f.machines = { ...(f.machines || {}), [dirsKey(m)]: dirs }
  await fsp.mkdir(DATA_DIR, { recursive: true })
  await fsp.writeFile(DIRS_FILE, JSON.stringify(f, null, 2) + '\n')
}

// Machines offered in the "New" sheet (only present if there are several).
export async function machineConfigs(): Promise<MachineConfig[] | undefined> {
  const ms = allMachines()
  if (ms.length < 2) return undefined
  return Promise.all(ms.map(async m => ({
    key: m.key, label: m.label, local: m.local, home: m.home,
    kinds: m.local || m.status === 'online' ? await installedAgentKinds(m) : [],
    dirs: await recentDirs(m), online: m.local || (m.status === 'online' && Boolean(m.home)),
  })))
}

export async function listDirs(p: string | null, machine: unknown = ''): Promise<DirListing> {
  const m = machineFor(machine)
  const home = m.home
  const dir = underHome(p || home, home)
  if (!dir) throw new HerdrError('bad_path', fmt('Outside {home}', { home }))
  const remote = m instanceof RemoteMachine
  const parent = dir === home ? null : px.dirname(dir)
  let raw: DirEntryRaw[]
  let denied: DirDenied | null = null
  if (m instanceof RemoteMachine) {
    const r = await m.exec(LIST_DIRS_SCRIPT, [dir], { timeoutMs: 15000 })
    denied = dirDeniedFromCode(r.code)
    if (r.code !== 0 && !denied) throw new HerdrError('bad_path', fmt('Folder unreadable: {path}', { path: dir }))
    raw = parseDirList(r.stdout.toString('utf8'))
  } else {
    try { raw = await listDirsLocal(dir) }
    catch (err) {
      denied = dirDeniedFromError(err)
      if (!denied) throw new HerdrError('bad_path', fmt('Folder unreadable: {path}', { path: dir }))
      raw = []
    }
  }
  // Parent and typed path stay usable: the window explains instead of "No subfolders".
  if (denied) return { path: dir, parent, home, dirs: [], denied, ...(remote ? { remote } : {}) }
  const out: DirEntry[] = raw.map(e => ({ name: e.name, path: px.join(dir, e.name), git: e.git }))
  out.sort((a, b) => (Number(b.git) - Number(a.git)) || a.name.localeCompare(b.name))
  return { path: dir, parent, home, dirs: out }
}

// --- Open panels ------------------------------------------------------------
// Some commands (/usage, /context all…) open a full-screen panel
// that hides the input field until Escape is pressed: a message
// sent meanwhile is lost.
// Closes any panel of an idle agent (never while it is
// working: Escape would interrupt it). Returns true if an Escape was sent.
export async function closePanel(paneId: string) {
  const p = findPane(paneId)
  if (!p || !p.agent || !['idle', 'done', 'unknown'].includes(p.status || '')) return false
  let sent = false
  for (let i = 0; i < 2; i++) {
    const r = await herdr('pane.read', { pane_id: paneId, source: 'detection' }, 4000)
    if (!panelOpen(r.read && r.read.text, p.agent)) return sent
    await herdr('pane.send_input', { pane_id: paneId, keys: ['esc'] })
    sent = true
    await sleep(400)
  }
  return sent
}

// --- Photos ----------------------------------------------------------------
export const UPLOAD_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic' }
// Photo for an agent on a remote machine: kept here (app
// thumbnails, /uploads/<name>) and copied to its machine, whose path is returned.
export async function saveUpload(data: Buffer, ctype: string, paneId?: string | null, requestedExtension?: string) {
  const ext = requestedExtension === undefined ? UPLOAD_TYPES[ctype] : safeUploadExtension(requestedExtension)
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.${ext}`
  const file = path.join(UPLOAD_DIR, name)
  if (!data.length) throw new HerdrError('empty', 'Empty file')
  const m = paneId ? machineOfPane(paneId) : null
  if (paneId && !m) throw new HerdrError('bad_pane', 'Pane not found')
  await fsp.mkdir(UPLOAD_DIR, { recursive: true })
  await fsp.writeFile(file, data, { mode: 0o600 })
  if (m instanceof RemoteMachine) {
    if (m.status !== 'online') throw new HerdrError('unreachable', fmt('{machine} is unreachable', { machine: m.label }))
    const remote = await m.putUpload(name, data)
    log(`photo received ${name} (${Math.round(data.length / 1024)} KB) -> ${m.label}`)
    return { path: remote, name }
  }
  log(`photo received ${name} (${Math.round(data.length / 1024)} KB)`)
  return { path: file, name }
}
export async function cleanUploads() {
  try {
    for (const n of await fsp.readdir(UPLOAD_DIR)) {
      const f = path.join(UPLOAD_DIR, n)
      const st = await fsp.stat(f)
      if (Date.now() - st.mtimeMs > UPLOAD_TTL_MS) await fsp.unlink(f)
    }
  } catch { /* folder missing */ }
}
// Photo already stored, re-read by its name (never outside the store).
export async function readUpload(name: string) {
  if (!/^[\w.-]+\.(jpg|png|webp|gif|heic)$/.test(name)) return null
  const ext = name.split('.').pop()!
  return { type: ext === 'jpg' ? 'image/jpeg' : `image/${ext}`, body: await fsp.readFile(path.join(UPLOAD_DIR, name)) }
}
