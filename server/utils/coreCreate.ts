// New terminal / agent, folders and machines on herdr-core. Creation goes through
// terminal.run (no inherited parent, a correlation label, never replayed blindly);
// folders, home and installed agents of any machine through machine.exec.
import crypto from 'node:crypto'
import { posix as px } from 'node:path'
import { CoreError } from './core'
import { HerdrError } from './herdr'
import { failure } from './coreInput'
import { AGENT_KINDS, RESUME_ARGS } from './env'
import { HERDR_AGENT_KINDS, availableAgentKinds } from '../../shared/launchableAgents'
import { KIND_PROBE_SCRIPT } from './agentAvailability'
import { LIST_DIRS_SCRIPT, dirDeniedFromCode, parseDirList } from './fsx'
import { toAgentName } from '../../shared/ids'
import { cleanLabel } from '../../shared/spaceActions'
import { fmt } from '../../shared/message'
import { placementLabels } from '../../shared/coreLayout'
import { coreCapabilities, hasPort, type CoreCapabilities } from '../../shared/coreCapabilities'
import type { DirEntry, DirListing, MachineConfig, MachineInfo, Pane, Workspace } from '../../shared/types'

export interface CoreAdminDeps {
  call: <T>(method: string, params: object, timeout: number) => Promise<T>
  machines: () => MachineInfo[]
  panes: () => Pane[]
  workspaces: () => Workspace[]
  settle: () => Promise<unknown> // fresh inventory, published
  recent: (m: MachineInfo) => Promise<string[]>
  remember: (dir: string, m: MachineInfo) => Promise<unknown>
  launchWatchMs?: number // how long a new agent is watched for an immediate failure (default 2 s)
  queueWatchMs?: number // how long a first message waits for a dialog to be answered (default 10 min)
  onQueued?: (watch: Promise<unknown>) => void // test hook: the background wait of a queued first message
  readyWatchMs?: number // how long the first message waits for the program to be ready (default 15 s)
  pollMs?: number // readiness polling step (default 500 ms)
}

const REQUEST_LABEL = 'wherdr-request'
export const PATH_SETUP = 'export PATH="$HOME/.local/bin:$HOME/.kimi-code/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"'
const TARGET_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@:%[\]-]{0,199}$/
const NAME_RE = /^[a-z0-9_][a-z0-9_.-]{0,31}$/

// Machine of a request (key '' = this one): its `on` name, or undefined for the local core.
export function machineOn(deps: CoreAdminDeps, key: unknown): { m: MachineInfo, on?: string } {
  const m = deps.machines().find(x => x.key === String(key || ''))
  if (!m) throw new HerdrError('bad_machine', 'unknown machine')
  if (!m.local && m.status !== 'online') throw new HerdrError('unreachable', fmt('{machine} is unreachable', { machine: m.label }))
  return { m, on: m.local ? undefined : m.label }
}

async function exec(deps: CoreAdminDeps, on: string | undefined, script: string, args: string[] = []) {
  try {
    const r = await deps.call<{ code: number | null, stdout: string, timed_out?: boolean }>('machine.exec',
      { argv: ['sh', '-c', script, 'sh', ...args], ...(on ? { on } : {}), timeout: 10 }, 15000)
    if (r.timed_out) throw new CoreError('timeout', 'timeout')
    return { code: r.code, stdout: Buffer.from(r.stdout || '', 'base64').toString('utf8') }
  } catch (e) { return failure(e) }
}

export async function homeOf(deps: CoreAdminDeps, on?: string) {
  const r = await exec(deps, on, 'printf %s "$HOME"')
  return r.code === 0 ? r.stdout.trim() : ''
}

