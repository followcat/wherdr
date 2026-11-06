// Pure Command Code session selection: the approved display-only fallback.
// A COMPLETE machine-local census + a COMPLETE bounded candidate list pick
// the conversation a process most probably shows. Display only: sends still
// go to the terminal, and every unproven shape returns `unavailable` — never
// a cached or guessed file. Documented residual: a second, short-lived
// process in the same cwd could have exited after writing the newest file;
// nothing here can rule that out, which is why this is a fallback.
import path from 'node:path'
import type { AgentCensus } from './agentCensus'
import { agentArgsOf } from './agentCensus'

// A validated transcript candidate, as the collector supplies it: the file
// passed path/header validation (cmdHeaderOf + cmdSessionFile), so file and
// id already agree and cwd is the session header's own cwd.
export interface CmdCandidate {
  file: string
  id: string
  cwd: string
  mtimeMs: number
  size?: number
  ino?: number
}

// The census row to resolve: pid and startTicks together identify one
// process generation; pid alone is reusable. bornMs is the caller's proven
// upper bound on the agent's own start — e.g. the first machine wall at
// which this generation was observed classified as cmd, the only bound that
// survives a fork->exec gap. It may raise the generation bound, never lower
// it; omitted means the process-generation bound (launch-proven targets).
export interface CmdTarget { pid: number, startTicks: number, bornMs?: number }

export type CmdUnavailable = 'incomplete' | 'target' | 'peers' | 'empty' | 'tie'
export type CmdSelection = { file: string, session: string } | { unavailable: CmdUnavailable }

export const cmdProjectsRoot = (home: string) => path.join(home, '.commandcode', 'projects')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEADER_BYTES = 16384 // first-line cap; the collector reads a complete line within it
export const absPath = (s: string) => s.startsWith('/') && !s.includes('\0')

// The v3 session header (first line): {type:"session", version:3, id, cwd}.
// Anything else — wrong type/version, non-UUID id, missing/relative/NUL cwd —
// is not a candidate. The id must also equal the file basename (checked by the
// collector via cmdSessionFile); it is not re-checked here.
export function cmdHeaderOf(firstLine: string): { id: string, cwd: string } | null {
  if (Buffer.byteLength(firstLine, 'utf8') > HEADER_BYTES) return null
  let d: { type?: unknown, version?: unknown, id?: unknown, cwd?: unknown }
  try { d = JSON.parse(firstLine) } catch { return null }
  if (d?.type !== 'session' || d.version !== 3) return null
  if (typeof d.id !== 'string' || !UUID.test(d.id)) return null
  if (typeof d.cwd !== 'string' || !absPath(d.cwd)) return null
  return { id: d.id, cwd: d.cwd }
}

// Already canonical: absolute, no NUL, and no '.', '..' or empty raw segments.
// Symlink resolution can make a normalized path different from the raw one, so
// normalization is never allowed to bless a non-canonical shape.
export const cmdCanonicalPath = (p: string) => absPath(p) && !p.split('/').slice(1).some(s => !s || s === '.' || s === '..')

// <root>/<one project dir>/<full UUID>.jsonl, confined under the projects
// root. Traversal, extra depth, non-UUID basenames and sidecar files
// (.checkpoints.jsonl, .meta.json…) are all rejected; path resolution is
// never used to bless a file outside this shape.
export function cmdSessionFile(root: string, file: string): { dir: string, id: string } | null {
  if (!cmdCanonicalPath(root) || !cmdCanonicalPath(file)) return null
  const rel = path.relative(root, file)
  if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return null
  const parts = rel.split('/')
  if (parts.length !== 2 || !parts[1]!.endsWith('.jsonl')) return null
  const id = parts[1]!.slice(0, -'.jsonl'.length)
  return UUID.test(id) ? { dir: parts[0]!, id } : null
}

// The only exact launch evidence in Command Code argv is `--session` with a
// full UUID or an absolute transcript path confined under the projects root.
// -r/--resume names, -c/--continue, prefixes, malformed, duplicate or
// conflicting flags are NOT exact evidence; argvExact != true means the
// launch args are gone entirely (the caller gates on that flag).
// `argv` is the full process argv (argv[0] included); agentArgsOf isolates
// the agent's own arguments after the script/binary boundary, so a --session
// passed to node itself can never bleed through as agent evidence.
//
// The supported option grammar is deliberately tiny: session selectors are
// --session (operand), -r/--resume (name operand) and the -c/--continue,
// --fork-session, --no-session flags; --prompt/-p/--print/--model/-m take an
// operand; -h/--help/-v/--version are flag-only. Any OTHER bare option is
// unsupported → no seed: an unknown option's operand must never masquerade
// as --session. Two selectors — including a second --session — conflict →
// no seed. A positional or `--` ends scanning; prompt text is never searched.
const SELECTOR_VAL = new Set(['-r', '--resume'])
const SELECTOR_FLAG = new Set(['-c', '--continue', '--fork-session', '--no-session'])
const KNOWN_VAL = new Set(['--prompt', '-p', '--print', '--model', '-m'])
const KNOWN_FLAG = new Set(['-h', '--help', '-v', '--version'])

export function cmdResumeSeed(root: string, argv: string[]): { kind: 'id' | 'path', value: string } | null {
  const args = agentArgsOf(argv)
  if (!args) return null
  let value: string | null = null
  let otherSelector = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!a.startsWith('-') || a === '--') break
    const eq = a.indexOf('=')
    const k = eq > 0 ? a.slice(0, eq) : a
    const operand = () => eq > 0 ? a.slice(eq + 1) : args[++i]
    if (k === '--session') {
      const v = operand()
      if (!v || v.startsWith('-') || value !== null || otherSelector) return null
      value = v
      continue
    }
    if (SELECTOR_FLAG.has(k)) {
      if (value !== null) return null
      otherSelector = true
      continue
    }
    if (SELECTOR_VAL.has(k)) {
      operand()
      if (value !== null) return null
      otherSelector = true
      continue
    }
    if (KNOWN_VAL.has(k)) {
      if (operand() === undefined) return null
      continue
    }
    if (KNOWN_FLAG.has(k)) continue
    return null // unsupported option shape: fail closed
  }
  if (value === null) return null
  if (UUID.test(value)) return { kind: 'id', value }
  return cmdSessionFile(root, value) ? { kind: 'path', value } : null
}

