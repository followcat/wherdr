// Several machines, like the Herdr client's sidebar: the local
// machine (socket ~/.config/herdr/herdr.sock) and the SSH machines registered
// in Herdr (`herdr machine add`, read with `herdr machine list --json`).
//
// Herdr's multi-machine support is client-side: the local server does not aggregate
// the others. So we connect to each one ourselves:
//  - one SSH master connection per machine (ControlMaster, control socket
//    in RUNTIME_DIR), which forwards the remote Herdr server's Unix socket
//    to RUNTIME_DIR/<machine>.sock (native stdio bridges for Windows paths).
//    The line-delimited JSON client (herdr.ts) uses
//    it as is: snapshot every second, prompt, send_input, pane.read…
//  - file reads (transcripts, folders) and the terminal go
//    through sessions multiplexed over that same connection (no new
//    authentication, ~a few tens of ms per round trip).
//  - connection lost: reconnection with a bounded growing delay; a broken
//    machine never blocks the others (separate loops and sockets).
//
// Safeguards: we only read THIS machine's `herdr machine list` (never that
// of a remote machine: no recursion); a profile pointing at this machine
// itself (name, localhost, or same ~/.cache/herdr-web/machine-id identifier
// seen remotely) is ignored; two profiles to the same host and session
// count as one.
import { parseMachineDiagnostic, type MachineDiagnostic } from '../../shared/machineDiagnostics'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { MachineInfo, NamedSession } from '../../shared/types'
import { parseSessionList, sessionKey, validSession } from '../../shared/sessions'
import { LOCAL, type MachineProfile, parseMachineList, parseStatusSocket, splitId } from '../../shared/ids'
import {
  DATA_DIR, HERDR_BIN, HERDR_CHILD_ENV, HERDR_CLIENT_SOCK, HERDR_SESSION, HERDR_SOCK, HOME, HOST_LABEL, MACHINES_ENABLED, MACHINES_REFRESH_MS,
  REMOTE_SESSION, REMOTE_UPLOAD_SUBDIR, RUNTIME_DIR, SELF_HOSTS, SESSION_ARGS, SSH_BIN, UPLOAD_TTL_MS, log,
} from './env'
import { HerdrError, herdr, setSocketResolver } from './herdr'
import { type ExecResult, type MachineFs, type ShellExec, boundedOutput, createShellFs, localFs, remoteCommand, shq } from './fsx'
import { SessionGate, isRefused } from './sshgate'
import { SocketRelay, bridgeCommand, socketTransport } from './socketRelay'
import { type Transcripts, createTranscripts } from './transcripts'
import { fmt } from '../../shared/message'
import { ATTACH_SUBDIR } from '../../shared/attachments'

const fsp = fs.promises
const LOCAL_LABEL_FILE = path.join(DATA_DIR, 'machine-label.txt')
// The name the user gave this machine in the app ('' = none).
function renamedLabel() {
  try { return fs.readFileSync(LOCAL_LABEL_FILE, 'utf8').trim().slice(0, 40) }
  catch { return '' }
}
export const localMachineLabel = () => localMachine.label
let tailnetLabel = ''
// Tailnet aliases keep SSH profiles for this machine out of the remote list.
export function adoptTailnetName(name: string | null | undefined) {
  const short = (name || '').split('.')[0]!.trim().slice(0, 40)
  if (short) tailnetLabel = short
}
export function localOs() {
  const p = os.platform()
  return p === 'darwin' ? 'Darwin' : p === 'linux' ? 'Linux' : p
}

export type MachineStatus = MachineInfo['status']

export interface Machine {
  key: string // '' = local; otherwise 8 hex characters of the Herdr profile
  profileId: string | null
  label: string
  local: boolean
  target: string | null
  session: string
  status: MachineStatus
  error: string | null
  home: string
  // `uname -s` of the machine: 'Darwin' (macOS), 'Linux'… ('' until known).
  os: string
  fs: MachineFs
  transcripts: Transcripts
  exec: ShellExec | null // commandes shell (machines distantes)
  sock: () => string | null
  // Herdr client socket (notifications, see herdrNotify.ts).
  clientSock: () => string | null
  // `herdr <args>` on the machine (terminal), stdin/stdout connected.
  spawnHerdr: (args: string[]) => ChildProcessWithoutNullStreams
  // Remote machines: a shell script whose output is streamed (a video), in
  // the SSH session budget until it closes; null when offline.
  spawnShell?: (script: string, args: string[]) => ChildProcessWithoutNullStreams | null
  // Store for photos sent to this machine's agents.
  uploadDir: () => string
  info: () => MachineInfo
}