const kindsCache = new Map<string, { at: number, kinds: string[] }>()
export async function kindsOf(deps: CoreAdminDeps, on?: string) {
  const old = kindsCache.get(on || '')
  if (old && Date.now() - old.at < 30_000) return old.kinds
  const candidates = HERDR_AGENT_KINDS.filter(k => AGENT_KINDS.includes(k))
  const r = await exec(deps, on, KIND_PROBE_SCRIPT, candidates)
  const found = r.code === 0 ? r.stdout.split('\n').filter(Boolean) : []
  const kinds = availableAgentKinds(found, AGENT_KINDS)
  kindsCache.set(on || '', { at: Date.now(), kinds })
  return kinds
}

// Folder under the machine's home (the same rule as v2).
function underHome(p: unknown, home: string): string | null {
  const r = px.resolve(home, String(p || '').replace(/^~(?=$|\/)/, home))
  return r === home || r.startsWith(home + '/') ? r : null
}

export async function coreListDirs(deps: CoreAdminDeps, path: string | null, machine: unknown): Promise<DirListing> {
  const { on } = machineOn(deps, machine)
  const home = await homeOf(deps, on)
  const dir = home && underHome(path || home, home)
  if (!dir) throw new HerdrError('bad_path', fmt('Outside {home}', { home }))
  const parent = dir === home ? null : px.dirname(dir)
  const r = await exec(deps, on, LIST_DIRS_SCRIPT, [dir])
  const denied = dirDeniedFromCode(r.code)
  if (r.code !== 0 && !denied) throw new HerdrError('bad_path', fmt('Folder unreadable: {path}', { path: dir }))
  if (denied) return { path: dir, parent, home, dirs: [], denied, ...(on ? { remote: true } : {}) }
  const dirs: DirEntry[] = parseDirList(r.stdout).map(e => ({ name: e.name, path: px.join(dir, e.name), git: e.git }))
  dirs.sort((a, b) => (Number(b.git) - Number(a.git)) || a.name.localeCompare(b.name))
  return { path: dir, parent, home, dirs }
}

export async function coreIsGit(deps: CoreAdminDeps, path: string | null, machine: unknown) {
  const { on } = machineOn(deps, machine)
  const home = await homeOf(deps, on)
  const dir = home && underHome(path || home, home)
  if (!dir) return { git: false }
  return { git: (await exec(deps, on, 'test -e "$1/.git"', [dir])).code === 0 }
}

// Machines of the "New" sheet (only with several).
export async function coreMachineConfigs(deps: CoreAdminDeps): Promise<MachineConfig[] | undefined> {
  const ms = deps.machines()
  if (ms.length < 2) return undefined
  return Promise.all(ms.map(async (m) => {
    const online = m.local || m.status === 'online'
    const on = m.local ? undefined : m.label
    const [home, kinds] = online ? await Promise.all([homeOf(deps, on).catch(() => ''), kindsOf(deps, on).catch(() => [])]) : ['', []]
    return { key: m.key, label: m.label, local: m.local, home, kinds, dirs: await deps.recent(m), online: online && Boolean(home) }
  }))
}

interface CoreFacts { state?: string, exit_code?: number | null, signal?: string | null, reason?: string }

// An agent that ends with a failure within a couple of seconds did not start: say so with
// the exit code and the last lines it printed, rather than leaving a dead entry to find.
export async function launchFailure(deps: CoreAdminDeps, address: string, ms: number): Promise<{ code: string, lines: string } | null> {
  const end = Date.now() + ms
  do {
    const t = await deps.call<CoreFacts>('terminal.get', { terminal: address }, 3000).catch(() => null)
    if (t?.state === 'finished') {
      if (t.exit_code === 0) return null
      const out = await deps.call<{ text?: string }>('terminal.read', { terminal: address, lines: 20 }, 3000).catch(() => null)
      const lines = String(out?.text || '').split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-8).join('\n')
      return { code: t.exit_code == null ? String(t.signal || t.reason || '?') : String(t.exit_code), lines }
    }
    if (Date.now() < end) await new Promise(r => setTimeout(r, 250))
  } while (Date.now() < end)
  return null
}

