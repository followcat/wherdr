// Antigravity CLI (`agy`) conversations: ~/.gemini/antigravity-cli/conversations/
// <uuid>.db (SQLite, WAL mode, protobuf step payloads). The database is copied
// to a local snapshot before node:sqlite opens it — the same code path for a
// remote machine through MachineFs, and a consistent WAL view for the live,
// still-written local file. Locally the live database is tried read-only first
// and the copy is only the fallback.
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ChatItem, ChatResponse, ModelInfo } from '../../shared/types'
import type { TranscriptPane } from './transcripts'
import { excerpt, matchAt } from '../../shared/searchText'
import { ompModelLabel } from './models'
import { HerdrError } from './herdr'
import { type MachineFs, localFs } from './fsx'
import { fieldOf, isoOf, numOf, subOf, textOf, tsOf, wireFields, type WireField } from './agyProtobuf'

export interface AgyOptions { since?: string, from?: number | null, before?: number | null, anchor?: string }

const PAGE_ITEMS = 120
// Snapshot budget (database + WAL); larger sessions stay unavailable rather
// than copying hundreds of MB per poll on a small host.
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024
const READ_CHUNK_BYTES = 4 * 1024 * 1024
const MAX_TEXT = 20000
const FAIL_QUIET_MS = 1500
// A host may be a Raspberry Pi; do not retain dozens of parsed transcripts.
const DOCUMENT_CACHE_ENTRIES = 4
const hash12 = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12)
const clip = (s: unknown) => typeof s === 'string' ? s.slice(0, MAX_TEXT) : ''
// File generation: any change of the database or its WAL is another state.
const genOf = (db: { mtimeMs: number, ino?: number, size: number }, wal: { mtimeMs: number, ino?: number, size: number } | null) =>
  hash12(`${db.ino ?? 0}:${db.mtimeMs}:${db.size}:${wal ? `${wal.ino ?? 0}:${wal.mtimeMs}:${wal.size}` : '-'}`)