// Selection under the approved rules: exact target row (pid + startTicks) in
// a complete census, exactly one same-cwd peer (nested agents stay peers;
// subtraction is never used), every candidate strictly newer than the
// conservative birth bound, latest post-birth write wins — a launch-time
// seed only ADDS a candidate, it never pins one.
export function cmdSelect(input: {
  root: string
  census: AgentCensus
  target: CmdTarget
  argv?: { argv: string[], argvExact: boolean }
  candidates: { complete: boolean, items: CmdCandidate[] }
}): CmdSelection {
  const { census, target, candidates } = input
  if (!census.complete || !candidates.complete) return { unavailable: 'incomplete' }
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0
    || !Number.isSafeInteger(target.startTicks) || target.startTicks < 0) {
    return { unavailable: 'target' }
  }
  const rows = census.processes.filter(p => p.pid === target.pid)
  const proc = rows.length === 1 && rows[0]!.startTicks === target.startTicks ? rows[0]! : null
  if (!proc || !Number.isFinite(proc.startedAt) || !proc.cwd || !absPath(proc.cwd)) {
    return { unavailable: 'target' }
  }

  // All live same-agent processes in this exact process cwd count, including
  // nested/ancestor ones and ones outside core inventory. More than one is
  // always unavailable: immutable launch flags cannot prove the CURRENT
  // session after /clear or /resume, and peer ids are never subtracted.
  if (census.processes.filter(p => p.cwd === proc.cwd).length !== 1) return { unavailable: 'peers' }

  // The strict bound: a proven upper bound on agent start, defaulting to
  // the generation bound. A supplied bornMs below process birth would
  // WEAKEN the proof — refuse; a missing or non-finite one fails closed.
  if (input.target.bornMs !== undefined && (!Number.isFinite(input.target.bornMs) || input.target.bornMs < proc.startedAt!)) {
    return { unavailable: 'target' }
  }
  const born = input.target.bornMs ?? proc.startedAt!
  const post = (c: CmdCandidate) => c.mtimeMs > born // strict: a write at the bound is not after it
  // A candidate must re-validate even on a "complete" list: file confined to
  // <root>/<dir>/<uuid>.jsonl, basename equal to id, header cwd absolute.
  const valid = (c: CmdCandidate) =>
    typeof c.file === 'string' && typeof c.id === 'string' && Number.isFinite(c.mtimeMs)
    && typeof c.cwd === 'string' && absPath(c.cwd) && cmdSessionFile(input.root, c.file)?.id === c.id
  const eligible = new Map<string, CmdCandidate>()
  for (const c of candidates.items) {
    if (valid(c) && c.cwd === proc.cwd && post(c)) eligible.set(c.file, c)
  }

  // A proven launch target joins the candidate set even when its header cwd
  // differs (a cross-cwd resume appends to the old file, whose header keeps
  // its original cwd). It still needs a strict post-birth write — there is
  // no pre-birth exception for resume — and a full-id seed must match
  // exactly one file across all project dirs.
  if (input.argv?.argvExact === true) {
    const seed = cmdResumeSeed(input.root, input.argv.argv)
    if (seed) {
      const hits = candidates.items.filter(c => valid(c) && (seed.kind === 'id'
        ? c.id === seed.value
        : c.file === seed.value))
      if (hits.length === 1 && post(hits[0]!)) eligible.set(hits[0]!.file, hits[0]!)
    }
  }

  // An eligible candidate in a FOREIGN cwd is only reachable via an exact
  // seed. A live cmd process in that cwd makes its ownership ambiguous —
  // the peer's own launch target is unknowable after retitle, so peers are
  // never subtracted by sampled argv, and the seed never "pins" the file to
  // this launch either. Refuse entirely rather than drop the contested file
  // and silently choose a same-cwd one.
  const foreign = new Set<string>()
  for (const c of eligible.values()) if (c.cwd !== proc.cwd) foreign.add(c.cwd)
  if (foreign.size && census.processes.some(p => p.cwd && foreign.has(p.cwd))) return { unavailable: 'peers' }

  // An unclassifiable process voids only the lookups it could affect: same
  // cwd (a possible hidden peer), the header cwd of an ELIGIBLE candidate
  // (that file may be the unknown's write — the cross-cwd launch target
  // included), or an unreadable/non-absolute cwd (irrelevance can never be
  // proven). An unknown elsewhere cannot change this answer and must not
  // void it; it is never a proven other and never silently dropped.
  const candCwd = new Set<string>()
  for (const c of eligible.values()) candCwd.add(c.cwd)
  for (const u of census.uncertain) {
    if (!u.cwd || !absPath(u.cwd) || u.cwd === proc.cwd || candCwd.has(u.cwd)) return { unavailable: 'peers' }
  }

  if (!eligible.size) return { unavailable: 'empty' }
  let best: CmdCandidate | null = null
  let tie = false
  for (const c of eligible.values()) {
    if (!best || c.mtimeMs > best.mtimeMs) { best = c; tie = false }
    else if (c.mtimeMs === best.mtimeMs && c.file !== best.file) tie = true
  }
  if (!best || tie) return { unavailable: 'tie' }
  return { file: best.file, session: best.id }
}