const MAX_FIRST = 64 * 1024
// A dialog the program waits on (trust a folder, confirm, a numbered menu): nothing is typed into it.
const DIALOG_RE = /Enter to confirm|Esc to cancel|\(y\/n\)|\[y\/N\]|enter continue|esc back|trust (this|the) folder|^\s*[›>❯]\s*1\.\s/im
// A program that reports no status at all is trusted once its screen has been still this long.
const STILL_POLLS = 6

// Sends the first message once, when the program is ready: core says it is idle and its
// screen is still, else (no status reported) the screen has been still for a few seconds.
// Codex shows its composer for ~2 s before the folder trust dialog, and core reports no
// state until the dialog is answered: a still screen alone is not enough when a status exists.
// Never retried or replayed: a program that ends or stays busy past the deadline gets
// nothing ('skipped'); one that shows a dialog or blocks is 'dialog' (see sendAfterDialog).
export async function sendFirstMessage(deps: CoreAdminDeps, address: string, text: string): Promise<'sent' | 'skipped' | 'dialog'> {
  const step = deps.pollMs ?? 500
  const end = Date.now() + (deps.readyWatchMs ?? 15000)
  let last = '', stable = 0, sawStatus = false
  while (Date.now() < end) {
    const t = await deps.call<CoreFacts & { status?: string | { state?: string } | null }>('terminal.get', { terminal: address }, 3000).catch(() => null)
    const state = typeof t?.status === 'string' ? t.status : t?.status?.state
    if (!t || t.state === 'finished') return 'skipped'
    if (state === 'blocked') return 'dialog'
    if (state) sawStatus = true
    const screen = String((await deps.call<{ text?: string }>('terminal.read', { terminal: address, lines: 40 }, 3000).catch(() => null))?.text || '')
    if (DIALOG_RE.test(screen)) return 'dialog'
    stable = screen.trim() && screen === last ? stable + 1 : 0
    last = screen
    if (state === 'idle' ? stable >= 2 : !sawStatus && stable >= STILL_POLLS) {
      try { await deps.call('terminal.send', { terminal: address, text }, 30000); return 'sent' } catch { return 'skipped' }
    }
    await new Promise(r => setTimeout(r, step))
  }
  return 'skipped'
}

// The first message of a program that opened on a dialog (trust this folder): waits in the
// background until the person has answered it, then sends it once. Gives up after queueWatchMs.
export async function sendAfterDialog(deps: CoreAdminDeps, address: string, text: string): Promise<'sent' | 'skipped'> {
  const end = Date.now() + (deps.queueWatchMs ?? 600_000)
  while (Date.now() < end) {
    await new Promise(r => setTimeout(r, (deps.pollMs ?? 500) * 2))
    const r = await sendFirstMessage(deps, address, text).catch(() => 'skipped' as const)
    if (r !== 'dialog') return r
  }
  return 'skipped'
}

export interface CreateBody { kind?: unknown, machine?: unknown, cwd?: unknown, name?: unknown, workspace?: unknown, prompt?: unknown, resume?: unknown }

const newId = (prefix: string) => prefix + crypto.randomBytes(16).toString('hex')
// herdr-app placement: a new tab of the given space, else of the space holding the
// folder, else of a new space. A folder-grouped workspace ("workspace" without a herdr-app
// space) keeps its terminal unlabelled so that it stays beside the others.
export function creationLabels(deps: CoreAdminDeps, m: MachineInfo, cwd: string, workspace: unknown) {
  const mine = deps.workspaces().filter(w => (w.machine || '') === m.key)
  const target = workspace ? mine.find(w => w.id === String(workspace)) : undefined
  if (workspace && !target?.coreSpace) return {}
  return placementLabels(mine.filter(w => w.coreSpace).map(w => ({ id: w.coreSpace!, folder: w.path })), cwd, newId, target?.coreSpace)
}

