// Command Code census record contract: line-format parsing and process
// classification for the A5 display-only session fallback. Pure functions
// over the bounded records emitted by AGENT_CENSUS_SCRIPT (agentProcesses.ts);
// no IO here. Selection fails closed: anything that makes the peer set
// unreliable (overflow, truncated output or records, a raced, unreadable or
// unclassifiable potential peer) marks the census incomplete instead of
// leaving a misleading sole-peer count.
import { birthUpperBound } from './devinProcesses'

export interface AgentProcess {
  pid: number
  ppid?: number // parent/generation evidence only: a nested cmd stays a peer
  comm?: string
  argv?: string[] // real NUL-boundary sampled argv (never re-split text)
  argvExact?: boolean // sampled argv == launch argv (false when retitled/cut)
  argvTruncated?: boolean
  cwd?: string // actual process cwd, not the terminal's spawn cwd
  exe?: string // resolved /proc/pid/exe
  startTicks?: number // process generation token (jiffies since boot)
  startedAt?: number // conservative ms upper bound on birth
}
export type CensusIncomplete = 'unavailable' | 'truncated' | 'oversize' | 'raced' | 'metadata'
export interface AgentCensus {
  complete: boolean
  incomplete?: CensusIncomplete
  processes: AgentProcess[] // classified Command Code processes only
  scanned: number
  unknown: number // live PIDs that could not be classified at all
}

// command-code 1.88.3 package bins all map to dist/index.mjs, which imports
// cli.mjs in-process: an interpreter plus that script is ONE agent PID.
// process.title = "command-code" then erases launch argv on Linux. Aliases are
// self-evident names; interpreter-launched entrypoints need the package shape.
const CMD_NAMES = new Set(['command-code', 'command_code', 'commandcode', 'cmdc'])
const CMD_BIN = new Set([...CMD_NAMES, 'cmd'])
const INTERPRETER = /^(node|nodejs|bunx?|deno)\d*$/
// Proven package entrypoints only: a directory merely NAMED command-code
// (or any other file inside it) is not evidence. Keep in sync with chk() in
// AGENT_CENSUS_SCRIPT.
const ENTRY = /\/command-code\/(?:dist\/(?:index|cli)\.mjs|bin\/(?:cmd|cmdc|command-code|commandcode|command_code))$/

// Small explicit subset of Node launch shapes we classify: module-load options
// consume a file operand (a real preload is load evidence), value options
// consume a non-file operand (never identity), flag options consume nothing,
// and --x=y is self-contained. Eval/print code, stdin scripts, non-Node
// interpreters and any unrecognized shape are UNKNOWN, never a silently
// absent peer. Keep in sync with the case arms in AGENT_CENSUS_SCRIPT.
const LOAD_OPERAND = new Set(['-r', '--require', '--import', '--experimental-loader'])
const VAL_OPERAND = new Set([
  '--env-file', '-C', '--conditions', '--watch-path', '--config',
  '--import-map', '--node-modules-dir', '--lock', '--cert',
])
const OPT_FLAG = new Set([
  '-v', '--version', '-h', '--help', '-i', '--interactive', '-c', '--check',
  '--inspect', '--inspect-brk', '--watch', '--no-warnings', '--trace-warnings',
  '--preserve-symlinks', '--preserve-symlinks-main', '--harmony',
  '--experimental-strip-types', '--experimental-transform-types',
])
const EVAL_OPTS = new Set(['-e', '--eval', '-p', '--print'])
const base = (s: string | undefined) => (s || '').split('/').pop() || ''

type ScriptPos =
  | { kind: 'script', raw: string, index: number, preloads: string[] }
  | { kind: 'eval' }
  | { kind: 'unknown' }
  | { kind: 'none' }

