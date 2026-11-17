// Cline CLI conversations (tested with 3.0.74). A session is two files under the
// data dir: `sessions/<id>/<id>.json` (the manifest, read for the model) and
// `sessions/<id>/<id>.messages.json`, the whole conversation rewritten on every
// update (about 1 MB after a long task). Parsing is cached on size and mtime, so
// an unchanged file is never read or parsed again; the items are cached with it
// and paged by index, with the anchor of the page's start to prove a re-read
// joins the list the client holds.
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { ChatItem, ChatResponse, ModelInfo } from '../../shared/types'
import type { TranscriptPane } from './transcripts'
import { excerpt, matchAt } from '../../shared/searchText'
import { ompModelLabel } from './models'
import { HerdrError } from './herdr'
import { type MachineFs, localFs } from './fsx'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

const PAGE_ITEMS = 120
const MAX_READ_BYTES = 24 * 1024 * 1024
// Base64 + JSON framing must remain below coreCall's 16 MiB reply limit.
const READ_CHUNK_BYTES = 4 * 1024 * 1024
const MAX_TEXT = 20000
const FAIL_QUIET_MS = 1500
// A host may be a Raspberry Pi; do not retain dozens of parsed conversations.
const DOCUMENT_CACHE_ENTRIES = 4
const hash12 = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12)
const clip = (s: unknown) => (typeof s === 'string' ? s.slice(0, MAX_TEXT) : '')
const genOf = (st: { mtimeMs: number, ino?: number }) => `${st.ino ? `${st.ino}-` : ''}${Math.round(st.mtimeMs * 1000)}`
// `<file>:<size>:<from>:<gen>[/<start>.<prefix hash>]`
const HEAD = /^(.*):(\d+):(null|\d+):(\d+(?:-\d+)?)(?=[/~#]|$)/
const ANCHOR = /\/(\d+)\.([0-9a-f]{12})(?=[~#]|$)/

function isMissing(e: unknown): boolean {
  const err = e as { code?: string, message?: string } | null
  if (!err) return false
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return true
  return err.code === 'remote' && /no such file|not a directory|introuvable/i.test(err.message || '')
}

function blocksOf(message: Json): Json[] {
  return Array.isArray(message?.content) ? message.content.filter((b: unknown) => b && typeof b === 'object') as Json[] : []
}

const isoOf = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value === 'string' && value) {
    const at = Date.parse(value)
    return Number.isFinite(at) ? new Date(at).toISOString() : null
  }
  return null
}

// The user's text as typed: Cline wraps it as
// `<user_input mode="act">…</user_input>`.
export function clineUserText(text: string): string {
  const m = /^\s*<user_input(?:\s[^>]*)?>([\s\S]*)<\/user_input>\s*$/.exec(String(text || ''))
  return m ? m[1]! : String(text || '')
}

const shorten = (p: string, home: string) => (home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p)
const firstLine = (s: string) => String(s || '').split('\n')[0]!.trim()
const textOf = (v: unknown): string => (typeof v === 'string' ? v : '')

// Target of a tool call: the command, the files, the path, the query…
export function clineToolSummary(input: Json, home = ''): string {
  const a = input && typeof input === 'object' ? input : {}
  if (Array.isArray(a.commands)) {
    const list = a.commands.map((c: unknown) => firstLine(textOf(c))).filter(Boolean)
    if (list.length) return list.join(' ; ')
  }
  if (Array.isArray(a.files)) {
    const list = a.files.filter((f: Json) => f && typeof f.path === 'string').map((f: Json) => {
      const range = typeof f.start_line === 'number' || typeof f.end_line === 'number'
        ? `:${f.start_line ?? 1}-${f.end_line ?? ''}` : ''
      return `${shorten(f.path, home)}${range}`
    })
    if (list.length) return list.join(', ')
  }
  if (Array.isArray(a.queries)) {
    const list = a.queries.map((q: unknown) => firstLine(textOf(typeof q === 'string' ? q : (q as Json)?.query))).filter(Boolean)
    if (list.length) return list.join(' ; ')
  }
  if (Array.isArray(a.requests)) {
    const url = a.requests.map((r: Json) => textOf(r?.url)).find(Boolean)
    if (url) return url
  }
  for (const key of ['command', 'path', 'file_path', 'query', 'pattern', 'url', 'question', 'skill']) {
    if (typeof a[key] === 'string' && a[key].trim()) return key === 'path' || key === 'file_path' ? shorten(a[key], home) : firstLine(a[key])
  }
  if (typeof a.args === 'string' && a.args.trim()) return firstLine(a.args)
  return firstLine(Object.values(a).find(v => typeof v === 'string') || '')
}

export interface ClineToolResult { text: string, error: boolean }

const asObject = (value: unknown): Json | null => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Json
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch { return null }
  }
  return null
}