// Creates a terminal ('shell') or an agent CLI in a folder. The result is only
// "uncertain" (never a blind second launch) when core did not answer in time and the
// correlation label finds nothing in the inventory.
export async function coreCreate(deps: CoreAdminDeps, body: CreateBody) {
  const kind = String(body.kind || '')
  if (kind !== 'shell' && !AGENT_KINDS.includes(kind)) throw new HerdrError('bad_kind', fmt('Unknown agent: {kind}', { kind }))
  const { m, on } = machineOn(deps, body.machine)
  if (kind !== 'shell' && !(await kindsOf(deps, on)).includes(kind)) throw new HerdrError('not_installed', fmt('{kind} is not installed on {machine}', { kind, machine: m.label }))
  const home = await homeOf(deps, on)
  const cwd = home && underHome(body.cwd || home, home)
  if (!cwd) throw new HerdrError('bad_cwd', fmt('The folder must be under {home}', { home }))
  if ((await exec(deps, on, 'test -d "$1"', [cwd])).code !== 0) throw new HerdrError('bad_cwd', fmt('Folder not found: {path}', { path: cwd }))
  const first = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (first.length > MAX_FIRST) throw new HerdrError('too_large', 'Message too large')
  const typed = cleanLabel(body.name)
  const name = toAgentName(typed)
  if (name && !NAME_RE.test(name)) throw new HerdrError('bad_name', 'Invalid name')
  const request = crypto.randomBytes(8).toString('hex')
  const params = {
    cwd, ...(on ? { on } : {}), ...(name ? { name } : {}), no_parent: true, wait: false,
    labels: { [REQUEST_LABEL]: request, ...creationLabels(deps, m, cwd, body.workspace) }, ...(kind === 'shell' ? {} : { line: `${PATH_SETUP}; exec ${[kind, ...(body.resume === true ? RESUME_ARGS[kind] || [] : [])].join(' ')}` }),
  }
  let address: string
  try {
    address = (await deps.call<{ address: string }>('terminal.run', params, 30000)).address
  } catch (e) {
    const kindOf = e instanceof CoreError ? e.kind : ''
    if (!['timeout', 'disconnected', 'protocol'].includes(kindOf)) return failure(e)
    // The program may exist: look for the request's label before saying anything.
    const found = await deps.call<{ terminals: { address: string, labels?: Record<string, string> }[] }>('terminal.list', {}, 8000)
      .then(r => r.terminals.find(t => t.labels?.[REQUEST_LABEL] === request)?.address, () => undefined)
    if (!found) throw new HerdrError('uncertain', 'herdr-core did not confirm: check the list before creating it again')
    address = found
  }
  await deps.remember(cwd, m).catch(() => {})
  const [failed] = await Promise.all([kind === 'shell' ? null : launchFailure(deps, address, deps.launchWatchMs ?? 2000), deps.settle()])
  if (failed) throw new HerdrError('launch_failed', fmt('{kind} stopped right after starting (exit code {code}). Last output:\n{lines}', { kind, code: failed.code, lines: failed.lines || '(none)' }))
  const pane = deps.panes().find(p => p.coreAddress === address)
  if (!pane) throw new HerdrError('uncertain', 'Created, but not in the list yet: check the list before creating it again')
  // The program needs time to start: wait for it so that the sheet can say when nothing was
  // typed. A failure here must not undo the creation.
  let sent: 'sent' | 'skipped' | 'queued' | null = null
  if (first) {
    const r = await sendFirstMessage(deps, address, first).catch(() => 'skipped' as const)
    sent = r === 'dialog' ? 'queued' : r
    if (r === 'dialog') {
      const watch = sendAfterDialog(deps, address, first)
      deps.onQueued?.(watch)
    }
  }
  return { pane_id: pane.id, workspace_id: pane.workspace, name: kind === 'shell' ? null : name || kind, first_message: sent }
}