// ---------------------------------------------------------------- machine locale
export const localMachine: Machine = {
  key: LOCAL,
  profileId: null,
  label: renamedLabel() || HOST_LABEL,
  local: true,
  target: null,
  session: HERDR_SESSION || 'default',
  status: 'online',
  error: null,
  home: HOME,
  os: localOs(),
  fs: localFs,
  transcripts: createTranscripts({ home: HOME, herdr }),
  exec: null,
  sock: () => HERDR_SOCK,
  clientSock: () => HERDR_CLIENT_SOCK,
  spawnHerdr: args => spawn(HERDR_BIN, [...SESSION_ARGS, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: HERDR_CHILD_ENV }),
  uploadDir: () => path.join(HOME, '.cache/herdr-web/uploads'),
  info: () => ({ key: LOCAL, session: localMachine.session, label: localMachine.label, local: true, status: 'online', error: null, os: localMachine.os }),
}

// ---------------------------------------------------------------- identity
// Random identifier of this machine, in wherdr's folder: a remote machine
// that has the same one is this very machine (profile looping back to us).
const ID_FILE = path.join(HOME, '.cache/herdr-web/machine-id')
let selfId: string | null = null
export function localMachineId(): string {
  if (selfId) return selfId
  try { selfId = fs.readFileSync(ID_FILE, 'utf8').trim() || null }
  catch { /* not created yet */ }
  if (!selfId) {
    selfId = crypto.randomBytes(16).toString('hex')
    try {
      fs.mkdirSync(path.dirname(ID_FILE), { recursive: true })
      fs.writeFileSync(ID_FILE, selfId + '\n', { mode: 0o644 })
    } catch (e) { log(`machine-id: ${(e as Error).message}`) }
  }
  return selfId
}
export const selfNames = () => [HOST_LABEL, os.hostname(), tailnetLabel, ...SELF_HOSTS].filter(Boolean)

export class SkipMachine extends Error {}

// ---------------------------------------------------------------- SSH machines
// Probe: $HOME, herdr binary (not necessarily on the PATH of a non-interactive
// ssh), then `herdr [--session S] status server` (socket, state).
const PROBE_SCRIPT = `echo "home=$HOME"
echo "host=$(uname -n 2>/dev/null)"
echo "os=$(uname -s 2>/dev/null)"
echo "self=$(cat "$HOME/.cache/herdr-web/machine-id" 2>/dev/null)"
b=
for c in "$HOME/.local/bin/herdr" /opt/homebrew/bin/herdr /usr/local/bin/herdr; do
  if [ -x "$c" ]; then b=$c; break; fi
done
[ -n "$b" ] || b=$(command -v herdr 2>/dev/null)
if [ -z "$b" ]; then echo "error=herdr not found"; exit 0; fi
echo "bin=$b"
if [ -n "$1" ]; then "$b" --session "$1" status server 2>&1; else "$b" status server 2>&1; fi`

const UPLOAD_SCRIPT = `umask 077
d="$HOME/${REMOTE_UPLOAD_SUBDIR}"
mkdir -p "$d" && cat > "$d/$1" && echo "$d/$1"`

// Attached files (PDF, text…): mode 600 (umask), never executable.
const ATTACH_SCRIPT = `umask 077
d="$HOME/${ATTACH_SUBDIR}"
mkdir -p "$d" && cat > "$d/$1" && chmod 600 "$d/$1" && echo "$d/$1"`

const PURGE_SCRIPT = `for d in "$HOME/${REMOTE_UPLOAD_SUBDIR}" "$HOME/${ATTACH_SUBDIR}"; do
  [ -d "$d" ] && find "$d" -type f -mtime +${Math.round(UPLOAD_TTL_MS / 86400000)} -exec rm -f {} +
done; exit 0`

// Reconnection delays (bounded), then every 30 s.
const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000]
// Beyond this number of consecutive failures, the machine goes "offline".
const FAILS_BEFORE_OFFLINE = 2
// Refused sessions in a row before the master connection is reopened.
const REFUSALS_BEFORE_RECONNECT = 3
// Reopenings for refusals closer than this to the previous one wait longer.
const RECOVERY_WINDOW_MS = 10 * 60 * 1000