// The actual script position: consume the supported option subset, stop at
// the first positional (arguments after it never supply identity). `index` is
// the argv index of the script. An unterminated operand or unrecognized bare
// option means unknown.
function scriptPos(argv: string[], terminated: boolean): ScriptPos {
  const args = argv.slice(1)
  const preloads: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!a.startsWith('-')) return { kind: 'script', raw: a, index: i + 1, preloads } // a cut tail is the script's own argument
    if (a === '--') {
      const n = args[i + 1]
      return n === undefined ? { kind: 'unknown' } : { kind: 'script', raw: n, index: i + 2, preloads }
    }
    if (a === '-' || EVAL_OPTS.has(a) || a.startsWith('--eval=') || a.startsWith('--print=')) return { kind: 'eval' }
    const eq = a.indexOf('=')
    const k = eq > 0 ? a.slice(0, eq) : a
    if (LOAD_OPERAND.has(k)) {
      const v = eq > 0 ? a.slice(eq + 1) : args[++i]
      if (v === undefined || i === args.length - 1 && !terminated && eq < 0) return { kind: 'unknown' }
      if (v) preloads.push(v)
      continue
    }
    if (VAL_OPERAND.has(k)) { if (eq < 0) i++; continue }
    if (eq > 0) continue // --x=y self-contained
    if (OPT_FLAG.has(a)) continue
    return { kind: 'unknown' }
  }
  return { kind: 'none' }
}

function classify(p: { comm?: string, argv?: string[], exe?: string, terminated?: boolean, res?: { raw: string, res: string }[] }): 'peer' | 'other' | 'unknown' {
  const a0b = base(p.argv?.[0])
  if (p.comm && CMD_NAMES.has(p.comm)) return 'peer' // retitled agent (affirmative)
  if (a0b && CMD_NAMES.has(a0b)) return 'peer' // bin symlink or argv0 claim; over-count is safe
  if (p.exe && ENTRY.test(p.exe)) return 'peer'
  // The interpreter name is the real binary (comm) when it is one — argv0 may
  // be rewritten — otherwise argv0. Only Node's CLI subset is supported;
  // bun/deno and unclassifiable argv are unknown, not absent peers.
  const iname = INTERPRETER.test(p.comm ?? '') ? base(p.comm) : a0b
  if (INTERPRETER.test(iname)) {
    if (!/^node/.test(iname)) return 'unknown'
    if (!p.argv?.length) return 'unknown' // nothing to positionally classify
    const sp = scriptPos(p.argv, p.terminated !== false)
    if (sp.kind !== 'script') return 'unknown'
    const res = new Map((p.res ?? []).map(c => [c.raw, c.res]))
    const hit = (c: string) => CMD_BIN.has(base(c)) || ENTRY.test(c) || ENTRY.test(res.get(c) ?? '')
    return hit(sp.raw) || sp.preloads.some(hit) ? 'peer' : 'other'
  }
  // A bare `cmd` name alone is never sufficient (Windows cmd.exe, scripts,
  // exec -a): require interpreter or package evidence.
  if (a0b === 'cmd' && (INTERPRETER.test(base(p.exe)) || ENTRY.test(p.exe ?? ''))) return 'peer'
  return 'other'
}

// The agent's own argument vector: takes the FULL process argv (argv[0]
// included) and returns the arguments after the script position for an
// interpreter launch, or after argv0 for a directly-invoked binary/script.
// null when the boundary can't be proven (unknown option shape, eval, stdin,
// empty argv): callers must not guess where agent args begin.
export function agentArgsOf(argv: string[]): string[] | null {
  if (!argv.length) return null
  if (!INTERPRETER.test(base(argv[0]))) return argv.slice(1)
  const sp = scriptPos(argv, true)
  return sp.kind === 'script' ? argv.slice(sp.index + 1) : null
}

const MAX_CMDLINE = 16384
const MAX_RES = 16384
const MAX_LINE = 64 * 1024
const MAX_TOTAL = 4 * 1024 * 1024
const MAX_RECORDS = 256
const dec = (s: string | undefined) => (s ? Buffer.from(s, 'base64') : Buffer.alloc(0))
// readlink output is exactly target + '\n' (a missing link base64s to '').
const link = (s: string | undefined) => { const v = dec(s).toString('utf8'); return v ? v.replace(/\n$/, '') : undefined }

