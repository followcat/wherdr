// Antigravity CLI (`agy`) conversations: ~/.gemini/antigravity-cli/conversations/
// <uuid>.db (SQLite, WAL mode, protobuf step payloads). Remote machines read a
// kept local copy through MachineFs: the database goes back over the wire only
// when its own identity moves, a matching WAL generation only by its grown
// tail, and a pair that moved under the copy is retried so node:sqlite always
// opens one generation. Locally the live database is opened in place,
// read-only, only while agy holds both sidecars (node:sqlite would create
// them otherwise); every other local read uses the same kept copy.
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, truncateSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ChatItem, ChatResponse, ModelInfo } from '../../shared/types'
import { clip } from './transcriptText'
import { type TranscriptPane, isMissing } from './transcripts'
import { excerpt, matchAt } from '../../shared/searchText'
import { ompModelLabel } from './models'
import { HerdrError } from './herdr'
import { type FsStat, type MachineFs, localFs } from './fsx'
import { type DatabaseSync, type DatabaseSyncCtor, SQLITE_UNSUPPORTED, databaseSyncCtor, isSqliteUnsupported, sqliteReady } from './sqliteDb'
import { fieldOf, isoOf, subOf, textOf, tsOf, wireFields, type WireField } from './agyProtobuf'

export interface AgyOptions { since?: string, from?: number | null, before?: number | null, anchor?: string }

const PAGE_ITEMS = 120
// Snapshot budget (database + WAL); larger sessions stay unavailable rather
// than copying hundreds of MB per poll on a small host.
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024
const READ_CHUNK_BYTES = 4 * 1024 * 1024
const FAIL_QUIET_MS = 1500
// A host may be a Raspberry Pi; do not retain dozens of parsed transcripts.
const DOCUMENT_CACHE_ENTRIES = 4
// The 32-byte WAL header: magic, page size, checkpoint sequence and salts —
// unchanged while a generation only appends, rewritten by every restart.
const WAL_HEADER_BYTES = 32
const WAL_FRAME_HEADER_BYTES = 24
// A file that moved under the copy: the read retries on a fresh state, so the
// database is never opened against a WAL from another generation.
const MOVED = 'wherdr-moved'
const moved = (message: string) => Object.assign(new Error(message), { code: MOVED })
const isMoved = (e: unknown) => (e as { code?: string } | null)?.code === MOVED
// File identity: inode, mtime and size together — the database is recopied
// only when this moves.
const idOf = (st: { mtimeMs: number, ino?: number, size: number }) => `${st.ino ?? 0}:${st.mtimeMs}:${st.size}`
// File generation: any change of the database or its WAL is another state.
const genOf = (db: { mtimeMs: number, ino?: number, size: number }, wal: { mtimeMs: number, ino?: number, size: number } | null) =>
  hash12(`${idOf(db)}:${wal ? idOf(wal) : '-'}`)
const hash12 = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12)
const HEAD = /^(.*):(\d+):(null|\d+):([0-9a-f]{12})(?=[/~#]|$)/
const ANCHOR = /\/(\d+)\.([0-9a-f]{12})(?=[~#]|$)/
const AGY_SESSION = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
// Prefix of the kept copies in the temp dir (conv.db and conv.db-wal each),
// followed by the owning process's pid: `wherdr-agy-<pid>-XXXXXX`.
const KEPT_PREFIX = 'wherdr-agy-'
const KEPT_NAME = /^wherdr-agy-(\d+)-/

// Whether a process with this pid exists: another user's (EPERM) counts as
// alive, only a missing one (ESRCH) does not.
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as { code?: string } | null)?.code !== 'ESRCH' }
}

// A kept copy of a previous run (a restart while one was open) stays in the
// temp dir — often tmpfs — up to the snapshot limit each. Called once at
// startup (server/plugins/poller.ts): only a folder whose pid no longer runs is
// removed, so a second server sharing the temp dir keeps the copies it is
// reading. A reused pid only delays the cleanup to a later start. Anything
// else in the temp dir is left alone.
export function sweepAgyCopies(dir = tmpdir()): void {
  let names: string[]
  try { names = readdirSync(dir) } catch { return }
  for (const name of names) {
    const found = KEPT_NAME.exec(name)
    const pid = found ? Number(found[1]) : 0
    if (!pid || !Number.isSafeInteger(pid) || alive(pid)) continue
    try { rmSync(path.join(dir, name), { recursive: true, force: true }) } catch { /* held by another process */ }
  }
}


// End of the last whole WAL frame a file of `keptSize` bytes holds
// (32 + n * (24 + page size)); the page size sits in the WAL header's
// bytes 8–11. A copy can end mid-frame — a frame's 24-byte header and its
// page are separate writes — and SQLite can rewrite that frame's header
// later in the same generation (walRewriteChecksums starting exactly at
// it), so bytes past this boundary are never trusted across reads. null
// when nothing verifiable remains (no whole frame, implausible page
// size): the next read must copy in full.
function walWholeEnd(head: Buffer | null, keptSize: number): number | null {
  const pageSize = head && head.length >= 12 ? head.readUInt32BE(8) : 0
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return null
  const frame = WAL_FRAME_HEADER_BYTES + pageSize
  const whole = Math.floor((keptSize - WAL_HEADER_BYTES) / frame)
  return whole < 1 ? null : WAL_HEADER_BYTES + whole * frame
}

// Byte range of the last whole WAL frame below `keptSize`. Within one
// generation a rewound savepoint can still rewrite the headers of frames a
// spilling transaction already wrote, so a matching 32-byte header alone
// does not prove a kept prefix is current — this frame must read the same
// remotely before the tail may append.
function walLastFrame(head: Buffer, keptSize: number): { start: number, len: number } | null {
  const end = walWholeEnd(head, keptSize)
  return end === null ? null : { start: end - (WAL_FRAME_HEADER_BYTES + head.readUInt32BE(8)), len: WAL_FRAME_HEADER_BYTES }
}

// `len` bytes of a local file at `start` (short when the file ends sooner).
function localSlice(file: string, start: number, len: number): Buffer {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(len)
    return buf.subarray(0, readSync(fd, buf, 0, len, start))
  } finally { closeSync(fd) }
}