// Control socket of one master connection: `<key>.<pid>.<n>.ctl`, a new path
// per connection. An ssh master removes its control path when it exits, so an
// older master dying late (stopped slowly, or left behind by a previous
// wherdr) must never share the path of the one in use: every multiplexed
// session would then fail ("Connection closed by UNKNOWN port 65535") while
// the machine still looked online.
export const ctlName = (key: string, pid: number, n: number) => `${key}.${pid}.${n}.ctl`
// Control sockets of earlier connections to remove (their master, if still
// running, is asked to exit): those of wherdr processes no longer running,
// and the old fixed `<key>.ctl`. A running wherdr's own are left alone.
export function staleCtls(files: string[], key: string, alive: (pid: number) => boolean): string[] {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${esc}(?:\\.(\\d+)\\.\\d+)?\\.ctl$`)
  return files.filter((f) => {
    const m = re.exec(f)
    return Boolean(m && (!m[1] || !alive(Number(m[1]))))
  })
}
const pidAlive = (pid: number) => {
  if (pid === process.pid) return true
  try { process.kill(pid, 0); return true }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

function runFile(bin: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: 'buffer', maxBuffer: 1024 * 1024, env: HERDR_CHILD_ENV }, (err, stdout, stderr) => {
      const raw = err ? (err as { code?: unknown }).code : 0
      const code = typeof raw === 'number' ? raw : err ? 1 : 0
      resolve({ code, stdout: stdout as Buffer, stderr: String(stderr || (err && err.message) || '') })
    })
  })
}

const lastLine = (s: string) => String(s || '').trim().split('\n').filter(Boolean).pop() || ''

export class RemoteMachine implements Machine {
  readonly key: string
  baseKey?: string
  profileId: string
  label: string
  target: string
  profileSession: string
  readonly local = false
  status: MachineStatus = 'connecting'
  error: string | null = null
  home = ''
  os = ''
  bin = ''
  remoteSock = ''
  // Control socket of the current master connection (see ctlName).
  ctl: string
  private ctlSeq = 0
  readonly fwd: string
  readonly fwdClient: string
  private clientFwd = false
  private relays: SocketRelay[] = []
  fs: MachineFs
  transcripts: Transcripts
  exec: ShellExec
  private master: ChildProcess | null = null
  private masterErr: string[] = []
  private fails = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private purgeTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private connecting = false
  private pollFails = 0
  // Reopenings after refused sessions (growing delay), see sessionRefused.
  private recoveries = 0
  private lastRecovery = 0
  private checking = false
  // Identity seen at connection (host name + remote socket): duplicates.
  ident = ''
  private onChange: () => void
  onSkip: (m: RemoteMachine, reason: string) => void = () => {}
  onOnline: (m: RemoteMachine) => void = () => {}
  // Session budget of the shared connection (sshd MaxSessions).
  readonly gate = new SessionGate({
    onRefused: (s, attempt) => {
      // Logged once per streak, then when the connection is reopened.
      if (s.streak === 1) log(`machine ${this.label}: SSH session refused (attempt ${attempt}; open: ${s.execs} commands + ${s.streams} streams, ${s.queued} queued, peak ${s.peak})`)
      void this.sessionRefused()
    },
  })

  constructor(p: MachineProfile, onChange: () => void) {
    this.key = p.key
    this.profileId = p.id
    this.label = p.label
    this.target = p.target
    this.profileSession = p.session
    this.onChange = onChange
    this.ctl = path.join(RUNTIME_DIR, ctlName(p.key, process.pid, 0))
    this.fwd = path.join(RUNTIME_DIR, `${p.key}.sock`)
    this.fwdClient = path.join(RUNTIME_DIR, `${p.key}.client.sock`)
    this.exec = (script, args = [], opts = {}) => this.run(script, args, opts)
    this.fs = createShellFs(this.exec)
    this.transcripts = createTranscripts({ home: '/', herdr, fs: this.fs, exec: this.exec })
  }

  get session() { return this.baseKey ? this.profileSession : REMOTE_SESSION || this.profileSession }
  sock() { return this.status === 'online' ? this.fwd : null }
  clientSock() { return this.status === 'online' && this.clientFwd ? this.fwdClient : null }
  uploadDir() { return path.posix.join(this.home || '~', REMOTE_UPLOAD_SUBDIR) }
  info(): MachineInfo {
    return { key: this.key, baseKey: this.baseKey, session: this.session, label: this.label, local: false, status: this.status, error: this.error, target: this.target, os: this.os || undefined }
  }

  // Common options of multiplexed sessions: never a new connection
  // (ProxyCommand=false if the master is missing), never a question.
  private muxArgs() {
    return ['-S', this.ctl, '-o', 'ControlMaster=no', '-o', 'BatchMode=yes', '-o', 'ProxyCommand=/bin/false', '-T']
  }

  // Short command over the shared connection, under the session budget;
  // the same read-only command already running is shared.
  private run(script: string, args: string[], opts: { input?: Buffer, timeoutMs?: number, maxBytes?: number }): Promise<ExecResult> {
    if (this.status !== 'online' && !this.connecting) {
      return Promise.resolve({ code: 255, stdout: Buffer.alloc(0), stderr: fmt('{machine} is unreachable', { machine: this.label }) })
    }
    const cmd = remoteCommand(script, args)
    const key = opts.input ? undefined : `${opts.timeoutMs || 0}\n${opts.maxBytes || 0}\n${cmd}`
    return this.gate.run(() => this.runOnce(cmd, opts), r => r.code === 255 && isRefused(r.stderr), key)
  }

  private runOnce(cmd: string, opts: { input?: Buffer, timeoutMs?: number, maxBytes?: number }): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn(SSH_BIN, [...this.muxArgs(), '--', this.target, cmd], { stdio: ['pipe', 'pipe', 'pipe'] })
      const out = boundedOutput(opts.maxBytes)
      let err = ''
      let done = false
      const finish = (code: number | null) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ code, stdout: out.take(), stderr: err })
      }
      const timer = setTimeout(() => {
        err += '\n'
        err += 'timed out'
        child.kill('SIGKILL')
        finish(124)
      }, opts.timeoutMs || 15000)
      child.stdout.on('data', (b: Buffer) => {
        if (out.push(b)) return
        // Too long: stopped at once, nothing of it kept.
        err += `\noutput longer than ${opts.maxBytes} bytes`
        child.kill('SIGKILL')
        finish(125)
      })
      child.stderr.on('data', (b: Buffer) => { if (err.length < 4000) err += b.toString('utf8') })
      child.on('error', (e) => { err += e.message; finish(127) })
      child.on('close', code => finish(code))
      child.stdin.on('error', () => {})
      child.stdin.end(opts.input || undefined)
    })
  }

  // Long-lived session (terminal): counted in the budget, never queued.
  spawnHerdr(args: string[]): ChildProcessWithoutNullStreams {
    const sess = this.session && this.session !== 'default' ? ['--session', this.session] : []
    const cmd = `exec ${[this.bin || 'herdr', ...sess, ...args].map(shq).join(' ')}`
    return this.stream(cmd)
  }

  spawnShell(script: string, args: string[]): ChildProcessWithoutNullStreams | null {
    if (this.status !== 'online') return null
    return this.stream(remoteCommand(script, args))
  }

  // Long-lived session in the budget; a refused one counts in the streak
  // (a terminal retrying alone must also bring the connection back), an
  // accepted one ends it.
  private stream(cmd: string, counted = true): ChildProcessWithoutNullStreams {
    const child = spawn(SSH_BIN, [...this.muxArgs(), '--', this.target, cmd], { stdio: ['pipe', 'pipe', 'pipe'] })
    const close = counted ? this.gate.openStream() : () => {}
    let err = ''
    let opened = false
    child.stdout.once('data', () => {
      opened = true
      this.gate.accepted()
    })
    child.stderr.on('data', (b: Buffer) => { if (err.length < 4000) err += b.toString('utf8') })
    child.on('close', (code) => {
      close()
      if (opened) return
      // A session that ran (any end but ssh's own 255) was accepted too.
      if (code === 255 && isRefused(err)) this.gate.refused()
      else if (code !== null && code !== 255) this.gate.accepted()
    })
    child.on('error', close)
    return child
  }

  // A session was refused. The master may be gone or its control socket
  // removed (`-O check` fails): reopen at once. Otherwise reopen after
  // REFUSALS_BEFORE_RECONNECT refusals in a row (sshd refusing every session
  // on that connection), never in a burst: the delay grows with each
  // reopening close to the previous one.
  private async sessionRefused() {
    if (this.stopped || this.status !== 'online' || this.connecting || this.checking) return
    this.checking = true
    const ctl = this.ctl
    let reason: string | null = null
    try {
      const check = await runFile(SSH_BIN, ['-S', ctl, '-O', 'check', '--', this.target], 5000)
      if (check.code !== 0) {
        log(`machine ${this.label}: control socket check failed (${lastLine(check.stderr) || check.code})`)
        reason = 'SSH control connection lost'
      }
      else if (this.gate.stats().streak >= REFUSALS_BEFORE_RECONNECT) reason = 'SSH sessions refused'
    } finally { this.checking = false }
    if (!reason || this.stopped || this.status !== 'online' || this.connecting || this.ctl !== ctl) return
    const now = Date.now()
    if (now - this.lastRecovery > RECOVERY_WINDOW_MS) this.recoveries = 0
    this.lastRecovery = now
    this.recoveries++
    this.gate.accepted()
    // fail() counts one more: the first reopening waits BACKOFF_MS[0], the next ones longer.
    this.fails = this.recoveries - 1
    this.restart(reason)
  }

  async putUpload(name: string, data: Buffer, kind: 'photo' | 'file' = 'photo'): Promise<string> {
    const r = await this.exec(kind === 'file' ? ATTACH_SCRIPT : UPLOAD_SCRIPT, [name], { input: data, timeoutMs: 120000 })
    const p = r.stdout.toString('utf8').trim()
    if (r.code !== 0 || !p) throw new Error(fmt('Copy to {machine} failed: {reason}', { machine: this.label, reason: lastLine(r.stderr) || r.code }))
    return p
  }

  private set(status: MachineStatus, error: string | null) {
    if (this.status === status && this.error === error) return
    this.status = status
    this.error = error
    log(`machine ${this.label} (${this.target}): ${status}${error ? ` — ${error}` : ''}`)
    this.onChange()
  }

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.purgeTimer) clearInterval(this.purgeTimer)
    this.timer = null
    this.purgeTimer = null
    this.killMaster()
  }

  retry() {
    this.fails = 0
    this.restart('manual retry')
  }

  // Restarts the connection (target or session changed, silent remote server…).
  restart(reason: string) {
    if (this.stopped) return
    log(`machine ${this.label}: reconnecting (${reason})`)
    this.killMaster()
    this.fail(reason)
  }

  private killMaster() {
    const m = this.master
    this.master = null
    // Stop by exact PID: the ssh master process we started.
    if (m && m.exitCode === null) m.kill('SIGTERM')
    this.clientFwd = false
    for (const relay of this.relays) relay.stop()
    this.relays = []
    fsp.unlink(this.fwd).catch(() => {})
    fsp.unlink(this.fwdClient).catch(() => {})
  }

  private fail(error: string) {
    if (this.stopped) return
    this.fails++
    this.set(this.fails > FAILS_BEFORE_OFFLINE ? 'offline' : 'connecting', error)
    const delay = BACKOFF_MS[Math.min(this.fails - 1, BACKOFF_MS.length - 1)]!
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.connect(), delay)
  }

  // State polling (state.ts): the remote server may stop while
  // the SSH connection holds. Three consecutive failures: start over.
  reportPoll(ok: boolean, error?: string) {
    if (ok) { this.pollFails = 0; return }
    if (this.status !== 'online') return
    if (++this.pollFails >= 3) {
      this.pollFails = 0
      this.restart(error || 'Herdr server not responding')
    }
  }

  private async waitControl(child: ChildProcess, timeoutMs: number) {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      if (child.exitCode !== null || this.master !== child) return false
      const r = await runFile(SSH_BIN, ['-S', this.ctl, '-O', 'check', '--', this.target], 5000)
      if (r.code === 0) return true
      await new Promise(res => setTimeout(res, 250))
    }
    return false
  }

  private async connect() {
    if (this.stopped || this.connecting) return
    this.connecting = true
    this.timer = null
    try {
      await fsp.mkdir(RUNTIME_DIR, { recursive: true, mode: 0o700 })
      await this.reapStaleMasters()
      this.ctl = path.join(RUNTIME_DIR, ctlName(this.key, process.pid, ++this.ctlSeq))
      await fsp.unlink(this.ctl).catch(() => {})
      await fsp.unlink(this.fwd).catch(() => {})
      await fsp.unlink(this.fwdClient).catch(() => {})
      if (this.status !== 'offline') this.set('connecting', this.error)
      this.masterErr = []
      const child = spawn(SSH_BIN, [
        '-M', '-S', this.ctl, '-N', '-T',
        '-o', 'ControlPersist=no', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindUnlink=yes',
        '--', this.target,
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      this.master = child
      child.stderr!.setEncoding('utf8')
      child.stderr!.on('data', (s: string) => {
        for (const l of s.split('\n').map(x => x.trim()).filter(Boolean)) {
          this.masterErr.push(l)
          if (this.masterErr.length > 6) this.masterErr.shift()
        }
      })
      child.on('error', e => this.masterErr.push(e.message))
      child.on('exit', (code) => {
        if (this.master !== child) return
        this.master = null
        const why = this.masterErr.filter(l => !/^Warning: Permanently added/.test(l)).pop() || fmt('SSH connection closed (code {code})', { code })
        if (!this.connecting) { this.killMaster(); this.fail(why) }
      })

      if (!(await this.waitControl(child, 20000))) {
        throw new Error(this.masterErr.filter(l => !/^Warning:/.test(l)).pop() || 'SSH connection failed (timed out)')
      }
      // Probe (over the multiplexed connection).
      const probe = await this.exec(PROBE_SCRIPT, [this.session === 'default' ? '' : this.session], { timeoutMs: 15000 })
      const out = probe.stdout.toString('utf8')
      const kv = (k: string) => (new RegExp(`^${k}=(.*)$`, 'm').exec(out) || [])[1] || ''
      if (!kv('home') && probe.code !== 255) {
        throw new Error('Remote SSH shell must support POSIX commands. On Windows, set OpenSSH DefaultShell to Git Bash (docs/machines.md, “Windows remote machines”).')
      }
      if (probe.code !== 0) throw new Error(lastLine(probe.stderr) || fmt('Probe failed (code {code})', { code: probe.code }))
      if (kv('self') && kv('self') === localMachineId()) throw new SkipMachine('this machine itself')
      if (kv('error')) throw new Error(fmt('{reason} on {machine}', { reason: kv('error'), machine: this.label }))
      this.home = kv('home')
      this.os = kv('os')
      this.bin = kv('bin')
      const running = /^\s*status:\s*running\s*$/m.test(out)
      const sock = parseStatusSocket(out)
      if (!running || !sock) {
        throw new Error(this.session !== 'default' ? fmt('Herdr server stopped on {machine} (session {session})', { machine: this.label, session: this.session }) : fmt('Herdr server stopped on {machine}', { machine: this.label }))
      }
      this.remoteSock = sock
      this.ident = `${kv('host').toLowerCase()}|${sock}`
      this.transcripts = createTranscripts({ home: this.home, herdr, fs: this.fs, exec: this.exec })
      if (socketTransport(sock) === 'relay') {
        const check = await this.runOnce(bridgeCommand(this.bin, this.session, false, true), { timeoutMs: 10000 })
        if (check.code !== 0 || check.stdout.toString('utf8').trim() !== 'herdr-api-bridge-v1') {
          throw new Error('Remote Herdr must provide remote-api-bridge (Herdr 0.9.3 or later).')
        }
        if (this.stopped || this.master !== child) throw new Error('SSH connection closed')
        // API channels use the command budget, including time spent streaming.
        // A consumed byte stream cannot be retried, so refusals are counted by stream().
        const api = new SocketRelay(() => this.stream(bridgeCommand(this.bin, this.session), false),
          run => this.gate.withSlot(run))
        this.relays.push(api)
        await api.listen(this.fwd)
        const client = new SocketRelay(() => this.stream(bridgeCommand(this.bin, this.session, true)))
        this.relays.push(client)
        try {
          await client.listen(this.fwdClient)
          this.clientFwd = true
        } catch (e) {
          client.stop()
          log(`machine ${this.label}: herdr notifications unavailable (${(e as Error).message})`)
        }
      } else {
        // POSIX machines retain OpenSSH's native Unix socket forwarding.
        const fwd = await runFile(SSH_BIN, ['-S', this.ctl, '-O', 'forward', '-L', `${this.fwd}:${sock}`, '--', this.target], 10000)
        if (fwd.code !== 0) throw new Error(fmt('Herdr socket forwarding failed: {reason}', { reason: lastLine(fwd.stderr) || fwd.code }))
        const clientSock = path.posix.join(path.posix.dirname(sock), 'herdr-client.sock')
        const fwdc = await runFile(SSH_BIN, ['-S', this.ctl, '-O', 'forward', '-L', `${this.fwdClient}:${clientSock}`, '--', this.target], 10000)
        this.clientFwd = fwdc.code === 0
        if (!this.clientFwd) log(`machine ${this.label}: herdr notifications unavailable (${lastLine(fwdc.stderr) || fwdc.code})`)
      }
      if (this.stopped || this.master !== child || child.exitCode !== null) throw new Error('SSH connection closed')
      this.fails = 0
      this.pollFails = 0
      this.connecting = false
      this.set('online', null)
      this.onOnline(this)
      if (this.stopped) return
      this.purgeUploads()
      if (!this.purgeTimer) this.purgeTimer = setInterval(() => this.purgeUploads(), 6 * 3600 * 1000)
    } catch (e) {
      this.connecting = false
      this.killMaster()
      if (e instanceof SkipMachine) {
        this.stop()
        this.onSkip(this, e.message)
        return
      }
      this.fail((e as Error).message)
    } finally {
      this.connecting = false
    }
  }

  // Masters left by a previous wherdr (crash, kill): asked to exit through
  // their own control socket, then the socket file is removed.
  private async reapStaleMasters() {
    const files = await fsp.readdir(RUNTIME_DIR).catch(() => [] as string[])
    for (const f of staleCtls(files, this.key, pidAlive)) {
      const p = path.join(RUNTIME_DIR, f)
      const r = await runFile(SSH_BIN, ['-S', p, '-O', 'exit', '--', this.target], 5000)
      if (r.code === 0) log(`machine ${this.label}: stopped a leftover SSH connection (${f})`)
      await fsp.unlink(p).catch(() => {})
    }
  }

  private purgeUploads() {
    this.exec(PURGE_SCRIPT, [], { timeoutMs: 20000 }).catch(() => {})
  }
}

// ---------------------------------------------------------------- registre
const remotes = new Map<string, RemoteMachine>()
const sessions = new Map<string, Machine>()
// Profiles dropped after connection (this machine, or duplicate): key -> target|session.
const skipped = new Map<string, string>()
const sig = (p: { target: string, profileSession?: string, session?: string }) => `${p.target}|${p.profileSession ?? p.session}`
function skip(m: RemoteMachine, reason: string) {
  m.stop()
  for (const [key, other] of sessions) if (other instanceof RemoteMachine && other.baseKey === m.key) {
    other.stop()
    sessions.delete(key)
  }
  skipped.set(m.key, sig(m))
  if (remotes.get(m.key) === m) remotes.delete(m.key)
  log(`machine ${m.label} (${m.target}) ignored: ${reason}`)
  changed()
}
// Same host and same socket as an already connected machine (other name, IP…): duplicate.
function checkDuplicate(m: RemoteMachine) {
  for (const o of remotes.values()) {
    if (o === m || !o.ident || o.ident !== m.ident) continue
    return skip(m, `same machine as ${o.label}`)
  }
}
const listeners = new Set<() => void>()
const changed = () => { for (const f of listeners) f() }
export function onMachinesChange(fn: () => void) { listeners.add(fn) }

export const allMachines = (): Machine[] => [localMachine, ...remotes.values(), ...sessions.values()]
export const baseMachines = (): Machine[] => [localMachine, ...remotes.values()]
export const remoteMachines = () => [...remotes.values()]
export const getMachine = (key: string | null | undefined): Machine | undefined =>
  (!key ? localMachine : remotes.get(key) || sessions.get(key))
export const machineOfPane = (id: string | null | undefined) => getMachine(splitId(String(id || '')).machine)
export const multiMachine = () => remotes.size > 0 || sessions.size > 0

// Session-free Herdr command on the machine (`herdr integration status`…):
// its integrations live in its home, shared by all its sessions.
export async function runHerdrCli(m: Machine, args: string[], timeoutMs = 10000): Promise<ExecResult> {
  if (m.local) return runFile(HERDR_BIN, args, timeoutMs)
  const remote = m as RemoteMachine
  if (remote.status !== 'online' || !remote.bin) throw new HerdrError('unreachable', fmt('{machine} is unreachable', { machine: m.label }))
  return remote.exec('b="$1"; shift; "$b" "$@"', [remote.bin, ...args], { timeoutMs })
}

export async function listSessions(baseKey: string): Promise<NamedSession[]> {
  const m = baseMachines().find(x => x.key === baseKey)
  if (!m) throw new HerdrError('bad_machine', 'unknown machine')
  let r: ExecResult
  if (m.local) r = await runFile(HERDR_BIN, ['session', 'list', '--json'], 10000)
  else {
    const remote = m as RemoteMachine
    if (remote.status !== 'online') throw new HerdrError('unreachable', fmt('{machine} is unreachable', { machine: m.label }))
    r = await remote.exec('"$1" session list --json', [remote.bin], { timeoutMs: 10000 })
  }
  if (r.code !== 0) throw new HerdrError('session_list', lastLine(r.stderr) || 'Session list unavailable')
  return parseSessionList(r.stdout.toString('utf8'), baseKey, m.session)
}

export async function openSession(baseKey: string, name: string): Promise<NamedSession> {
  if (!validSession(name)) throw new HerdrError('bad_session', 'Invalid session')
  const found = (await listSessions(baseKey)).find(s => s.name === name)
  if (!found || !found.running) throw new HerdrError('session_stopped', 'Session missing or stopped')
  if (found.key === baseKey) return found
  if (sessions.has(found.key)) return found
  const base = baseMachines().find(m => m.key === baseKey)!
  if (base.local) {
    const sockDir = path.join(HOME, '.config/herdr/sessions', name)
    const machine: Machine = {
      ...localMachine, key: found.key, local: true, session: name,
      sock: () => path.join(sockDir, 'herdr.sock'),
      clientSock: () => path.join(sockDir, 'herdr-client.sock'),
      spawnHerdr: args => spawn(HERDR_BIN, ['--session', name, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: HERDR_CHILD_ENV }),
      transcripts: createTranscripts({ home: HOME, herdr }),
      info: () => ({ key: found.key, baseKey, session: name, label: localMachine.label, local: true, status: 'online', error: null, os: localMachine.os }),
    }
    sessions.set(found.key, machine)
  } else {
    const remote = base as RemoteMachine
    const profile: MachineProfile = { key: found.key, id: remote.profileId, label: remote.label, target: remote.target, session: name }
    const machine = new RemoteMachine(profile, changed)
    machine.baseKey = baseKey
    machine.onSkip = () => { machine.stop(); sessions.delete(found.key); changed() }
    sessions.set(found.key, machine)
    machine.start()
  }
  changed()
  return found
}

setSocketResolver((key) => {
  const m = getMachine(key)
  if (!m) return { sock: null, error: fmt('Unknown machine: {machine}', { machine: key }) }
  const sock = m.sock()
  return sock ? { sock } : { sock: null, error: m.error ? fmt('{machine} is unreachable: {reason}', { machine: m.label, reason: m.error }) : fmt('{machine} is unreachable', { machine: m.label }) }
})

// Re-reads Herdr's profiles: adds, removes, renames without restarting.
// First read of the profiles done (successful or not): the state can say it is ready.
let listed = false
export const machinesListed = () => listed || !MACHINES_ENABLED
export async function refreshMachines() {
  if (!MACHINES_ENABLED) return
  try { await readMachines() }
  finally {
    if (!listed) { listed = true; changed() }
  }
}
async function readMachines() {
  const r = await runFile(HERDR_BIN, ['machine', 'list', '--json'], 10000)
  if (r.code !== 0) {
    log(`herdr machine list: ${lastLine(r.stderr) || r.code}`)
    return
  }
  // This machine's profiles only; those pointing at itself are dropped.
  const profiles = parseMachineList(r.stdout.toString('utf8'), selfNames())
    .filter(p => skipped.get(p.key) !== sig(p))
  let dirty = false
  const keep = new Set(profiles.map(p => p.key))
  for (const [k, m] of remotes) {
    if (keep.has(k)) continue
    m.stop()
    remotes.delete(k)
    for (const [sk, sm] of sessions) if (sm instanceof RemoteMachine && sm.baseKey === k) { sm.stop(); sessions.delete(sk) }
    log(`machine ${m.label} removed`)
    dirty = true
  }
  for (const p of profiles) {
    const m = remotes.get(p.key)
    if (!m) {
      const nm = new RemoteMachine(p, changed)
      nm.onSkip = skip
      nm.onOnline = checkDuplicate
      remotes.set(p.key, nm)
      log(`machine ${p.label} (${p.target}, session ${REMOTE_SESSION || p.session}) added`)
      nm.start()
      dirty = true
      continue
    }
    if (m.label !== p.label) {
      m.label = p.label
      for (const other of sessions.values()) if (other instanceof RemoteMachine && other.baseKey === m.key) other.label = p.label
      dirty = true
    }
    if (m.target !== p.target || m.profileSession !== p.session) {
      m.target = p.target
      m.profileSession = p.session
      m.restart('profile changed')
      for (const sm of sessions.values()) if (sm instanceof RemoteMachine && sm.baseKey === m.key) {
        sm.target = p.target
        sm.restart('profile changed')
      }
      dirty = true
    }
  }
  // Ordre du profil Herdr.
  const order = profiles.map(p => p.key)
  const sorted = [...remotes.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
  remotes.clear()
  for (const [k, m] of sorted) remotes.set(k, m)
  if (dirty) changed()
}

// These commands address this host's saved profile, even for a named session.
export async function machineDiagnostic(key: string): Promise<MachineDiagnostic> {
  const machine = getMachine(key)
  const base = machine && remotes.get((machine as RemoteMachine).baseKey ?? machine.key)
  if (!base) throw new HerdrError('bad_machine', 'unknown remote machine')
  const result = await runFile(HERDR_BIN, ['machine', 'status', base.profileId, '--json'], 30000)
  const diagnostic = parseMachineDiagnostic(result.stdout.toString('utf8'), base.profileId)
  if (diagnostic) return diagnostic
  // Old CLI: only a rejected subcommand means unsupported. Operational failures
  // must stay visible rather than being mistaken for an older Herdr version.
  if (/unrecognized subcommand|unknown (?:command|subcommand)|Usage:[\s\S]*machine/i.test(result.stderr)) {
    return { supported: false, status: null, error: null, reconnect: null }
  }
  throw new HerdrError('machine_status', lastLine(result.stderr) || 'Machine status unavailable')
}

export function retryMachine(key: string) {
  const machine = getMachine(key)
  if (!(machine instanceof RemoteMachine)) throw new HerdrError('bad_machine', 'unknown remote machine')
  machine.retry()
}

export async function renameMachine(key: string, label: string) {
  if (!label) throw new HerdrError('bad_label', 'Empty machine name')
  if (key === LOCAL) {
    await fsp.mkdir(DATA_DIR, { recursive: true })
    await fsp.writeFile(LOCAL_LABEL_FILE, `${label}\n`, 'utf8')
    localMachine.label = label
    for (const other of sessions.values()) if (!(other instanceof RemoteMachine)) other.label = label
    changed()
    return
  }
  const m = remotes.get(key)
  if (!m) throw new HerdrError('bad_machine', 'unknown machine')
  const r = await runFile(HERDR_BIN, ['machine', 'rename', m.profileId, '--label', label], 10000)
  if (r.code !== 0) throw new HerdrError('machine_rename', lastLine(r.stderr) || 'Rename failed')
  m.label = label
  for (const other of sessions.values()) if (other instanceof RemoteMachine && other.baseKey === key) other.label = label
  changed()
  await refreshMachines()
}

let refreshTimer: ReturnType<typeof setInterval> | null = null
export function startMachines() {
  if (!MACHINES_ENABLED) return
  localMachineId()
  refreshMachines().catch(e => log('machines:', e.message))
  refreshTimer = setInterval(() => refreshMachines().catch(e => log('machines:', e.message)), MACHINES_REFRESH_MS)
}
export function stopMachines() {
  if (refreshTimer) clearInterval(refreshTimer)
  for (const m of remotes.values()) m.stop()
  for (const m of sessions.values()) if (m instanceof RemoteMachine) m.stop()
}
process.on('exit', () => { for (const m of [...remotes.values(), ...sessions.values()]) if (m instanceof RemoteMachine) m.stop() })