// A tool result's content: per-item `{query, result, error, success}` lists
// (run_commands, read_files…), a JSON string carrying the same shape, or the
// plain text of a denied call.
export function clineToolResult(content: unknown): ClineToolResult {
  if (typeof content === 'string') {
    const obj = asObject(content)
    if (obj) {
      const error = textOf(obj.error)
      return { text: clip(textOf(obj.result) || error), error: Boolean(error) || obj.success === false }
    }
    return { text: clip(content), error: false }
  }
  if (Array.isArray(content)) {
    const parts = content.map(clineToolResult).filter(p => p.text || p.error)
    return { text: parts.map(p => p.text).filter(Boolean).join('\n'), error: parts.some(p => p.error) }
  }
  const obj = asObject(content)
  if (!obj) return { text: '', error: false }
  const error = textOf(obj.error)
  return { text: clip(textOf(obj.result) || error), error: Boolean(error) || obj.success === false }
}

export interface ClineDoc {
  file: string
  session: string
  updatedAt: string | null
  messages: Json[]
}

// Items of the conversation: user texts as typed, thinking, replies and the
// tool calls with their results paired back. A call with no result that is not
// the file's last message was cancelled before it ran (a hook, the guard): it
// shows as failed, as does a call the user denied (`is_error`, whose content
// carries the rejection).
export function parseCline(doc: ClineDoc, home = ''): ChatItem[] {
  const results = new Map<string, ClineToolResult>()
  for (const message of doc.messages) {
    for (const block of blocksOf(message)) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const result = clineToolResult(block.content)
      if (block.is_error === true) result.error = true
      results.set(block.tool_use_id, result)
    }
  }
  const items: ChatItem[] = []
  const last = doc.messages.length - 1
  doc.messages.forEach((message, mi) => {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) return
    const ts = isoOf(message.ts)
    const blocks = blocksOf(message)
    if (message.role === 'user') {
      const texts = blocks.filter(b => b.type === 'text' && typeof b.text === 'string')
        .map(b => clineUserText(b.text)).filter(t => t.trim())
      if (texts.length) items.push({ role: 'user', text: clip(texts.join('\n')), ts, ref: `m${mi}:u` })
      return
    }
    blocks.forEach((block, bi) => {
      if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        items.push({ role: 'thinking', text: clip(block.thinking), ts, ref: `m${mi}:k${bi}` })
        return
      }
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        items.push({ role: 'assistant', text: clip(block.text), ts, ref: `m${mi}:a${bi}` })
        return
      }
      if (block.type !== 'tool_use' || typeof block.name !== 'string') return
      const result = typeof block.id === 'string' ? results.get(block.id) : undefined
      const cancelled = !result && mi < last
      const name = block.name
      items.push({
        role: 'tool', name, text: clip(clineToolSummary(block.input || {}, home) || name), ts, ref: `m${mi}:t${bi}`,
        ...(result?.text ? { out: result.text } : {}),
        ...(result?.error || cancelled ? { error: true } : {}),
      })
    })
  })
  return items
}

function headOf(token: string | null | undefined) {
  const m = HEAD.exec(String(token || ''))
  if (!m) return null
  return { file: m[1]!, size: Number(m[2]), from: m[3] === 'null' ? null : Number(m[3]), gen: m[4]! }
}

function anchorOf(token: string | null | undefined) {
  const m = ANCHOR.exec(String(token || ''))
  return m ? { start: Number(m[1]), hash: m[2]! } : null
}

// Fingerprint of the items above `start`: a re-read from `start` proves it
// joins the list the client holds instead of splicing another conversation's
// bottom under its pages. Per-item fingerprints are computed once per
// generation (readDoc), so a poll hashes a few KB, never the whole conversation.
const prefixOf = (prints: string[], start: number) =>
  hash12(prints.slice(0, Math.max(0, Math.min(start, prints.length))).join('|'))