// node:sqlite loads lazily through server/utils/sqliteDb.ts: nothing else in
// the process pays its ExperimentalWarning, and a Node built before 22.13
// keeps running — an Antigravity pane on such a runtime stays in Terminal
// mode with reason `unsupported`, never a crash.

// step_type values seen in conversations/<id>.db.
const USER_INPUT = 14
const PLANNER_RESPONSE = 15
const ERROR_MESSAGE = 17
const OBSERVATION = 132

export function agyCliDir(home: string, honorEnv = true): string {
  if (honorEnv) {
    const dir = process.env.ANTIGRAVITY_APP_DATA_DIR
    if (dir) return dir
  }
  return path.join(home, '.gemini', 'antigravity-cli')
}

export function conversationPath(home: string, session: string, honorEnv = true): string | null {
  if (!session || !AGY_SESSION.test(session)) return null
  return path.join(agyCliDir(home, honorEnv), 'conversations', `${session}.db`)
}

// ------------------------------------------------------------ protobuf decode
// The `steps` row's `metadata` column and `step_payload` field 5 carry the same
// message: { 1: Timestamp created, 3: source, 4: tool call reference on
// observations, 6/7/8: start/end Timestamps, 9: generation info, 12: step uuid,
// 20: { trajectory, index, cascade } }.
interface StepMeta {
  ts: string | null
  startMs: number | null
  endMs: number | null
  callId: string | null
  callName: string | null
  callArgs: string | null
}

function stepMeta(buf: Uint8Array | null | undefined, payload: Uint8Array | null | undefined): StepMeta {
  const fs = wireFields(buf && buf.length ? buf : fieldOf(payload, 5)?.buf)
  const ts = isoOf(fs.find(f => f.tag === 1))
  const start = tsOf(fs.find(f => f.tag === 6))
  const end = tsOf(fs.find(f => f.tag === 8)) ?? tsOf(fs.find(f => f.tag === 7))
  const call = subOf(fs.find(f => f.tag === 4))
  return {
    ts, startMs: start, endMs: end,
    callId: textOf(call.find(f => f.tag === 1)) || null,
    callName: textOf(call.find(f => f.tag === 2)) || null,
    callArgs: textOf(call.find(f => f.tag === 3)) || null,
  }
}

// A user prompt may arrive wrapped in <USER_REQUEST>…</USER_REQUEST>, followed
// by machine context blocks that are not part of what was typed.
const USER_REQUEST = /^\s*<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/
const USER_CONTEXT = /\n\s*<(?:user|system|workspace|context|environment)[a-z_-]*[\s>][\s\S]*$/i
export function agyUserText(f19: WireField | undefined): string {
  let text = textOf(subOf(f19).find(f => f.tag === 2)) || textOf(subOf(subOf(f19).find(f => f.tag === 3)).find(f => f.tag === 1))
  const wrapped = USER_REQUEST.exec(text)
  if (wrapped) text = wrapped[1]!
  return clip(text.replace(USER_CONTEXT, '').trim())
}

interface AgyCall { id: string, name: string, args: string }
export interface AgyStep {
  idx: number
  role: 'user' | 'agent' | 'obs' | 'error' | 'hidden'
  ts: string | null
  ms: number | undefined
  text: string
  thinking: string
  calls: AgyCall[]
  resultOf: string | null
  out: string
  error: boolean
}