// Adds a machine over SSH (like `hc machine add <target>`): no command (`via`) and no
// installation from here; the target is checked so that it can never be read as an ssh option.
export async function coreAddMachine(deps: CoreAdminDeps, body: { target?: unknown, name?: unknown }) {
  const target = typeof body.target === 'string' ? body.target.trim() : ''
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!TARGET_RE.test(target)) throw new HerdrError('bad_target', 'Invalid SSH target')
  if (name && !NAME_RE.test(name)) throw new HerdrError('bad_name', 'The name uses a-z, 0-9, - _ . (32 at most)')
  // A core that takes no port says so here instead of a vague SSH failure. Unknown
  // (discover failed): machine.add answers for itself.
  if (hasPort(target) && (await coreCaps(deps))?.hostPort === false) throw new HerdrError('port_unsupported', PORT_UNSUPPORTED)
  try {
    await deps.call('machine.add', { target, ...(name ? { name } : {}) }, 60000)
  } catch (e) {
    const kind = e instanceof CoreError ? e.kind : ''
    const text: Record<string, string> = {
      name_taken: 'A machine with this name already exists', already_added: 'This machine is already added',
      unreachable: 'The machine cannot be reached over SSH', hc_missing: 'herdr-core is not installed on that machine',
      incompatible: 'The herdr-core version of that machine is incompatible', invalid_params: 'Invalid machine',
    }
    if (text[kind]) throw new HerdrError(kind, text[kind]!)
    return failure(e)
  }
  await deps.settle()
  return { ok: true }
}

export const PORT_UNSUPPORTED = 'This herdr-core takes no port: update it, or use a Host from ~/.ssh/config'

// What this core accepts (rpc.discover), or null when it cannot be read.
export async function coreCaps(deps: CoreAdminDeps): Promise<CoreCapabilities | null> {
  const discover = await deps.call<Parameters<typeof coreCapabilities>[0]>('rpc.discover', {}, 8000).catch(() => null)
  return discover && Array.isArray(discover.methods) ? coreCapabilities(discover) : null
}

function remoteMachine(deps: CoreAdminDeps, key: unknown) {
  const m = deps.machines().find(x => x.key === String(key || '') && !x.local)
  if (!m) throw new HerdrError('bad_machine', 'unknown remote machine')
  return m
}

// Renames a machine here only (addresses with the old name stop working).
export async function coreRenameMachine(deps: CoreAdminDeps, body: { key?: unknown, name?: unknown }) {
  const m = remoteMachine(deps, body.key)
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!NAME_RE.test(name)) throw new HerdrError('bad_name', 'The name uses a-z, 0-9, - _ . (32 at most)')
  try { await deps.call('machine.rename', { machine: m.label, new_name: name }, 15000) } catch (e) {
    if (e instanceof CoreError && e.kind === 'name_taken') throw new HerdrError('name_taken', 'A machine with this name already exists')
    return failure(e)
  }
  await deps.settle()
  return { ok: true }
}

// Forgets a machine: only this core's entry goes, its terminals keep running there.
export async function coreForgetMachine(deps: CoreAdminDeps, key: unknown) {
  const m = remoteMachine(deps, key)
  try { await deps.call('machine.rm', { machine: m.label }, 15000) } catch (e) { return failure(e) }
  await deps.settle()
  return { ok: true }
}

export async function coreStatus(deps: CoreAdminDeps) {
  try {
    const [s, caps] = await Promise.all([
      deps.call<{ version: string, pid: number, uptime_ms: number, live: number, finished: number, core?: { name?: string } }>('server.status', {}, 8000),
      coreCaps(deps),
    ])
    // hostPort: null when unknown (Add machine then lets the core answer).
    return { version: s.version, pid: s.pid, uptimeMs: s.uptime_ms, live: s.live, finished: s.finished, name: s.core?.name ?? null, hostPort: caps?.hostPort ?? null }
  } catch (e) { return failure(e) }
}

export async function coreConnectMachine(deps: CoreAdminDeps, key: unknown) {
  const m = deps.machines().find(x => x.key === String(key || '') && !x.local)
  if (!m) throw new HerdrError('bad_machine', 'unknown remote machine')
  try { await deps.call('machine.connect', { machine: m.label }, 60000) } catch (e) { return failure(e) }
  await deps.settle()
  return { ok: true }
}
