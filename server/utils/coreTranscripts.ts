// Conversation files of herdr-core agents. v2's transcript reader (transcripts.ts) finds a
// Claude Code or Codex conversation from the agent's process, folder and start time; here
// core supplies those (terminal.get) and, for a remote core machine, the machine's disk
// (machine.exec through createShellFs), so the same reader, parsers, search and queue apply.
import { createShellFs, localFs, type ExecResult, type MachineFs, type ShellExec } from './fsx'
import { createTranscripts, type Loc, type TranscriptPane, type Transcripts } from './transcripts'
import { CoreError } from './core'
import type { ChatResponse, Pane } from '../../shared/types'
import { DEVIN_PROCESS_SCRIPT, devinProcesses } from './devinProcesses'
import { createCmdCore } from './commandCodeCore'
import { createOpencodeCore } from './opencodeCore'
import { ocFile } from './opencodeTranscripts'
import type { CodexHistory } from './codexDaemon'

type Call = <T>(method: string, params: object, timeout: number) => Promise<T>
export interface CoreTranscriptDeps {
  call: Call
  pane: (id: string) => Pane | undefined
  localHome: string
  now?: () => number // injected clock for the Command Code evidence TTL (tests)
  // This machine's shared Codex app-server (codexDaemon.ts): paginated history read first.
  codexHistory?: CodexHistory
}

interface CoreProcess { pid?: number, name?: string, argv?: string[], cwd?: string, startedAt?: number, argvExact?: boolean, childPids?: number[] }
interface CoreDetail { state?: string, pid?: number, argv?: string[], created_ms?: number, foreground?: CoreProcess | null }

// The machine part of a core address (`mac/t7` -> `mac`; local ones have none).
export const machineOfAddress = (address: string | undefined) => (address && address.includes('/') ? address.split('/')[0]! : '')

// Same shape as Herdr's `pane.process_info`, from core's `terminal.get`: the foreground
// program first, then the terminal's own process (an agent started by a shell is the former).
export function processInfo(d: CoreDetail) {
  const procs: CoreProcess[] = []
  if (d.foreground && typeof d.foreground.pid === 'number') procs.push({ pid: d.foreground.pid, name: d.foreground.name, argv: d.foreground.argv, argvExact: true })
  if (typeof d.pid === 'number' && d.pid !== d.foreground?.pid) procs.push({ pid: d.pid, name: d.argv?.[0], argv: d.argv, argvExact: true })
  return { process_info: { foreground_processes: procs } }
}

