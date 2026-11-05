// Conversation files of herdr-core agents. v2's transcript reader (transcripts.ts) finds a
// Claude Code or Codex conversation from the agent's process, folder and start time; here
// core supplies those (terminal.get) and, for a remote core machine, the machine's disk
// (machine.exec through createShellFs), so the same reader, parsers, search and queue apply.
import { createShellFs, localFs, type ExecResult, type MachineFs, type ShellExec } from './fsx'
import { createTranscripts, type TranscriptPane, type Transcripts } from './transcripts'
import { CoreError } from './core'
import type { Pane } from '../../shared/types'
import { DEVIN_PROCESS_SCRIPT, devinProcesses } from './devinProcesses'

type Call = <T>(method: string, params: object, timeout: number) => Promise<T>
export interface CoreTranscriptDeps {
  call: Call
  pane: (id: string) => Pane | undefined
  localHome: string
}

interface CoreProcess { pid?: number, name?: string, argv?: string[], cwd?: string, startedAt?: number, argvExact?: boolean }
interface CoreDetail { pid?: number, argv?: string[], created_ms?: number, foreground?: CoreProcess | null }

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

const AGENT_PROGRAMS = new Set(['claude', 'codex', 'omp', 'devin'])
const baseName = (s: string | undefined) => (s || '').split('/').pop() || ''
// Programs under the terminal's process, from `ps -e -o pid=,ppid=,args=`: an agent started by a
// shell, or hosted by a helper, is not the foreground process of the terminal.
export function agentDescendants(ps: string, root: number): CoreProcess[] {
  const rows = ps.split('\n').map(l => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map(m => ({ pid: Number(m![1]), ppid: Number(m![2]), argv: m![3]!.split(/\s+/) }))
  const seen = new Set([root])
  const out: CoreProcess[] = []
  for (let grew = true; grew;) {
    grew = false
    for (const r of rows) {
      if (seen.has(r.pid) || !seen.has(r.ppid)) continue
      seen.add(r.pid)
      grew = true
      const name = [baseName(r.argv[0]), baseName(r.argv[1])].find(n => AGENT_PROGRAMS.has(n)) || ''
      if (name) out.push({ pid: r.pid, name, argv: r.argv, argvExact: false })
    }
  }
  return out
}

export function coreShell(call: Call, on: string): ShellExec {
  return async (script, args = [], opts = {}): Promise<ExecResult> => {
    const seconds = Math.max(1, Math.ceil((opts.timeoutMs ?? 15000) / 1000))
    try {
      const r = await call<{ code: number | null, stdout?: string, stderr?: string, timed_out?: boolean, truncated?: boolean }>('machine.exec', {
        argv: ['sh', '-c', script, 'sh', ...args], on, timeout: seconds,
        ...(opts.input ? { input: opts.input.toString('base64') } : {}),
      }, seconds * 1000 + 5000)
      const stdout = Buffer.from(r.stdout || '', 'base64')
      if (r.timed_out) return { code: 124, stdout, stderr: 'timed out' }
      if (opts.maxBytes && (r.truncated || stdout.length > opts.maxBytes)) return { code: 125, stdout: Buffer.alloc(0), stderr: 'output too large' }
      return { code: r.code, stdout, stderr: Buffer.from(r.stderr || '', 'base64').toString('utf8') }
    } catch (e) {
      // An unreachable machine reads as the SSH failure code (the file's state is unknown).
      return { code: 255, stdout: Buffer.alloc(0), stderr: e instanceof CoreError ? e.message : 'unreachable' }
    }
  }
}

export function createCoreTranscripts(deps: CoreTranscriptDeps) {
  const details = new Map<string, { at: number, d: CoreDetail }>()
  async function detail(address: string): Promise<CoreDetail> {
    const hit = details.get(address)
    if (hit && Date.now() - hit.at < 1500) return hit.d
    const d = await deps.call<CoreDetail>('terminal.get', { terminal: address }, 4000)
    details.set(address, { at: Date.now(), d })
    if (details.size > 200) details.delete(details.keys().next().value!)
    return d
  }
  const herdr = async (method: string, params: Record<string, unknown> = {}) => {
    const address = deps.pane(String(params.pane_id || ''))?.coreAddress
    if (method !== 'pane.process_info' || !address) throw new CoreError('unsupported', 'unsupported')
    const d = await detail(address)
    const info = processInfo(d)
    const procs = info.process_info.foreground_processes
    if (!procs.some(p => AGENT_PROGRAMS.has(baseName(p.argv?.[0] || p.name))) && typeof d.pid === 'number') {
      const on = machineOfAddress(address)
      const ps = await deps.call<{ stdout?: string }>('machine.exec', { argv: ['ps', '-e', '-o', 'pid=,ppid=,args='], ...(on ? { on } : {}), timeout: 5 }, 8000).catch(() => null)
      procs.unshift(...agentDescendants(Buffer.from(ps?.stdout || '', 'base64').toString('utf8'), d.pid))
    }
    const devin = procs.filter(p => [baseName(p.name), ...(p.argv?.slice(0, 2).map(baseName) || [])].includes('devin') && Number.isSafeInteger(p.pid) && p.pid! > 0)
    if (devin.length) {
      // Exact argv and a conservative birth bound, read together on the agent's machine.
      const on = machineOfAddress(address)
      const r = await deps.call<{ stdout?: string }>('machine.exec', {
        argv: ['sh', '-c', DEVIN_PROCESS_SCRIPT, 'sh', ...devin.map(p => String(p.pid))],
        ...(on ? { on } : {}), timeout: 5,
      }, 8000).catch(() => null)
      const snapshot = devinProcesses(Buffer.from(r?.stdout || '', 'base64').toString('utf8'))
      for (const p of devin) Object.assign(p, snapshot.get(p.pid!))
    }
    return info
  }

  const machines = new Map<string, Promise<Transcripts>>()
  function forMachine(name: string): Promise<Transcripts> {
    let t = machines.get(name)
    if (!t) {
      t = (async () => {
        if (!name) return createTranscripts({ home: deps.localHome, herdr, fs: localFs })
        const shell = coreShell(deps.call, name)
        const home = (await shell('printf %s "$HOME"')).stdout.toString('utf8').trim()
        if (!home.startsWith('/')) throw new CoreError('unreachable', 'machine home unknown')
        const fs: MachineFs = createShellFs(shell)
        return createTranscripts({ home, herdr, fs })
      })()
      machines.set(name, t)
      // Not remembered when it fails: the machine may come back.
      t.catch(() => { if (machines.get(name) === t) machines.delete(name) })
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
  type Fn<K extends keyof Transcripts> = Transcripts[K] extends (p: TranscriptPane, ...a: infer A) => infer R ? (p: TranscriptPane, ...a: A) => R : never
  const viaPane = <K extends 'chat' | 'preview' | 'latestReply' | 'locate' | 'model' | 'pendingTool' | 'pendingAsk' | 'pendingClaudeQuestions' | 'search'>(k: K) =>
    (async (p: TranscriptPane, ...a: unknown[]) => {
      const t = await of(p)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (t[k] as any)(await withBirth(p), ...a)
    }) as unknown as Fn<K>

  return {
    chat: viaPane('chat'),
    preview: viaPane('preview'),
    latestReply: viaPane('latestReply'),
    locate: viaPane('locate'),
    model: viaPane('model'),
    pendingTool: viaPane('pendingTool'),
    pendingAsk: viaPane('pendingAsk'),
    pendingClaudeQuestions: viaPane('pendingClaudeQuestions'),
    search: viaPane('search'),
    image: async (p: TranscriptPane, file: string | null, ref: string | null, i: number) => (await of(p)).image(await withBirth(p), file, ref, i),
    forget: (id: string) => { for (const t of machines.values()) void t.then(x => x.forget(id)).catch(() => {}) },
    // Called with every inventory: the Codex claims need each peer's start time.
    async observe(panes: Pane[]) {
      const by = new Map<string, TranscriptPane[]>()
      for (const p of panes) {
        const m = machineOfAddress(p.coreAddress)
        const tp = p.agent === 'codex' ? await withBirth({ id: p.id, agent: p.agent, cwd: p.cwd, status: p.status }).catch(() => p) : p
        by.set(m, [...(by.get(m) || []), tp as TranscriptPane])
      }
      for (const [name, list] of by) void forMachine(name).then(t => t.observe(list)).catch(() => {})
    },
  }
}

export type CoreTranscripts = ReturnType<typeof createCoreTranscripts>