// step_payload.140: { 1: { key, value } summary entries (repeated),
// 2: { 1: result text, 3: display, 6: details, 7: artifact link } }.
function observationOut(payload: Uint8Array | null | undefined): string {
  const f2 = subOf(fieldOf(payload, 140)).find(f => f.tag === 2)
  return clip(textOf(subOf(f2).find(f => f.tag === 1)))
}

function errorText(payload: Uint8Array | null | undefined, details: Uint8Array | null | undefined): string {
  const f3 = subOf(fieldOf(payload, 24)).find(f => f.tag === 3)
  const own = subOf(f3)
  const text = textOf(own.find(f => f.tag === 2)) || textOf(own.find(f => f.tag === 1))
    || (details ? new TextDecoder('utf-8', { fatal: false }).decode(details) : '')
  return clip(text)
}

export function agyToolSummary(name: string, argsJson: string): string {
  let args: Record<string, unknown> = {}
  try { const a = JSON.parse(argsJson || ''); if (a && typeof a === 'object' && !Array.isArray(a)) args = a } catch { /* unparsed arguments: the name still labels the call */ }
  const first = (...keys: string[]) => keys.map(k => args[k]).find(v => typeof v === 'string' && v.trim()) as string | undefined
  const text = first('CommandLine', 'Path', 'FilePath', 'Query', 'Url', 'Pattern', 'DirPath', 'Description', 'Prompt', 'Question', 'TaskId')
    || Object.values(args).find((v): v is string => typeof v === 'string' && Boolean(v.trim())) || name
  return clip(String(text).split('\n').find(l => l.trim()) || name)
}

export function parseAgyStep(idx: number, type: number, status: number, meta: Uint8Array | null | undefined, payload: Uint8Array | null | undefined, details: Uint8Array | null | undefined): AgyStep | null {
  const m = stepMeta(meta, payload)
  const ms = m.startMs !== null && m.endMs !== null && m.endMs >= m.startMs ? Math.round(m.endMs - m.startMs) : undefined
  const failed = status === 6 || status === 7 || Boolean(details && details.length)
  if (type === USER_INPUT) {
    const text = agyUserText(fieldOf(payload, 19))
    return text ? { idx, role: 'user', ts: m.ts, ms: undefined, text, thinking: '', calls: [], resultOf: null, out: '', error: false } : null
  }
  if (type === PLANNER_RESPONSE) {
    const f20 = subOf(fieldOf(payload, 20))
    const thinking = clip(textOf(f20.find(f => f.tag === 3)))
    // 1 is the reply shown in the terminal; 8 repeats it (signed copy).
    const text = clip(textOf(f20.find(f => f.tag === 1)) || textOf(f20.find(f => f.tag === 8)))
    const calls: AgyCall[] = []
    for (const c of f20.filter(f => f.tag === 7)) {
      const fs = subOf(c)
      const id = textOf(fs.find(f => f.tag === 1))
      if (id) calls.push({ id, name: textOf(fs.find(f => f.tag === 2)) || 'Tool', args: textOf(fs.find(f => f.tag === 3)) })
    }
    if (!thinking && !text && !calls.length) return null
    return { idx, role: 'agent', ts: m.ts, ms, text, thinking, calls, resultOf: null, out: '', error: failed }
  }
  if (type === OBSERVATION) {
    const out = observationOut(payload)
    return { idx, role: 'obs', ts: m.ts, ms, text: '', thinking: '', calls: [], resultOf: m.callId, out, error: failed }
  }
  if (type === ERROR_MESSAGE) {
    const text = errorText(payload, details)
    return text ? { idx, role: 'error', ts: m.ts, ms: undefined, text, thinking: '', calls: [], resultOf: null, out: '', error: true } : null
  }
  // CHECKPOINT compaction and SYSTEM_MESSAGE injections are internal context
  // the terminal never renders: they produce no item.
  return { idx, role: 'hidden', ts: m.ts, ms: undefined, text: '', thinking: '', calls: [], resultOf: null, out: '', error: false }
}

export interface AgyDoc {
  file: string
  model: ModelInfo | null
  steps: AgyStep[]
  fingerprints: Map<number, string>
  results: Map<string, { out: string, error: boolean }>
}

// A conversation kept on local disk between reads: conv.db holds the main
// database (recopied only when its own identity moves) and conv.db-wal the
// WAL bytes (a matching generation ships only its grown tail, appended to
// the kept file; a restart rewrites it once). walHead is the kept WAL's
// 32-byte header for the generation compare — the WAL body stays on disk.
// refs pins the directory against cache eviction while a read is open; queue
// serializes reads of the same file — two generations can race the inflight
// dedup and interleaved copies would tear the pair.
interface SnapBase {
  dir: string
  db: string
  wal: string
  shm: string
  dbId: string | null
  walSize: number
  walHead: Buffer | null
  refs: number
  // Its pane is gone: the directory goes as soon as no read holds it.
  gone: boolean
  queue: Promise<void>
}