const HEAD = /^(.*):(\d+):(null|\d+):([0-9a-f]{12})(?=[/~#]|$)/
const ANCHOR = /\/(\d+)\.([0-9a-f]{12})(?=[~#]|$)/
const AGY_SESSION = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

// step_type values seen in conversations/<id>.db.
const USER_INPUT = 14
const PLANNER_RESPONSE = 15
const ERROR_MESSAGE = 17
const OBSERVATION = 132

function isMissing(e: unknown): boolean {
  const err = e as { code?: string, message?: string } | null
  if (!err) return false
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return true
  return err.code === 'remote' && /no such file|not a directory|introuvable/i.test(err.message || '')
}

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
interface AgyStep {
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

interface AgyDoc {
  file: string
  model: ModelInfo | null
  steps: AgyStep[]
  fingerprints: Map<number, string>
  results: Map<string, { out: string, error: boolean }>
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
function modelOf(data: Uint8Array | null | undefined): ModelInfo | null {
  const f1 = [...wireFields(data)].filter(f => f.tag === 1).pop()
  const fs = f1 ? subOf(f1) : []
  const id = textOf(fs.find(f => f.tag === 19)) || textOf(subOf(fieldOf(data, 3)).find(f => f.tag === 28))
  if (!id) return null
  return { id, label: textOf(fs.find(f => f.tag === 21)) || ompModelLabel(id) }
}

function takeVisible(steps: AgyStep[], doc: AgyDoc, limit: number): { steps: AgyStep[], start: number, items: ChatItem[] } {
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

function prefixOf(doc: AgyDoc, start: number): string {
  return hash12(doc.steps.filter(s => s.idx < start).map(s => `${s.idx}.${doc.fingerprints.get(s.idx)}`).join('|'))
}

function headOf(token: string | null | undefined) {
  const m = HEAD.exec(String(token || ''))
  return m ? { file: m[1]!, size: Number(m[2]), from: m[3] === 'null' ? null : Number(m[3]), gen: m[4]! } : null
}

function anchorOf(token: string | null | undefined) {
  const m = ANCHOR.exec(String(token || ''))
  return m ? { start: Number(m[1]), hash: m[2]! } : null
}

function hasStep(steps: AgyStep[], idx: number): boolean {
  return idx === 0 || steps.some(s => s.idx === idx)
}

export function createAgyTranscripts({
  home, fs = localFs, now = Date.now, failQuietMs = FAIL_QUIET_MS,
}: {
  home: string
  fs?: MachineFs
  now?: () => number
  failQuietMs?: number
}) {
  const honorEnv = fs === localFs
  const loaded = new Map<string, { gen: string, size: number, doc: AgyDoc }>()
  const lastGood = new Map<string, { file?: string, token?: string }>()
  const lastModel = new Map<string, ModelInfo | null>()
  const failAt = new Map<string, number>()
  const inflight = new Map<string, Promise<AgyDoc>>()

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

  // A consistent snapshot of the database on local disk: its WAL sidecars
  // come along so committed frames are visible to node:sqlite.
  async function snapshot(file: string, dbSize: number, wal: { size: number } | null): Promise<{ dir: string, db: string }> {
    if (dbSize + (wal?.size ?? 0) > MAX_SNAPSHOT_BYTES) throw new Error('Antigravity conversation exceeds the supported size limit')
    const dir = mkdtempSync(path.join(tmpdir(), 'wherdr-agy-'))
    const db = path.join(dir, 'conv.db')
    try {
      const copies: [string, string, number][] = [[file, db, dbSize]]
      if (wal) copies.push([`${file}-wal`, `${db}-wal`, wal.size])
      for (const [src, dst, size] of copies) {
        const chunks: Buffer[] = []
        for (let start = 0; start < size; start += READ_CHUNK_BYTES) {
          const len = Math.min(READ_CHUNK_BYTES, size - start)
          const chunk = await fs.read(src, start, len)
          if (chunk.length !== len) throw new Error('Incomplete Antigravity conversation read')
          chunks.push(chunk)
        }
        writeFileSync(dst, Buffer.concat(chunks, size))
      }
      return { dir, db }
    } catch (e) {
      rmSync(dir, { recursive: true, force: true })
      throw e
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

  async function readDoc(file: string, session: string, dbSize: number, walSize: number, gen: string): Promise<AgyDoc> {
    const size = dbSize + walSize
    const hit = loaded.get(file)
    if (hit && hit.gen === gen && hit.size === size) return hit.doc
    const key = `${file}|${gen}|${size}`
    const known = inflight.get(key)
    if (known) return known
    const work = (async () => {
      // Local, live database: try a plain read-only open first (each statement
      // sees a consistent WAL snapshot); fall back to a byte copy when WAL or
      // shm permissions refuse it. Remote machines always take the copy path.
      if (fs === localFs) {
        try {
          const db = new DatabaseSync(file, { readOnly: true })
          try {
            const doc = readSteps(db, session, file)
            db.close()
            remember(loaded, file, { gen, size, doc }, DOCUMENT_CACHE_ENTRIES)
            return doc
          } catch { db.close() }
        } catch { /* WAL/shm not readable in place: copy below */ }
      }
      const snap = await snapshot(file, dbSize, walSize ? { size: walSize } : null)
      try {
        const db = new DatabaseSync(snap.db, { readOnly: true })
        const doc = readSteps(db, session, file)
        db.close()
        remember(loaded, file, { gen, size, doc }, DOCUMENT_CACHE_ENTRIES)
        return doc
      } finally { rmSync(snap.dir, { recursive: true, force: true }) }
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
    return { dbSize: st.size, walSize: live?.size ?? 0, size: st.size + (live?.size ?? 0), gen: genOf(st, live) }
  }

  async function load(session: string): Promise<{ st: { size: number, gen: string }, file: string, doc: AgyDoc } | null> {
    const file = pathOf(session)
    if (!file) return null
    const { dbSize, walSize, size, gen } = await statDb(file)
    const doc = await readDoc(file, session, dbSize, walSize, gen)
    return { st: { size, gen }, file, doc }
  }

  async function exists(file: string | null) {
    if (!file) return false
    try { return (await fs.stat(file)).isFile }
    catch (e) {
      if (isMissing(e)) return false
      throw e
    }
  }

  // Last resort for a live pane whose descriptors could not be read: the
  // summaries database is trusted only when a single top-level conversation
  // claims this folder and no other agy pane on the machine does.
  async function summariesSession(pane: { cwd?: string | null, bornAt?: number | null }, competing: boolean): Promise<string | null> {
    if (competing || !pane.cwd) return null
    const file = path.join(agyCliDir(home, honorEnv), 'conversation_summaries.db')
    const cwdUri = `file://${pane.cwd.replace(/\/+$/, '')}`
    const rows: { id: string, uris: string, modified: string }[] = []
    const collect = (db: DatabaseSync) => {
      for (const r of db.prepare(`SELECT conversation_id id, workspace_uris uris, last_modified_time modified FROM conversation_summaries WHERE COALESCE(nesting_depth, 0) = 0 AND COALESCE(killed, 0) IN (0, 'false')`).all() as { id?: unknown, uris?: unknown, modified?: unknown }[]) {
        const id = String(r.id || '')
        if (AGY_SESSION.test(id)) rows.push({ id, uris: String(r.uris || ''), modified: String(r.modified || '') })
      }
    }
    try {
      const st = await fs.stat(file)
      if (!st.isFile) return null
      if (fs === localFs) {
        const db = new DatabaseSync(file, { readOnly: true })
        try { collect(db) } finally { db.close() }
      } else {
        const wal = await fs.stat(`${file}-wal`).catch(() => null)
        const snap = await snapshot(file, st.size, wal?.isFile ? wal : null)
        try {
          const db = new DatabaseSync(snap.db, { readOnly: true })
          collect(db)
          db.close()
        } finally { rmSync(snap.dir, { recursive: true, force: true }) }
      }
    } catch (e) {
      if (isMissing(e)) return null
      throw e
    }
    const matches = rows.filter(r => {
      try { return (JSON.parse(r.uris) as unknown[]).some(u => typeof u === 'string' && u.replace(/\/+$/, '') === cwdUri) } catch { return false }
    })
    if (matches.length !== 1) return null
    const m = matches[0]!
    // A conversation untouched since the pane started belongs to an older run.
    if (pane.bornAt) {
      const touched = Date.parse(m.modified.replace(' ', 'T'))
      if (Number.isFinite(touched) && touched < pane.bornAt - 120_000) return null
    }
    return await exists(conversationPath(home, m.id, honorEnv)) ? m.id : null
  }

  async function chat(pane: TranscriptPane, opts: AgyOptions = {}): Promise<ChatResponse> {
    const session = pane.agentSession
    if (!session) return { available: false, reason: 'not_found' }
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
      const prev = headOf(opts.since)
      if (!opts.before && prev && prev.file === fileId && prev.size === st.size && prev.gen === gen) {
        return { ...base, file: fileId, token: opts.since, unchanged: true as const }
      }
      const sent = opts.anchor ?? opts.since
      const at = anchorOf(sent)
      const before = opts.before
      const sentHead = headOf(sent)
      let invalid = Boolean(sentHead && sentHead.file !== fileId) || (before != null && !hasStep(doc.steps, before)) || (from != null && !hasStep(doc.steps, from))
        || (from != null && Boolean(sent) && !headOf(sent))
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
    if (!pane.agentSession || Date.now() >= deadline) return { hits: [], limited: Date.now() >= deadline, kind: 'agy' }
    const got = await load(pane.agentSession).catch(e => { if (isMissing(e)) return null; throw e })
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
    if (!session) return null
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
      if (isMissing(e)) {
        lastModel.delete(session)
        return null
      }
      if (lastModel.has(session)) return lastModel.get(session)!
      throw e
    }
  }

  return { chat, image, search, model, pathOf, summariesSession }
}