export interface ClineOptions { since?: string, from?: number | null, before?: number | null, anchor?: string }

function normalize(raw: Json, file: string, session: string): ClineDoc {
  if (!Array.isArray(raw.messages) || (typeof raw.sessionId === 'string' && raw.sessionId !== session))
    throw new Error('Unsupported Cline conversation format')
  return {
    file, session,
    updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : null,
    messages: raw.messages.filter((m: unknown) => m && typeof m === 'object') as Json[],
  }
}

export function createClineTranscripts({
  home, fs = localFs, now = Date.now, failQuietMs = FAIL_QUIET_MS,
}: {
  home: string
  fs?: MachineFs
  now?: () => number
  failQuietMs?: number
}) {
  // Size and generation of the file the parsed conversation came from: an
  // unchanged file is never read or parsed again. `prints` are the items'
  // fingerprints, for the page anchor.
  const loaded = new Map<string, { gen: string, size: number, items: ChatItem[], prints: string[] }>()
  const manifests = new Map<string, { gen: string, size: number, model: string | null }>()
  const lastGood = new Map<string, { file?: string, token?: string }>()
  const lastModel = new Map<string, ModelInfo | null>()
  const failAt = new Map<string, number>()

  function remember<T>(cache: Map<string, T>, key: string, value: T, limit = 32) {
    cache.delete(key)
    cache.set(key, value)
    while (cache.size > limit) cache.delete(cache.keys().next().value!)
  }

  function quiet(session: string): boolean {
    const at = failAt.get(session)
    return at !== undefined && now() - at < failQuietMs
  }

  async function readDoc(file: string, session: string): Promise<{ st: Awaited<ReturnType<MachineFs['stat']>>, items: ChatItem[], prints: string[] }> {
    const st = await fs.stat(file)
    if (!st.isFile) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    const gen = genOf(st)
    const hit = loaded.get(file)
    if (hit && hit.gen === gen && hit.size === st.size) return { st, items: hit.items, prints: hit.prints }
    if (st.size > MAX_READ_BYTES) throw new Error('Cline conversation exceeds the supported size limit')
    const chunks: Buffer[] = []
    for (let start = 0; start < st.size; start += READ_CHUNK_BYTES) {
      const len = Math.min(READ_CHUNK_BYTES, st.size - start)
      const chunk = await fs.read(file, start, len)
      if (chunk.length !== len) throw new Error('Incomplete Cline conversation read')
      chunks.push(chunk)
    }
    let raw: Json
    try { raw = JSON.parse(Buffer.concat(chunks, st.size).toString('utf8')) }
    catch { throw new Error('Unsupported Cline conversation format') }
    const items = parseCline(normalize(raw, path.basename(file), session), home)
    const prints = items.map(item => hash12(JSON.stringify(item)))
    remember(loaded, file, { gen, size: st.size, items, prints }, DOCUMENT_CACHE_ENTRIES)
    return { st, items, prints }
  }

  function failOpen(session: string, e: unknown, opts: ClineOptions): never | ChatResponse {
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
    throw new HerdrError('internal', 'Unable to read Cline conversation')
  }

  async function chat(pane: TranscriptPane, file: string, opts: ClineOptions = {}): Promise<ChatResponse> {
    const session = pane.agentSession
    if (!session || !file) return { available: false, reason: 'not_found' }
    const base = { available: true as const, session }
    if (quiet(session)) {
      const good = lastGood.get(session)
      if (good && opts.since === good.token && opts.before == null) return { ...base, file: good.file, token: good.token, unchanged: true }
      throw new HerdrError('internal', 'Unable to read Cline conversation')
    }
    try {
      const { st, items, prints } = await readDoc(file, session)
      failAt.delete(session)
      const fileId = path.basename(file)
      const gen = genOf(st)
      const from = opts.from === undefined ? null : opts.from
      const head = `${fileId}:${st.size}:${from}:${gen}`
      const prev = headOf(opts.since)
      // `from` is the client's cursor, not part of the file's state: a poll
      // that now carries it (its first reply set the cursor) still sees the
      // same file unchanged.
      if (opts.before == null && prev && prev.file === fileId && prev.size === st.size && prev.gen === gen)
        return { ...base, file: fileId, token: opts.since, unchanged: true }
      const sent = opts.anchor ?? opts.since
      const at = anchorOf(sent)
      const before = opts.before ?? null
      const sentHead = headOf(sent)
      let invalid = Boolean(sentHead && sentHead.file !== fileId)
        || (before !== null && before > items.length) || (from !== null && from > items.length)
      // The bytes are this file's, so the anchor must name the same list above
      // the cursor: another bottom is another conversation's.
      if (!invalid && at && (before !== null || from === at.start) && prefixOf(prints, at.start) !== at.hash) invalid = true
      if (before !== null) {
        if (invalid) return { ...base, file: fileId, older: true, items: [], start: 0, rewritten: true }
        const end = Math.max(0, Math.min(before, items.length))
        const start = Math.max(0, end - PAGE_ITEMS)
        return { ...base, file: fileId, older: true, items: items.slice(start, end), start }
      }
      let start: number
      let page: ChatItem[]
      const rewritten = invalid && (from !== null || Boolean(sent))
      if (from !== null && !rewritten) {
        start = Math.max(0, Math.min(from, items.length))
        page = items.slice(start)
      } else {
        start = Math.max(0, items.length - PAGE_ITEMS)
        page = items.slice(start)
      }
      const token = `${head}/${start}.${prefixOf(prints, start)}`
      const reply: ChatResponse = { ...base, file: fileId, token, items: page, start, queue: [], ...(rewritten ? { rewritten: true } : {}) }
      remember(lastGood, session, { file: reply.file, token })
      return reply
    } catch (e) {
      return failOpen(session, e, opts)
    }
  }

  // The model the session runs: the manifest's `model` (the messages file does
  // not carry it). Cached on its own size and mtime.
  async function modelName(file: string): Promise<string | null> {
    const manifest = file.replace(/\.messages\.json$/, '.json')
    if (manifest === file) return null
    const st = await fs.stat(manifest)
    const gen = genOf(st)
    const hit = manifests.get(manifest)
    if (hit && hit.gen === gen && hit.size === st.size) return hit.model
    let model: string | null = null
    try {
      const raw = JSON.parse(await fs.readFile(manifest))
      model = raw && typeof raw.model === 'string' && raw.model ? raw.model : null
    } catch (e) {
      if (isMissing(e)) throw e
      model = null
    }
    remember(manifests, manifest, { gen, size: st.size, model })
    return model
  }

  async function model(pane: TranscriptPane, file: string): Promise<ModelInfo | null> {
    const session = pane.agentSession
    if (!session || !file) return null
    if (quiet(session)) return lastModel.get(session) ?? null
    try {
      const name = await modelName(file)
      const info = name ? { id: name, label: ompModelLabel(name) } : null
      remember(lastModel, session, info)
      return info
    } catch (e) {
      if (isMissing(e)) {
        lastModel.delete(session)
        return null
      }
      if (lastModel.has(session)) return lastModel.get(session)!
      throw e
    }
  }

  async function search(pane: TranscriptPane, file: string, text: string, deadline: number) {
    if (!pane.agentSession || !file || Date.now() >= deadline) return { hits: [], limited: Date.now() >= deadline, kind: 'cline' }
    let items: ChatItem[]
    try { ({ items } = await readDoc(file, pane.agentSession)) }
    catch (e) { if (isMissing(e)) return { hits: [], limited: false, kind: 'cline' }; throw e }
    const hits: { role: 'user' | 'assistant', text: string, excerpt: string, ts: string | null, offset: number }[] = []
    for (let i = items.length - 1, scanned = 0; i >= 0; i--, scanned++) {
      if (scanned && scanned % 256 === 0) await new Promise<void>(resolve => setImmediate(resolve))
      if (Date.now() >= deadline) return { hits, limited: true, kind: 'cline' }
      const item = items[i]!
      if (item.role !== 'user' && item.role !== 'assistant') continue
      const at = matchAt(item.text, text)
      if (at < 0) continue
      hits.push({ role: item.role, text: item.text.slice(0, 180), excerpt: excerpt(item.text, at, 120, text), ts: item.ts, offset: i })
      if (hits.length === 8) return { hits, limited: i > 0, kind: 'cline' }
    }
    return { hits, limited: false, kind: 'cline' }
  }

  return { chat, model, search }
}

export type ClineTranscripts = ReturnType<typeof createClineTranscripts>