export function parseAgy(kept: AgyStep[], doc: AgyDoc): ChatItem[] {
  const items: ChatItem[] = []
  for (const s of kept) {
    const ref = (slot: string) => `${s.idx}:${slot}`
    if (s.role === 'user') { items.push({ role: 'user', text: s.text, ts: s.ts, ref: ref('u') }); continue }
    if (s.role === 'agent') {
      if (s.thinking) items.push({ role: 'thinking', text: s.thinking, ts: s.ts, ref: ref('h'), ...(s.ms !== undefined ? { ms: s.ms } : {}) })
      if (s.text) items.push({ role: 'assistant', text: s.text, ts: s.ts, ref: ref('a') })
      for (const [n, call] of s.calls.entries()) {
        const hit = call.id ? doc.results.get(call.id) : undefined
        items.push({
          role: 'tool', name: call.name, text: agyToolSummary(call.name, call.args), ts: s.ts, ref: ref(`t${n}`),
          ...(hit?.out ? { out: hit.out } : {}),
          ...(hit?.error ? { error: true } : {}),
        })
      }
      continue
    }
    if (s.role === 'error') items.push({ role: 'notice', name: 'error', text: s.text, ts: s.ts, ref: ref('e'), error: true })
  }
  return items
}

// Latest generation metadata: `data` field 1 holds { 19: model id,
// 21: display name }; field 3's 28 repeats the session's model id.
export function modelOf(data: Uint8Array | null | undefined): ModelInfo | null {
  const f1 = [...wireFields(data)].filter(f => f.tag === 1).pop()
  const fs = f1 ? subOf(f1) : []
  const id = textOf(fs.find(f => f.tag === 19)) || textOf(subOf(fieldOf(data, 3)).find(f => f.tag === 28))
  if (!id) return null
  return { id, label: textOf(fs.find(f => f.tag === 21)) || ompModelLabel(id) }
}

export function takeVisible(steps: AgyStep[], doc: AgyDoc, limit: number): { steps: AgyStep[], start: number, items: ChatItem[] } {
  const kept: AgyStep[] = []
  let visible = 0
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!
    kept.push(step)
    visible += parseAgy([step], doc).length
    if (visible >= limit) break
  }
  kept.reverse()
  const items = parseAgy(kept, doc)
  const start = kept.length < steps.length ? kept[0]?.idx ?? 0 : 0
  return { steps: kept, start, items }
}

export function prefixOf(doc: AgyDoc, start: number): string {
  return hash12(doc.steps.filter(s => s.idx < start).map(s => `${s.idx}.${doc.fingerprints.get(s.idx)}`).join('|'))
}

export function agyHeadOf(token: string | null | undefined) {
  const m = HEAD.exec(String(token || ''))
  return m ? { file: m[1]!, size: Number(m[2]), from: m[3] === 'null' ? null : Number(m[3]), gen: m[4]! } : null
}

export function agyAnchorOf(token: string | null | undefined) {
  const m = ANCHOR.exec(String(token || ''))
  return m ? { start: Number(m[1]), hash: m[2]! } : null
}

export function hasStep(steps: AgyStep[], idx: number): boolean {
  return idx === 0 || steps.some(s => s.idx === idx)
}