// Cline runs as `node …/bin/cline` (its argv[1]) with the engine `.cline` under
// it: both names count as its programs.
const AGENT_PROGRAMS = new Set(['claude', 'codex', 'omp', 'devin', 'agy', 'antigravity', 'antigravity-cli', 'cline', '.cline', 'hermes'])
const baseName = (s: string | undefined) => (s || '').split('/').pop() || ''
// Programs under the terminal's process, from `ps -e -o pid=,ppid=,args=`: an agent started by a
// shell, or hosted by a helper, is not the foreground process of the terminal.
const psRows = (ps: string) => ps.split('\n').map(l => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
  .map(m => ({ pid: Number(m![1]), ppid: Number(m![2]), argv: m![3]!.split(/\s+/) }))
const agentRow = (r: { pid: number, argv: string[] }): CoreProcess | null => {
  const name = [baseName(r.argv[0]), baseName(r.argv[1])].find(n => AGENT_PROGRAMS.has(n)) || ''
  return name ? { pid: r.pid, name, argv: r.argv, argvExact: false } : null
}

export function agentDescendants(ps: string, root: number): CoreProcess[] {
  const rows = psRows(ps)
  const seen = new Set([root])
  const out: CoreProcess[] = []
  for (let grew = true; grew;) {
    grew = false
    for (const r of rows) {
      if (seen.has(r.pid) || !seen.has(r.ppid)) continue
      seen.add(r.pid)
      grew = true
      const agent = agentRow(r)
      if (agent) out.push(agent)
    }
  }
  return out
}

// Agent processes whose parent is `root` itself, one level only.
export const agentChildren = (ps: string, root: number): CoreProcess[] =>
  psRows(ps).filter(r => r.ppid === root && r.pid !== root).map(agentRow).filter((p): p is CoreProcess => p !== null)

// "herdr-core: <kind>" for a failed core call (the last stderr line becomes the FsError reason).
export const coreFailure = (e: unknown) => `herdr-core: ${e instanceof CoreError && /^[a-z_]{1,40}$/.test(e.kind) ? e.kind : 'unreachable'}`
// The core's error kind of a failed remote read, from its reason, else null.
export const coreFailureKind = (e: unknown) => /^herdr-core: ([a-z_]+)$/.exec(String((e as { message?: unknown } | null)?.message ?? ''))?.[1] ?? null

// `local` is only the deliberate machineless local core: its `on` is omitted.
// Otherwise even an empty name is sent, so a missing remote machine fails there
// instead of silently running on this core.
export function coreShell(call: Call, on: string, local = false): ShellExec {
  return async (script, args = [], opts = {}): Promise<ExecResult> => {
    const seconds = Math.max(1, Math.ceil((opts.timeoutMs ?? 15000) / 1000))
    try {
      const r = await call<{ code: number | null, stdout?: string, stderr?: string, timed_out?: boolean, truncated?: boolean }>('machine.exec', {
        argv: ['sh', '-c', script, 'sh', ...args], ...(local && !on ? {} : { on }), timeout: seconds,
        ...(opts.input ? { input: opts.input.toString('base64') } : {}),
      }, seconds * 1000 + 5000)
      // A timed-out reply is a failure: its partial stdout is discarded,
      // never decoded into a buffer.
      if (r.timed_out) return { code: 124, stdout: Buffer.alloc(0), stderr: 'timed out' }
      // base64 emits exactly 4*ceil(n/3) chars for n bytes: more than that for
      // the bound means over-budget or cut output — reject before decoding.
      const enc = r.stdout || ''
      if (r.truncated || (opts.maxBytes && enc.length > Math.ceil(opts.maxBytes / 3) * 4)) {
        return { code: 125, stdout: Buffer.alloc(0), stderr: 'output too large' }
      }
      const stdout = Buffer.from(enc, 'base64')
      if (opts.maxBytes && stdout.length > opts.maxBytes) return { code: 125, stdout: Buffer.alloc(0), stderr: 'output too large' }
      return { code: r.code, stdout, stderr: Buffer.from(r.stderr || '', 'base64').toString('utf8') }
    } catch (e) {
      // An unreachable machine reads as the SSH failure code (the file's state is unknown).
      // Core's error kind ("unavailable", "timeout"…) is kept: its message alone is generic.
      return { code: 255, stdout: Buffer.alloc(0), stderr: coreFailure(e) }
    }
  }
}

// $HOME over the wire: `printf %s` writes no newline. Only a successful
// bounded reply is an absolute home — a timeout, nonzero code or truncated
// answer cannot give a partial trusted path, and the bytes are never
// trimmed: a path's own trailing whitespace is part of it, not a route
// into another directory.
export async function machineHome(shell: ShellExec): Promise<string> {
  const r = await shell('printf %s "$HOME"', [], { maxBytes: 4096 })
  const s = r.code === 0 && r.stdout.length <= 4096 ? r.stdout.toString('utf8') : ''
  // Roundtrip: bytes that are not valid UTF-8 would silently decode into
  // another directory, so they are refused like any other failed lookup.
  if (!s.startsWith('/') || /[\r\n\0]/.test(s) || !Buffer.from(s, 'utf8').equals(r.stdout)) {
    throw new CoreError('unreachable', 'machine home unknown')
  }
  return s
}

const PS_TTL_MS = 10_000

export function createCoreTranscripts(deps: CoreTranscriptDeps) {
  const clock = () => (deps.now ? deps.now() : Date.now())
  const details = new Map<string, { at: number, d: CoreDetail }>()
  const psCache = new Map<string, { at: number, busy: boolean, p: Promise<string> }>()
  const cachedPs = (machine: string): Promise<string> => {
    const hit = psCache.get(machine)
    if (hit && (hit.busy || (clock() - hit.at >= 0 && clock() - hit.at < PS_TTL_MS))) return hit.p
    const rec = {
      at: 0,
      busy: true,
      p: deps.call<{ stdout?: string }>('machine.exec', {
        argv: ['ps', '-e', '-o', 'pid=,ppid=,args='], ...(machine ? { on: machine } : {}), timeout: 5,
      }, 8000)
        .catch(() => null)
        .then(ps => Buffer.from(ps?.stdout || '', 'base64').toString('utf8'))
        .finally(() => { rec.busy = false; rec.at = clock() }),
    }
    psCache.set(machine, rec)
    return rec.p
  }
  async function detail(address: string): Promise<CoreDetail> {
    const hit = details.get(address)
    if (hit && clock() - hit.at < 1500) return hit.d
    const d = await deps.call<CoreDetail>('terminal.get', { terminal: address }, 4000)
    details.set(address, { at: clock(), d })
    if (details.size > 200) details.delete(details.keys().next().value!)
    return d
  }
  const herdr = async (method: string, params: Record<string, unknown> = {}) => {
    const address = deps.pane(String(params.pane_id || ''))?.coreAddress
    if (method === 'pane.screen' && address) return { text: String((await deps.call<{ text?: string }>('terminal.read', { terminal: address, lines: 0 }, 4000)).text || '') }
    if (method !== 'pane.process_info' || !address) throw new CoreError('unsupported', 'unsupported')
    const d = await detail(address)
    const info = processInfo(d)
    const procs = info.process_info.foreground_processes
    const psTable = () => cachedPs(machineOfAddress(address))
    if (!procs.some(p => AGENT_PROGRAMS.has(baseName(p.argv?.[0] || p.name))) && typeof d.pid === 'number') {
      procs.unshift(...agentDescendants(await psTable(), d.pid))
    }
    const names = (p: CoreProcess) => [baseName(p.name), ...(p.argv?.slice(0, 2).map(baseName) || [])]
    const isDevin = (p: CoreProcess) => names(p).includes('devin')
    const devin = procs.filter(p => isDevin(p) && Number.isSafeInteger(p.pid) && p.pid! > 0)
    // Devin 3000.12 runs a launcher (the foreground) and its engine `devin acp`
    // as a direct child; the session lock names the engine, so a launcher
    // carries the PIDs of its direct Devin children. A Devin started further
    // down (from the engine's shell) holds its own lock and must not count.
    for (const p of devin) {
      const kids = agentChildren(await psTable(), p.pid!).filter(isDevin).map(k => k.pid!)
      if (kids.length) p.childPids = kids
    }
    const snapshotNames = new Set(['devin', 'agy', 'antigravity', 'antigravity-cli', 'cline', '.cline'])
    const snapshotted = procs.filter(p => names(p).some(n => snapshotNames.has(n)) && Number.isSafeInteger(p.pid) && p.pid! > 0)
    if (snapshotted.length) {
      // Exact argv and a conservative birth bound for Devin and Antigravity
      // processes, read together on the agent's machine.
      const on = machineOfAddress(address)
      const r = await deps.call<{ stdout?: string }>('machine.exec', {
        argv: ['sh', '-c', DEVIN_PROCESS_SCRIPT, 'sh', ...snapshotted.map(p => String(p.pid))],
        ...(on ? { on } : {}), timeout: 5,
      }, 8000).catch(() => null)
      const snapshot = devinProcesses(Buffer.from(r?.stdout || '', 'base64').toString('utf8'))
      for (const p of snapshotted) Object.assign(p, snapshot.get(p.pid!))
    }
    return info
  }

  const machines = new Map<string, Promise<Transcripts>>()
  // Warm instances by machine name: the synchronous final predicate
  // (live below) reaches the reader that produced a reply without a new
  // dispatch. A superseded entry is still the owning reader for replies
  // it bound; a new instance overwrites it when its promise resolves.
  const resolved = new Map<string, Transcripts>()
  function forMachine(name: string): Promise<Transcripts> {
    let t = machines.get(name)
    if (!t) {
      t = (async () => {
        // Census/discovery/header work goes through machine.exec on the core
        // itself — locally too (an omitted `on` runs on this machine); only
        // transcript file reads use localFs directly.
        const shell = coreShell(deps.call, name, !name)
        const home = name ? await machineHome(shell) : deps.localHome
        if (!home.startsWith('/') || home.includes('\0')) throw new CoreError('unreachable', 'machine home unknown')
        // Transcript reads ride core's reply ceiling in 4 MiB decoded chunks.
        const fs: MachineFs = name ? createShellFs(shell) : localFs
        // Command Code: the census-backed locator decides what this pane's
        // terminal really shows. Only THIS machine's terminal.get detail of
        // the pane's exact coreAddress feeds it — state is passed unchanged
        // (only an exact 'live' resolves), never defaulted.
        const cmd = createCmdCore(shell, home, deps.now ? { now: deps.now } : {})
        const locateCommandCode = async (p: TranscriptPane): Promise<Loc | null> => {
          const address = deps.pane(p.id)?.coreAddress
          if (!address || machineOfAddress(address) !== name) return null
          const d = await detail(address).catch(() => null)
          if (!d) return null
          const r = await cmd.locate({ state: d.state, pid: d.pid, argv: d.argv, foreground: d.foreground ? { pid: d.foreground.pid } : null })
          return 'file' in r ? { file: r.file, session: r.session, guessed: true } : null
        }
        // OpenCode: the scan/catalog-backed locator decides which session
        // this pane's foreground opencode process really has — the same
        // fail-closed contract: no session, no peers proof, no guess.
        const oc = createOpencodeCore(shell, home)
        const locateOpencode = async (p: TranscriptPane): Promise<Loc | null> => {
          const address = deps.pane(p.id)?.coreAddress
          if (!address || machineOfAddress(address) !== name) return null
          const d = await detail(address).catch(() => null)
          if (!d) return null
          const r = await oc.locate({
            state: d.state, pid: d.pid, argv: d.argv, created_ms: d.created_ms,
            foreground: d.foreground ? { pid: d.foreground.pid, name: d.foreground.name, argv: d.foreground.argv, cwd: d.foreground.cwd } : null,
          })
          return 'session' in r ? { file: ocFile(r.server, r.session), session: r.session, guessed: true } : null
        }
        return createTranscripts({ home, herdr, fs, locateCommandCode, locateOpencode, ocExec: shell, ...(deps.now ? { now: deps.now } : {}), codexHistory: name ? undefined : deps.codexHistory })
      })()
      machines.set(name, t)
      // One derived promise, both branches handled — a failed build is
      // not remembered (the machine may come back) and never unhandled.
      void t.then(x => { if (machines.get(name) === t) resolved.set(name, x) },
        () => { if (machines.get(name) === t) machines.delete(name) })
    }
    return t
  }

  // Start time of the terminal (Codex's conversation is claimed by it), once per address.
  const born = new Map<string, number>()
  async function withBirth(p: TranscriptPane): Promise<TranscriptPane> {
    if (p.bornAt) return p
    const address = deps.pane(p.id)?.coreAddress
    if (!address) return p
    let at = born.get(address)
    if (at === undefined) {
      at = (await detail(address).catch(() => null))?.created_ms
      if (typeof at === 'number') born.set(address, at)
    }
    return typeof at === 'number' ? { ...p, bornAt: at } : p
  }

  const of = (p: { id: string }) => forMachine(machineOfAddress(deps.pane(p.id)?.coreAddress))
  // A failed machine entry (home lookup, core error) resolves as each
  // method's own typed unavailable for Command Code panes — the value the
  // method answers when nothing can be read. Other agents keep throwing.
  const unavailable: Record<string, unknown> = {
    chat: { available: false, reason: 'not_found' },
    search: { hits: [], limited: false, kind: null },
    pendingAsk: [],
    pendingClaudeQuestions: []
  }
  const machineOf = (p: TranscriptPane) => of(p).catch(e => {
    if (p.agent === 'cmd' || p.agent === 'opencode') return null
    throw e
  })
  type Fn<K extends keyof Transcripts> = Transcripts[K] extends (p: TranscriptPane, ...a: infer A) => infer R ? (p: TranscriptPane, ...a: A) => R : never
  const viaPane = <K extends 'chat' | 'preview' | 'latestReply' | 'locate' | 'model' | 'pendingTool' | 'pendingAsk' | 'pendingClaudeQuestions' | 'search' | 'opencodeModels' | 'opencodePatchModel'>(k: K) =>
    (async (p: TranscriptPane, ...a: unknown[]) => {
      if (k === 'model' && (a[0] as { walTailOnly?: boolean } | undefined)?.walTailOnly) {
        if (p.agent !== 'agy') return null
        const m = resolved.get(machineOfAddress(deps.pane(p.id)?.coreAddress))
        return m ? m.model(p, a[0] as { walTailOnly?: boolean }) : null
      }
      const t = await machineOf(p)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return t ? (t[k] as any)(await withBirth(p), ...a) : unavailable[k] ?? null
    }) as unknown as Fn<K>

  return {
    chat: viaPane('chat'),
    preview: viaPane('preview'),
    latestReply: viaPane('latestReply'),
    locate: viaPane('locate'),
    model: viaPane('model'),
    opencodeModels: viaPane('opencodeModels'),
    opencodePatchModel: viaPane('opencodePatchModel'),
    pendingTool: viaPane('pendingTool'),
    pendingAsk: viaPane('pendingAsk'),
    pendingClaudeQuestions: viaPane('pendingClaudeQuestions'),
    search: viaPane('search'),
    // The reply-context revalidation exists for Command Code replies only:
    // gated before any machine/birth resolution so other agents gain no
    // extra failure path — they answer null (nothing to check) without
    // ever dispatching.
    current: async (p: TranscriptPane, r: ChatResponse) => {
      if (p.agent !== 'cmd' && p.agent !== 'opencode') return null
      const t = await machineOf(p)
      return t ? t.current(await withBirth(p), r) : 'gone'
    },
    // The synchronous final predicate for a reply's bound context — the
    // already-warm machine's own reader answers it; a cold machine or a
    // reply no reader bound answers null for other agents, false for a
    // Command Code or OpenCode available reply (it must have been bound
    // somewhere).
    live: (p: TranscriptPane, r: ChatResponse) =>
      resolved.get(machineOfAddress(deps.pane(p.id)?.coreAddress))?.live(p, r) ?? ((p.agent === 'cmd' || p.agent === 'opencode') && r.available ? false : null),
    image: async (p: TranscriptPane, file: string | null, ref: string | null, i: number) => {
      const t = await machineOf(p)
      return t ? t.image(await withBirth(p), file, ref, i) : null
    },
    forget: (id: string) => { for (const t of machines.values()) void t.then(x => x.forget(id)).catch(() => {}) },
    // Called with every inventory: the Codex claims need each peer's start time.
    async observe(panes: Pane[]) {
      const by = new Map<string, TranscriptPane[]>()
      for (const p of panes) {
        const m = machineOfAddress(p.coreAddress)
        const tp = p.agent === 'codex' || p.agent === 'agy' ? await withBirth({ id: p.id, agent: p.agent, cwd: p.cwd, status: p.status }).catch(() => p) : p
        by.set(m, [...(by.get(m) || []), tp as TranscriptPane])
      }
      // A machine whose agents all ended is observed too (with none): its caches empty.
      for (const name of machines.keys()) if (!by.has(name)) by.set(name, [])
      for (const [name, list] of by) void forMachine(name).then(t => t.observe(list)).catch(() => {})
    },
  }
}

export type CoreTranscripts = ReturnType<typeof createCoreTranscripts>