// Format: one `H hz boot ok` header first, `S`/`R` records, one
// `T scanned records overflow unknown` footer last. Anything else is unsafe.
export function parseAgentCensus(stdout: string): AgentCensus {
  const out: AgentCensus = { complete: true, processes: [], scanned: 0, unknown: 0 }
  const fail = (w: CensusIncomplete) => { if (!out.incomplete) out.incomplete = w; out.complete = false }
  const raw = String(stdout || '')
  // Hard gate before any split/decode/record allocation.
  if (Buffer.byteLength(raw, 'utf8') > MAX_TOTAL) { out.complete = false; out.incomplete = 'oversize'; return out }
  const lines = raw.split('\n')
  if (lines.at(-1) === '') lines.pop()
  let hz = NaN, boot = NaN, ok = false
  const l0 = lines[0] ?? ''
  if (l0.length > MAX_LINE) fail('oversize')
  const h = l0.split(' ')
  if (h[0] === 'H' && h.length === 4) {
    [hz, boot] = [Number(h[1]), Number(h[2])]
    ok = h[3] === '1'
  } else fail('truncated')
  let sawT = false, sLines = 0, raced = 0, records = 0
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (!line) continue
    if (line.length > MAX_LINE) { fail('oversize'); continue }
    const p = line.split(' ')
    const last = i === lines.length - 1
    if (p[0] === 'R' && p.length === 2 && /^\d+$/.test(p[1]!)) {
      raced++
      if (++records > MAX_RECORDS) fail('oversize')
      continue
    }
    if (p[0] === 'T') {
      if (!last) { fail('truncated'); continue }
      const [n, r, o, u] = p.slice(1).map(Number)
      if (p.length !== 5 || ![n, r, o, u].every(v => Number.isSafeInteger(v) && v! >= 0)) { fail('truncated'); continue }
      sawT = true; out.scanned = n!; out.unknown = u!
      if (r !== sLines || n! < records) fail('truncated')
      if (o! > 0) fail('oversize')
      if (u! > 0) fail('metadata')
      continue
    }
    if (p[0] !== 'S' || p.length !== 11) { fail('truncated'); continue }
    sLines++
    if (++records > MAX_RECORDS) { fail('oversize'); continue } // stop decoding/allocating at the cap
    const [pid, ppid, ticks, up, wall] = p.slice(1, 6).map(Number)
    if (!Number.isSafeInteger(pid) || pid! <= 0) { fail('truncated'); continue }
    const argvBytes = dec(p[7])
    const argvTruncated = argvBytes.length > MAX_CMDLINE
    const terminated = argvBytes.at(-1) === 0
    // Only complete NUL-terminated args are evidence: a trailing partial arg
    // means cut or dying process state, never launch argv.
    const parts = argvBytes.length ? argvBytes.toString('utf8').split('\0').slice(0, -1) : []
    const resBytes = dec(p[10])
    if (resBytes.length > MAX_RES) fail('oversize')
    const resParts = resBytes.toString('utf8').split('\x01')
    const res: { raw: string, res: string }[] = []
    if (resParts.at(-1) === '') resParts.pop()
    if (resParts.length % 2) fail('truncated')
    for (let i = 0; i + 1 < resParts.length; i += 2) res.push({ raw: resParts[i]!, res: resParts[i + 1]! })
    const proc: AgentProcess = {
      pid: pid!,
      ppid: Number.isSafeInteger(ppid) && ppid! >= 0 ? ppid : undefined,
      comm: dec(p[6]).toString('utf8') || undefined,
      argv: parts.length ? parts : undefined,
      cwd: link(p[8]),
      exe: link(p[9])?.replace(/ \(deleted\)$/, ''),
      startTicks: Number.isSafeInteger(ticks) && ticks! >= 0 ? ticks : undefined,
      startedAt: birthUpperBound(ticks!, hz, boot, up!, wall!),
      argvTruncated: argvTruncated || undefined,
      argvExact: parts.length ? !argvTruncated && terminated : undefined,
    }
    const cls = classify({ comm: proc.comm, argv: proc.argv, exe: proc.exe, terminated, res })
    if (cls === 'unknown') { fail('metadata'); continue }
    if (cls !== 'peer') continue
    // The process.title rewrite leaves argv == [comm] on an interpreter exe:
    // classifying evidence, but the launch arguments are gone.
    if (proc.argvExact && proc.comm && CMD_NAMES.has(proc.comm) && proc.argv?.[0] === proc.comm && INTERPRETER.test(base(proc.exe))) proc.argvExact = false
    if (argvTruncated) fail('oversize')
    else if (proc.argv && !terminated) fail('truncated')
    if (!proc.cwd || !proc.argv || proc.startedAt === undefined) fail('metadata')
    out.processes.push(proc)
  }
  if (!ok) { fail('unavailable'); out.processes = []; return out }
  if (!sawT) fail('truncated')
  if (raced) fail('raced')
  return out
}