export function createAgyTranscripts({
  home, fs = localFs, now = Date.now, failQuietMs = FAIL_QUIET_MS, sqlite,
}: {
  home: string
  fs?: MachineFs
  now?: () => number
  failQuietMs?: number
  // `sqlite` injects the DatabaseSync class: `null` simulates a Node built
  // without node:sqlite (every read degrades to `unsupported`); left
  // undefined, the class is imported lazily on the first conversation read.
  sqlite?: DatabaseSyncCtor | null
}) {
  const honorEnv = fs === localFs
  const ctor = async () => {
    if (sqlite === null)
      throw Object.assign(new Error('node:sqlite is not available on this Node.js'), { code: SQLITE_UNSUPPORTED })
    return sqlite ?? await databaseSyncCtor()
  }
  const ready = async () => sqlite !== undefined ? sqlite !== null : await sqliteReady()
  const loaded = new Map<string, { gen: string, size: number, doc: AgyDoc }>()
  const lastGood = new Map<string, { file?: string, token?: string }>()
  const lastModel = new Map<string, ModelInfo | null>()
  const failAt = new Map<string, number>()
  const inflight = new Map<string, Promise<{ doc: AgyDoc, size: number, gen: string }>>()

  function remember<T>(cache: Map<string, T>, key: string, value: T, limit = 32) {
    cache.delete(key)
    cache.set(key, value)
    if (cache.size > limit) cache.delete(cache.keys().next().value!)
  }

  function pathOf(session: string): string | null {
    return conversationPath(home, session, honorEnv)
  }

  function quiet(session: string): boolean {
    const at = failAt.get(session)
    return at !== undefined && now() - at < failQuietMs
  }

  // `size` bytes of `src` (or its tail from `start`) written to `dest` as they
  // arrive, in bounded chunks: a conversation at the snapshot limit never sits
  // in memory. A short read means the file shrank under the copy — a move, to
  // be retried.
  async function copyInto(src: string, size: number, dest: string, start = 0, append = false): Promise<void> {
    const fd = openSync(dest, append ? 'a' : 'w')
    try {
      for (let pos = start; pos < size; pos += READ_CHUNK_BYTES) {
        const len = Math.min(READ_CHUNK_BYTES, size - pos)
        const chunk = await fs.read(src, pos, len)
        if (chunk.length !== len) throw moved('Incomplete Antigravity conversation read')
        writeSync(fd, chunk)
      }
    } finally { closeSync(fd) }
  }

  const bases = new Map<string, SnapBase>()

  // One base copy per file, evicted with its directory once the cache
  // overflows (DOCUMENT_CACHE_ENTRIES, like the parsed documents). The temp
  // dir is private (mkdtemp mode 0700).
  function acquireBase(file: string): SnapBase {
    let base = bases.get(file)
    if (!base) {
      const dir = mkdtempSync(path.join(tmpdir(), `${KEPT_PREFIX}${process.pid}-`))
      const db = path.join(dir, 'conv.db')
      base = { dir, db, wal: `${db}-wal`, shm: `${db}-shm`, dbId: null, walSize: 0, walHead: null, refs: 0, gone: false, queue: Promise.resolve() }
    }
    bases.delete(file)
    bases.set(file, base)
    for (const [key, older] of bases) {
      if (bases.size <= DOCUMENT_CACHE_ENTRIES) break
      if (older.refs) continue
      bases.delete(key)
      rmSync(older.dir, { recursive: true, force: true })
    }
    return base
  }

  // The pane left the state: its copy is dropped now, or as soon as the read
  // holding it lets go (a read still needs the pair on disk).
  function forgetFile(file: string): void {
    const base = bases.get(file)
    if (!base) return
    base.gone = true
    if (base.refs) return
    dropBase(file, base)
  }

  function dropBase(file: string, base: SnapBase): void {
    if (bases.get(file) === base) bases.delete(file)
    rmSync(base.dir, { recursive: true, force: true })
  }

  async function lockBase(file: string): Promise<{ base: SnapBase, unlock: () => void }> {
    const base = acquireBase(file)
    base.refs++
    const prev = base.queue
    let release = () => {}
    base.queue = new Promise<void>(resolve => { release = resolve })
    await prev
    return {
      base,
      unlock: () => {
        base.refs--
        release()
        if (base.gone && !base.refs) dropBase(file, base)
      },
    }
  }

  // Brings the kept copy to the remote state dbSt/walSt describe, then stats
  // both files again *fresh*: an identity change, another WAL header or a
  // shrink under the copy throws `moved` — the pair on disk never mixes
  // generations. A WAL that only grew ships and appends just its tail.
  async function syncBase(base: SnapBase, file: string, dbSt: FsStat, walSt: FsStat | null): Promise<void> {
    if (dbSt.size + (walSt?.size ?? 0) > MAX_SNAPSHOT_BYTES) throw new Error('Antigravity conversation exceeds the supported size limit')
    const walPath = `${file}-wal`
    try {
      if (base.dbId !== idOf(dbSt)) {
        // The copy truncates the kept file before its first chunk: until it
        // completes, the kept state must not claim the old database is there,
        // or a failure would leave the next read appending to a partial copy.
        base.dbId = null
        await copyInto(file, dbSt.size, base.db)
        base.dbId = idOf(dbSt)
      }
      const live = walSt && walSt.size > 0 ? walSt : null
      if (!live) {
        rmSync(base.wal, { force: true })
        base.walSize = 0
        base.walHead = null
      } else {
        const head = base.walSize >= WAL_HEADER_BYTES && live.size >= base.walSize
          ? await fs.read(walPath, 0, WAL_HEADER_BYTES) : null
        // A matching 32-byte header is not enough: a copy made mid-transaction
        // can hold spilled frames whose headers were rewritten in place since.
        // The kept copy's last whole frame must still read the same remotely.
        const probe = head && base.walHead && head.equals(base.walHead) ? walLastFrame(head, base.walSize) : null
        const current = !!probe && (await fs.read(walPath, probe.start, probe.len))
          .equals(localSlice(base.wal, probe.start, probe.len))
        if (current && live.size > base.walSize) {
          // A failed tail leaves the kept file where it was: the next attempt
          // appends from the same offset, never after half a chunk.
          try { await copyInto(walPath, live.size, base.wal, base.walSize, true) } catch (e) {
            truncateSync(base.wal, base.walSize)
            throw e
          }
          base.walSize = live.size
        } else if (!current || live.size !== base.walSize) {
          // No WAL yet, a shrink, a restart (another header) or a kept frame
          // rewritten in place: full copy. It truncates the kept file before
          // its first chunk, so the kept state is emptied first: a failure
          // here can only lead to another full copy, never to a tail appended
          // after the bytes the failure left behind.
          base.walSize = 0
          base.walHead = null
          await copyInto(walPath, live.size, base.wal)
          base.walSize = live.size
          base.walHead = localSlice(base.wal, 0, Math.min(WAL_HEADER_BYTES, live.size))
        }
        // Either path can end mid-frame — a frame's 24-byte header and its
        // page are separate writes — and a later rewrite starts exactly at
        // those kept bytes. Cut the kept file and size back to the last
        // whole frame so the next tail read re-ships them once complete.
        const cut = walWholeEnd(base.walHead, base.walSize) ?? Math.min(base.walSize, WAL_HEADER_BYTES)
        if (cut < base.walSize) {
          truncateSync(base.wal, cut)
          base.walSize = cut
        }
      }
    } catch (e) {
      if (isMissing(e)) throw moved('Antigravity conversation moved during the read')
      throw e
    }
    const dbNow = await fs.stat(file, { fresh: true }).catch(e => { if (isMissing(e)) return null; throw e })
    if (!dbNow?.isFile || idOf(dbNow) !== base.dbId) throw moved('Antigravity conversation changed during the read')
    const walNow = await fs.stat(walPath, { fresh: true }).catch(e => { if (isMissing(e)) return null; throw e })
    const liveNow = walNow?.isFile && walNow.size > 0 ? walNow : null
    if (!liveNow || !base.walSize) {
      if (liveNow || base.walSize) throw moved('Antigravity conversation changed during the read')
      return
    }
    // A grown WAL is fine — the kept bytes stay a consistent prefix — a
    // shrunk or restarted one is not.
    if (liveNow.size < base.walSize) throw moved('Antigravity conversation changed during the read')
    const head = await fs.read(walPath, 0, Math.min(WAL_HEADER_BYTES, liveNow.size)).catch(e => {
      if (isMissing(e)) throw moved('Antigravity conversation changed during the read')
      throw e
    })
    const expected = base.walHead!.subarray(0, Math.min(WAL_HEADER_BYTES, base.walSize))
    if (head.length < expected.length || !head.subarray(0, expected.length).equals(expected)) {
      throw moved('Antigravity conversation changed during the read')
    }
  }

  function readSteps(db: DatabaseSync, session: string, file: string): AgyDoc {
    const meta = db.prepare('SELECT trajectory_id, cascade_id FROM trajectory_meta LIMIT 1').get() as { trajectory_id?: unknown, cascade_id?: unknown } | undefined
    if (!meta || (typeof meta.cascade_id === 'string' && meta.cascade_id && meta.cascade_id !== session)) throw new Error('Unsupported Antigravity conversation format')
    const steps: AgyStep[] = []
    const rows = db.prepare('SELECT idx, step_type, status, metadata, error_details, step_payload FROM steps ORDER BY idx').all() as { idx: number, step_type: number, status: number, metadata: Uint8Array | null, error_details: Uint8Array | null, step_payload: Uint8Array | null }[]
    for (const r of rows) {
      const step = parseAgyStep(r.idx, r.step_type, r.status, r.metadata, r.step_payload, r.error_details)
      if (step) steps.push(step)
    }
    // Tool observations pair back to their calls; a call's fingerprint includes
    // its (possibly later) result, so an arriving result invalidates the pages
    // holding that call (as devinTranscripts does).
    const resultHashes = new Map<string, string>()
    const results = new Map<string, { out: string, error: boolean }>()
    for (const s of steps) {
      if (s.role !== 'obs' || !s.resultOf || results.has(s.resultOf)) continue
      results.set(s.resultOf, { out: s.out, error: s.error })
      resultHashes.set(s.resultOf, hash12(`${s.idx}:${s.out}:${s.error}`))
    }
    const fingerprints = new Map(steps.map(s => [s.idx, hash12(`${s.idx}:${s.role}:${s.text}:${s.thinking}:${s.calls.map(c => `${c.id}.${resultHashes.get(c.id) ?? ''}`).join(',')}:${s.out}:${s.error}`)]))
    let model: ModelInfo | null = null
    try {
      const g = db.prepare('SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1').get() as { data?: Uint8Array | null } | undefined
      model = modelOf(g?.data)
    } catch { /* no generation metadata table on an old conversation */ }
    return { file: path.basename(file), model, steps, fingerprints, results }
  }

  async function readDoc(file: string, session: string, dbSt: FsStat, walSt: FsStat | null, gen: string): Promise<{ doc: AgyDoc, size: number, gen: string }> {
    const size = dbSt.size + (walSt?.size ?? 0)
    const hit = loaded.get(file)
    if (hit && hit.gen === gen && hit.size === size) return { doc: hit.doc, size, gen }
    const key = `${file}|${gen}|${size}`
    const known = inflight.get(key)
    if (known) return known
    const work = (async () => {
      const Db = await ctor()
      // Local database: a plain read-only open in place, only while agy holds
      // both sidecars. node:sqlite (Node 24) creates a missing -wal and -shm
      // even for a read-only open and leaves them in agy's folder. Otherwise
      // (agy not running, or a sidecar refused) read the kept copy; remote
      // machines always take the copy path.
      if (fs === localFs && walSt && existsSync(`${file}-shm`)) {
        try {
          const db = new Db(file, { readOnly: true })
          try {
            const doc = readSteps(db, session, file)
            db.close()
            remember(loaded, file, { gen, size, doc }, DOCUMENT_CACHE_ENTRIES)
            return { doc, size, gen }
          } catch { db.close() }
        } catch { /* WAL/shm not readable in place: copy below */ }
      }
      const { base, unlock } = await lockBase(file)
      try {
        let cur = { db: dbSt, wal: walSt, size, gen }
        for (let attempt = 0; ; attempt++) {
          try {
            await syncBase(base, file, cur.db, cur.wal)
            // The shm is rebuilt from the WAL on every open.
            rmSync(base.shm, { force: true })
            const db = new Db(base.db, { readOnly: true })
            try {
              const doc = readSteps(db, session, file)
              remember(loaded, file, { gen: cur.gen, size: cur.size, doc }, DOCUMENT_CACHE_ENTRIES)
              return { doc, size: cur.size, gen: cur.gen }
            } finally { db.close() }
          } catch (e) {
            if (!isMoved(e) || attempt >= 2) throw e
            const next = await statDb(file)
            cur = { db: next.db, wal: next.wal, size: next.size, gen: next.gen }
          }
        }
      } finally { unlock() }
    })()
    inflight.set(key, work)
    try { return await work }
    finally { inflight.delete(key) }
  }

  function failOpen(session: string, e: unknown, opts: AgyOptions): never | ChatResponse {
    if (isMissing(e)) {
      lastGood.delete(session)
      lastModel.delete(session)
      failAt.delete(session)
      return { available: false, reason: 'not_found' }
    }
    if (isSqliteUnsupported(e)) return { available: false, reason: 'unsupported' }
    const good = lastGood.get(session)
    const first = !failAt.has(session)
    remember(failAt, session, now())
    if (good && opts.since === good.token && opts.before == null) return { available: true, file: good.file, session, token: good.token, unchanged: true }
    if (first) throw e
    throw new HerdrError('internal', 'Unable to read Antigravity conversation')
  }

  async function statDb(file: string) {
    const st = await fs.stat(file)
    if (!st.isFile) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    const wal = await fs.stat(`${file}-wal`).catch(e => { if (isMissing(e)) return null; throw e })
    const live = wal?.isFile ? wal : null
    return { db: st, wal: live, size: st.size + (live?.size ?? 0), gen: genOf(st, live) }
  }

  async function load(session: string): Promise<{ st: { size: number, gen: string }, file: string, doc: AgyDoc } | null> {
    const file = pathOf(session)
    if (!file) return null
    const { db, wal, gen } = await statDb(file)
    const got = await readDoc(file, session, db, wal, gen)
    return { st: { size: got.size, gen: got.gen }, file, doc: got.doc }
  }

  async function chat(pane: TranscriptPane, opts: AgyOptions = {}): Promise<ChatResponse> {
    const session = pane.agentSession
    if (!session) return { available: false, reason: 'not_found' }
    if (!(await ready())) return { available: false, reason: 'unsupported' }
    const base = { available: true as const, session }
    if (quiet(session)) {
      const good = lastGood.get(session)
      if (good && opts.since === good.token && opts.before == null) return { ...base, file: good.file, token: good.token, unchanged: true }
      throw new HerdrError('internal', 'Unable to read Antigravity conversation')
    }
    try {
      const got = await load(session)
      if (!got) return { available: false, reason: 'not_found' }
      const { st, file, doc } = got
      failAt.delete(session)
      const fileId = path.basename(file)
      const gen = st.gen
      const from = opts.from === undefined ? null : opts.from
      const prev = agyHeadOf(opts.since)
      if (!opts.before && prev && prev.file === fileId && prev.size === st.size && prev.gen === gen) {
        return { ...base, file: fileId, token: opts.since, unchanged: true as const }
      }
      const sent = opts.anchor ?? opts.since
      const at = agyAnchorOf(sent)
      const before = opts.before
      const sentHead = agyHeadOf(sent)
      let invalid = Boolean(sentHead && sentHead.file !== fileId) || (before != null && !hasStep(doc.steps, before)) || (from != null && !hasStep(doc.steps, from))
        || (from != null && Boolean(sent) && !agyHeadOf(sent))
      if (!invalid && at && (before != null || from === at.start) && prefixOf(doc, at.start) !== at.hash) invalid = true
      if (!invalid && from != null && from > 0 && prev && prev.file === fileId && st.size < prev.size) invalid = true
      if (invalid && before != null) {
        return { ...base, file: fileId, older: true as const, items: [] as ChatItem[], start: 0, rewritten: true as const }
      }
      const rewritten = invalid
      let start: number
      let items: ChatItem[]
      if (before != null) {
        const end = before === 0 ? 0 : doc.steps.findIndex(s => s.idx >= before)
        const slice = end < 0 ? doc.steps : doc.steps.slice(0, end)
        const page = takeVisible(slice, doc, PAGE_ITEMS)
        start = page.start
        items = page.items
      } else if (from != null && !rewritten) {
        const lo = from === 0 ? 0 : doc.steps.findIndex(s => s.idx >= from)
        const selected = lo < 0 ? doc.steps : doc.steps.slice(lo)
        items = parseAgy(selected, doc)
        start = selected[0] && selected.length < doc.steps.length ? selected[0].idx : 0
      } else {
        const page = takeVisible(doc.steps, doc, PAGE_ITEMS)
        start = page.start
        items = page.items
      }
      const head = `${fileId}:${st.size}:${from}:${gen}`
      const token = `${head}/${start}.${prefixOf(doc, start)}`
      const reply: ChatResponse = before != null
        ? { ...base, file: fileId, older: true, items, start, ...(rewritten ? { rewritten: true } : {}) }
        : { ...base, file: fileId, token, items, start, queue: [], ...(rewritten ? { rewritten: true } : {}) }
      if (before == null) {
        // The HTTP layer adds marks/delta fingerprints to its response object.
        remember(lastGood, session, { file: reply.file, token: reply.token })
      }
      remember(lastModel, session, doc.model)
      return reply
    } catch (e) {
      return failOpen(session, e, opts)
    }
  }

  // No served attachments: observations carry text results only.
  async function image(pane: TranscriptPane, fileId: string | null, ref: string | null, index: number): Promise<null> {
    return null
  }

  async function search(pane: TranscriptPane, text: string, deadline: number) {
    if (!pane.agentSession || Date.now() >= deadline || !(await ready())) return { hits: [], limited: Date.now() >= deadline, kind: 'agy' }
    const got = await load(pane.agentSession).catch(e => { if (isMissing(e) || isSqliteUnsupported(e)) return null; throw e })
    if (!got) return { hits: [], limited: false, kind: 'agy' }
    const hits: { role: 'user' | 'assistant', text: string, excerpt: string, ts: string | null, offset: number }[] = []
    const steps = got.doc.steps
    for (let i = steps.length - 1, scanned = 0; i >= 0; i--, scanned++) {
      if (scanned && scanned % 256 === 0) await new Promise<void>(resolve => setImmediate(resolve))
      if (Date.now() >= deadline) return { hits, limited: true, kind: 'agy' }
      const s = steps[i]!
      const user = s.role === 'user'
      const message = user || s.role === 'agent' ? s.text : ''
      if (!message) continue
      const at = matchAt(message, text)
      if (at < 0) continue
      hits.push({ role: user ? 'user' : 'assistant', text: message.slice(0, 180), excerpt: excerpt(message, at, 120, text), ts: s.ts, offset: s.idx })
      if (hits.length === 8) return { hits, limited: i > 0, kind: 'agy' }
    }
    return { hits, limited: false, kind: 'agy' }
  }

  async function model(pane: TranscriptPane): Promise<ModelInfo | null> {
    const session = pane.agentSession
    if (!session || !(await ready())) return null
    if (quiet(session)) return lastModel.get(session) ?? null
    try {
      const got = await load(session)
      if (!got) {
        lastModel.delete(session)
        return null
      }
      failAt.delete(session)
      remember(lastModel, session, got.doc.model)
      return got.doc.model
    } catch (e) {
      if (isMissing(e) || isSqliteUnsupported(e)) {
        lastModel.delete(session)
        return null
      }
      if (lastModel.has(session)) return lastModel.get(session)!
      throw e
    }
  }

  return { chat, image, search, model, pathOf, forgetFile }
}
