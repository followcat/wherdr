import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { OPENCODE_READ } from './opencodeTransport'
import { boundedOutput, type ShellExec } from './fsx'
import type { ChatCursor, ChatItem, ChatResponse, ConversationHit, ModelInfo } from '../../shared/types'
import type { TranscriptPane } from './transcripts'
import { excerpt, matchAt } from '../../shared/searchText'
import { cleanModelName } from './models'

// The native API is independently versioned. Keep its untrusted JSON at this boundary.
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Stream = (script: string, args: string[]) => ChildProcessWithoutNullStreams | null
interface Cursor { file: string, kind: 'tail' | 'page', value: string }
interface Snapshot { file: string, server: string, info: Json, inbox?: Json[], pages: Map<string, { data: Json, at: number, bytes: number }>, bytes: number, at: number, epoch: number }
export interface OpenCodeOptions { since?: string, from?: ChatCursor | null, before?: ChatCursor | null, anchor?: string }
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24)
const clip = (s: unknown) => typeof s === 'string' ? s.slice(0, 20000) : ''
const ascii = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
const tsOf = (m: Json) => Number.isFinite(m.time?.created) && Math.abs(m.time.created) <= 8.64e15 ? new Date(m.time.created).toISOString() : null
// User attachments count as images when they carry inline data or a local
// file:/data: URI — the transport resolves session-referenced URIs only.
const imageFiles = (files: unknown): Json[] => Array.isArray(files) ? files.filter(f => /^image\/(png|jpeg|gif|webp|avif)$/.test(f?.mime) && (typeof f.data === 'string' || typeof f.uri === 'string')) : []
const toolImages = (content: unknown): Json[] => Array.isArray(content) ? content.filter(f => f?.type === 'file' && /^image\/(png|jpeg|gif|webp|avif)$/.test(f.mime) && /^(?:file:|data:image\/)/.test(f.uri)) : []
const toolText = (content: unknown) => typeof content === 'string' ? clip(content) : Array.isArray(content)
  ? content.filter(p => p?.type === 'text').map(p => clip(p.text)).join('\n').slice(0, 20000) : ''

export function parseOpenCode(messages: Json[]): ChatItem[] {
  return messages.flatMap(m => {
    if (typeof m.id !== 'string') return []
    const ts = tsOf(m)
    const ref = (slot: string) => `oc:${m.id}:${slot}`
    if (m.type === 'user') {
      const images = imageFiles(m.files).length
      return m.text || images ? [{ role: 'user', text: clip(m.text), ts, ref: ref('u'), ...(images ? { images } : {}) } as ChatItem] : []
    }
    // A shell message is the same "!" run Claude renders as a bash card —
    // the role also lets a sent "! cmd" land on it (see queued.ts landed).
    if (m.type === 'shell') return [{ role: 'bash', text: clip(m.command), out: clip(m.output?.output), ts, ref: ref('s'), ...(m.exit || m.status === 'timeout' ? { error: true } : {}) } as ChatItem]
    if (m.type !== 'assistant') return []
    const items: ChatItem[] = []
    for (const [index, part] of (Array.isArray(m.content) ? m.content : []).entries()) {
      if ((part.type === 'text' || part.type === 'reasoning') && part.text) items.push({ role: part.type === 'text' ? 'assistant' : 'thinking', text: clip(part.text), ts, ref: ref(`p${index}`) })
      if (part.type === 'tool' && typeof part.id === 'string') {
        const input = part.state?.input || {}
        const summary = typeof input === 'string' ? input : input.command || input.file_path || input.path || input.query || input.pattern || input.description || input.prompt || input.url || part.name
        const output = toolText(part.state?.content) || clip(part.state?.error?.message)
        items.push({ role: 'tool', name: clip(part.name), text: clip(summary), ts, ref: ref(`t${part.id}`),
          toolStatus: ['streaming', 'running', 'completed', 'error'].includes(part.state?.status) ? part.state.status : undefined,
          ...(toolImages(part.state?.content).length ? { images: toolImages(part.state.content).length } : {}),
          ...(output ? { out: output } : {}),
          ...(part.state?.status === 'error' ? { error: true } : {}),
          ...(Number.isFinite(part.time?.completed) && Number.isFinite(part.time?.created) ? { ms: part.time.completed - part.time.created } : {}) })
      }
    }
    if (m.error?.message) items.push({ role: 'assistant', text: clip(m.error.message), ts, error: true, ref: ref('error') })
    return items
  })
}

export function createOpenCodeTranscripts({ home, exec, stream }: { home: string, exec?: ShellExec, stream?: Stream }) {
  const secret = randomBytes(32)
  const cursors = new Map<string, Cursor>()
  const cache = new Map<string, Snapshot>()
  const pending = new Map<string, Promise<Json>>()
  let epoch = 0
  let pageBytes = 0
  let child: ChildProcessWithoutNullStreams | null = null
  let retryAt = 0
  let failures = 0
  let disposed = false
  let streamBuffer = ''
  // Invalidation must reach the carried pages too, or an SSE event would be
  // masked by a page still inside its own freshness window.
  const invalidate = (reset = false) => {
    for (const s of cache.values()) { s.at = 0; for (const p of s.pages.values()) p.at = 0 }
    if (reset) epoch++
  }
  function dispose() { disposed = true; child?.kill(); child = null; cache.clear(); pageBytes = 0; cursors.clear() }
  function cursor(file: string, kind: Cursor['kind'], value: string): string {
    const key = 'oc_' + createHmac('sha256', secret).update(JSON.stringify([file, kind, value])).digest('base64url').slice(0, 32)
    cursors.set(key, { file, kind, value })
    if (cursors.size > 4096) cursors.delete(cursors.keys().next().value!)
    return key
  }
  function startStream() {
    if (child || disposed || Date.now() < retryAt) return
    const args = [OPENCODE_READ, home, ascii({ stream: true })]
    child = stream ? stream('python3 -u -X utf8 -c "$1" "$2" "$3"', args) : exec ? null
      : spawn('python3', ['-u', '-X', 'utf8', '-c', ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    if (!child) return
    const current = child
    let ready = false
    streamBuffer = ''
    current.stdin.end()
    current.stdout.on('data', (b: Buffer) => {
      streamBuffer += b.toString('utf8')
      if (streamBuffer.length > 131072) { current.kill(); streamBuffer = ''; return }
      let end
      while ((end = streamBuffer.indexOf('\n')) >= 0) {
        const line = streamBuffer.slice(0, end); streamBuffer = streamBuffer.slice(end + 1)
        try {
          const event = JSON.parse(line)
          if (event.ready) { ready = true; failures = 0 }
          if (event.ready || event.changed) invalidate(Boolean(event.reset))
        } catch { invalidate() }
      }
    })
    const closed = () => {
      if (child !== current) return
      child = null
      retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(failures++, 5))
      invalidate(ready)
    }
    current.on('error', closed); current.on('close', closed)
    // Consume diagnostics without forwarding machine credentials or HTTP errors.
    current.stderr.resume()
  }
  async function query(session: string, op: string, options: Json = {}): Promise<Json> {
    const request = { session, op, ...options }
    const key = JSON.stringify(request)
    const known = pending.get(key)
    if (known) return known
    const work = (async () => {
      let body: Buffer
      if (exec) {
        const r = await exec('python3 -X utf8 -c "$1" "$2" "$3"', [OPENCODE_READ, home, ascii(request)], { timeoutMs: Math.min(300000, (options.seconds || 10) * 1000 + 1000), maxBytes: 25 * 1024 * 1024 })
        body = r.stdout
        if (r.code !== 0 && !body.length) throw new Error('Unable to read OpenCode conversation on the remote machine')
      } else body = await new Promise<Buffer>((resolve, reject) => {
        const process = spawn('python3', ['-X', 'utf8', '-c', OPENCODE_READ, home, ascii(request)], { stdio: ['pipe', 'pipe', 'pipe'] })
        process.stdin.end(); process.stderr.resume()
        const out = boundedOutput(25 * 1024 * 1024)
        const timer = setTimeout(() => process.kill(), Math.min(15000, (options.seconds || 10) * 1000 + 1000))
        process.stdout.on('data', (b: Buffer) => { if (!out.push(b)) process.kill() })
        process.on('error', () => { clearTimeout(timer); reject(new Error('Python 3 is required to read OpenCode conversations')) })
        process.on('close', () => { clearTimeout(timer); if (out.over) reject(new Error('OpenCode conversation exceeded its read limit')); else resolve(out.take()) })
      })
      let r: Json
      try { r = JSON.parse(body.toString('utf8')) } catch { throw new Error('Unable to read OpenCode conversation') }
      if (r.error) throw new Error(r.error)
      return r
    })()
    pending.set(key, work)
    try { return await work } finally { pending.delete(key) }
  }
  async function snapshot(session: string, seconds?: number): Promise<Snapshot | null> {
    startStream()
    const known = cache.get(session)
    // SSE only invalidates. A short revalidation interval also recovers missed events.
    if (known && known.epoch === epoch && Date.now() - known.at < 800) return known
    const r = await query(session, 'session', { seconds })
    if (r.status === 404) { pageBytes -= cache.get(session)?.bytes || 0; cache.delete(session); return null }
    if (r.status !== 200 || r.data?.data?.id !== session) throw new Error('Unable to read OpenCode session')
    const info = r.data.data
    const file = 'opencode-' + hash(JSON.stringify([r.server, session, info.revert || null, epoch]))
    // An unchanged file identity means the pages fetched under it are still
    // the same address space: carry them over (each keeps its own freshness
    // window in page()) instead of dropping the whole map every 800 ms —
    // over SSH every refetch is another shim process.
    const prev = cache.get(session)
    const carried = prev && prev.file === file && prev.epoch === epoch
    const s: Snapshot = { file, info, server: r.server,
      // null/absent means the inbox read itself failed — never carried from a
      // previous snapshot: "unknown" is honest, a stale list is not.
      inbox: Array.isArray(r.data?.inbox) ? r.data.inbox : undefined,
      pages: carried ? prev!.pages : new Map(), bytes: carried ? prev!.bytes : 0, at: Date.now(), epoch }
    if (!carried) pageBytes -= prev?.bytes || 0
    cache.set(session, s)
    if (cache.size > 32) { const id = cache.keys().next().value!; pageBytes -= cache.get(id)!.bytes; cache.delete(id) }
    return s
  }
  async function page(session: string, s: Snapshot, native = '', seconds?: number): Promise<Json> {
    // A cached page is good for the same window the snapshot revalidation
    // uses — identical staleness bound to the old drop-and-refetch, minus
    // the refetch.
    const known = s.pages.get(native)
    if (known && Date.now() - known.at < 800) return known.data
    if (known) { s.pages.delete(native); s.bytes -= known.bytes; pageBytes -= known.bytes }
    const r = await query(session, 'page', { cursor: native, seconds })
    if (r.server !== s.server || r.status === 400 || r.status === 404) return { invalid: true }
    if (r.status !== 200 || !Array.isArray(r.data?.data) || !r.data?.cursor) throw new Error('Unable to read OpenCode messages')
    const bytes = Buffer.byteLength(JSON.stringify(r.data))
    if (cache.get(session) === s && !s.pages.has(native) && pageBytes + bytes <= 16 * 1024 * 1024) {
      s.pages.set(native, { data: r.data, at: Date.now(), bytes }); s.bytes += bytes; pageBytes += bytes
    }
    return r.data
  }
  async function chat(pane: TranscriptPane, opts: OpenCodeOptions = {}): Promise<ChatResponse> {
    const session = pane.agentSession
    if (!session) return { available: false, reason: 'not_found' }
    const s = await snapshot(session)
    if (!s) return { available: false, reason: 'not_found' }
    const base = { available: true, file: s.file, session }
    if (opts.before != null) {
      const c = typeof opts.before === 'string' ? cursors.get(opts.before) : null
      if (!c || c.file !== s.file || c.kind !== 'page') return { ...base, older: true, rewritten: true, items: [], olderCursor: null }
      const r = await page(session, s, c.value)
      if (r.invalid) return { ...base, older: true, rewritten: true, items: [], olderCursor: null }
      return { ...base, older: true, items: parseOpenCode([...r.data].reverse()), olderCursor: r.cursor.next ? cursor(s.file, 'page', r.cursor.next) : null }
    }
    const c = typeof opts.from === 'string' ? cursors.get(opts.from) : null
    const valid = c?.file === s.file && c.kind === 'tail'
    let r = await page(session, s)
    if (r.invalid) throw new Error('OpenCode session changed while reading; try again')
    const initial = r
    let messages: Json[] = [...r.data]
    // Follow native pages to the old tail anchor. Bound growth; if the anchor
    // vanished after a revert/compaction, replace the tail rather than joining it.
    let bytes = Buffer.byteLength(JSON.stringify(messages))
    for (let n = 0; valid && !messages.some(m => m.id === c.value) && r.cursor.next && n < 11 && bytes < 24 * 1024 * 1024; n++) {
      r = await page(session, s, r.cursor.next)
      if (r.invalid) break
      messages.push(...r.data)
      bytes += Buffer.byteLength(JSON.stringify(r.data))
    }
    const at = valid ? messages.findIndex(m => m.id === c.value) : -1
    const rewritten = opts.from != null && (!valid || at < 0)
    if (at >= 0) messages = messages.slice(0, at + 1)
    else messages = [...initial.data]
    messages.reverse()
    const start = valid && at >= 0 ? opts.from! : cursor(s.file, 'tail', messages[0]?.id || '')
    const items = parseOpenCode(messages)
    // The session inbox is the real queue: user entries still waiting to be
    // delivered (typed on the computer, or sent while it works). A failed
    // inbox read omits the queue key entirely — unknown, not "no queue".
    const inbox = Array.isArray(s.inbox) ? s.inbox.filter(i => i?.type === 'user' && typeof i?.payload?.text === 'string') : null
    const queue = inbox?.map(i => ({ text: clip(i.payload.text), ts: tsOf(i), ...(imageFiles(i.payload?.files).length ? { images: imageFiles(i.payload.files).length } : {}) }))
    const token = `opencode:${s.file}:${hash(JSON.stringify([start, items, s.info.model, inbox?.map(i => i.id) ?? null]))}`
    const olderCursor = initial.cursor.next ? cursor(s.file, 'page', initial.cursor.next) : null
    if (!rewritten && token === opts.since) return { ...base, token, unchanged: true }
    return { ...base, token, start, olderCursor, items, ...(queue ? { queue } : {}), ...(rewritten ? { rewritten: true } : {}) }
  }
  async function model(pane: TranscriptPane): Promise<ModelInfo | null> {
    if (!pane.agentSession) return null
    const s = await snapshot(pane.agentSession)
    const m = s?.info.model
    return typeof m?.id === 'string' ? { id: m.id, label: cleanModelName(m.id), ...(m.variant ? { effort: m.variant } : {}) } : null
  }
  async function image(pane: TranscriptPane, file: string | null, ref: string | null, index: number): Promise<{ type: string, body: Buffer } | null> {
    const m = /^oc:([^:]+):(u|t.+)$/.exec(ref || '')
    if (!pane.agentSession || !m || !Number.isSafeInteger(index) || index < 0) return null
    const s = await snapshot(pane.agentSession)
    if (!s || s.file !== file) return null
    const r = await query(pane.agentSession, 'image', { message: m[1], slot: m[2], index })
    if (r.server !== s.server || r.status !== 200) return null
    const img = r.data?.image
    if (!img || !/^image\/(png|jpeg|gif|webp|avif)$/.test(img.mime) || typeof img.data !== 'string' || img.data.length > 24 * 1024 * 1024) return null
    return { type: img.mime, body: Buffer.from(img.data, 'base64') }
  }
  async function search(pane: TranscriptPane, text: string, deadline: number) {
    const hits: Omit<ConversationHit, 'pane' | 'agent' | 'title'>[] = []
    const session = pane.agentSession
    if (!session) return { hits, limited: false, kind: 'opencode' }
    if (Date.now() >= deadline) return { hits, limited: true, kind: 'opencode' }
    const s = await snapshot(session, (deadline - Date.now()) / 1000)
    if (!s) return { hits, limited: false, kind: 'opencode' }
    let native = ''
    let bytes = 0
    for (let n = 0; n < 40 && Date.now() < deadline && bytes < 8 * 1024 * 1024; n++) {
      const r = await page(session, s, native, (deadline - Date.now()) / 1000)
      if (r.invalid) return { hits: [], limited: true, kind: 'opencode' }
      bytes += Buffer.byteLength(JSON.stringify(r.data))
      for (const i of parseOpenCode(r.data)) if (i.role === 'user' || i.role === 'assistant') {
        const at = matchAt(i.text, text)
        if (at >= 0) hits.push({ role: i.role, text: i.text.slice(0, 180), excerpt: excerpt(i.text, at, 120, text), ts: i.ts, offset: i.ref!, ref: i.ref })
        if (hits.length >= 8) return { hits, limited: true, kind: 'opencode' }
      }
      native = r.cursor.next || ''
      if (!native) return { hits, limited: false, kind: 'opencode' }
    }
    return { hits, limited: Boolean(native), kind: 'opencode' }
  }
  // The model catalog (/api/model) — display names, ids, providers, variants.
  async function models(pane: TranscriptPane): Promise<Json[]> {
    const s = pane.agentSession ? await snapshot(pane.agentSession) : null
    const r = await query(pane.agentSession || 'x', 'models')
    if (s && r.server !== s.server) return []
    if (r.status !== 200 || !Array.isArray(r.data?.data)) return []
    return r.data.data
  }
  // Whitelisted write: PATCH /api/session/<id> {model} — verified by
  // the transport's re-GET, which is the data returned here.
  async function patchModel(pane: TranscriptPane, model: { id: string, providerID: string, variant?: string }): Promise<Json | null> {
    if (!pane.agentSession) return null
    const s = await snapshot(pane.agentSession)
    if (!s) return null
    const r = await query(pane.agentSession, 'model', { model })
    if (r.server !== s.server || r.status !== 200) return null
    return r.data?.data ?? null
  }
  // Pending permission requests and unanswered forms (the native API owns
  // the same dialogs the TUI draws — answering here resolves both).
  async function pendingRequests(pane: TranscriptPane): Promise<{ permissions: Json[], forms: Json[] }> {
    const empty = { permissions: [] as Json[], forms: [] as Json[] }
    if (!pane.agentSession) return empty
    const s = await snapshot(pane.agentSession)
    if (!s) return empty
    const r = await query(pane.agentSession, 'pending')
    if (r.server !== s.server || r.status !== 200) return empty
    return {
      permissions: Array.isArray(r.data?.permissions) ? r.data.permissions : [],
      forms: Array.isArray(r.data?.forms) ? r.data.forms : [],
    }
  }
  // A reply is only confirmed by the request leaving the pending list.
  async function replyPermission(pane: TranscriptPane, requestID: string, decision: string, message?: string): Promise<boolean> {
    if (!pane.agentSession) return false
    const s = await snapshot(pane.agentSession)
    if (!s) return false
    const r = await query(pane.agentSession, 'reply', { request: requestID, decision, ...(message ? { message } : {}) })
    if (r.server !== s.server || r.status !== 200) return false
    return !Array.isArray(r.data?.pending) || !r.data.pending.some((x: Json) => x?.id === requestID)
  }
  async function replyForm(pane: TranscriptPane, formID: string, key: string, value: unknown): Promise<boolean> {
    if (!pane.agentSession) return false
    const s = await snapshot(pane.agentSession)
    if (!s) return false
    const r = await query(pane.agentSession, 'form_reply', { form: formID, key, value })
    if (r.server !== s.server || r.status !== 200) return false
    return !Array.isArray(r.data?.pending) || !r.data.pending.some((x: Json) => x?.id === formID)
  }
  // The queued-message inbox (its own GET, for the cancel path — chat's copy
  // arrives on the session snapshot instead).
  async function inbox(pane: TranscriptPane): Promise<Json[]> {
    if (!pane.agentSession) return []
    const s = await snapshot(pane.agentSession)
    if (!s) return []
    const r = await query(pane.agentSession, 'inbox')
    if (r.server !== s.server || r.status !== 200) return []
    return Array.isArray(r.data?.data) ? r.data.data : []
  }
  async function inboxDelete(pane: TranscriptPane, itemID: string): Promise<boolean | null> {
    if (!pane.agentSession) return false
    const s = await snapshot(pane.agentSession)
    if (!s) return false
    const r = await query(pane.agentSession, 'inbox_delete', { item: itemID })
    if (r.server !== s.server) return false
    if (r.status === 404) return null
    if (r.status !== 200) return false
    return !Array.isArray(r.data?.items) || !r.data.items.some((x: Json) => x?.id === itemID)
  }
  async function shell(pane: TranscriptPane, command: string): Promise<boolean> {
    if (!pane.agentSession) return false
    const s = await snapshot(pane.agentSession)
    if (!s) return false
    // The reply arrives when the command ends: allow the full shim budget.
    const r = await query(pane.agentSession, 'shell', { command, seconds: 290 })
    return r.server === s.server && r.status === 200
  }
  // Composer status from the session record itself: total tokens and cost.
  async function status(pane: TranscriptPane): Promise<{ line: string, meters: string | null } | null> {
    if (!pane.agentSession) return null
    const s = await snapshot(pane.agentSession)
    if (!s) return null
    const t = s.info.tokens
    const total = ['input', 'output', 'reasoning'].reduce((n, k) => n + (Number.isFinite(t?.[k]) ? t[k] : 0), 0)
    if (!total && !Number.isFinite(s.info.cost)) return null
    const tok = total >= 1e6 ? `${(total / 1e6).toFixed(1)}M` : total >= 1e3 ? `${(total / 1e3).toFixed(1)}k` : String(total)
    const cost = Number.isFinite(s.info.cost) && s.info.cost > 0 ? ` · $${s.info.cost.toFixed(2)}` : ''
    return { line: `${tok} tok${cost}`, meters: null }
  }
  function observe(panes: TranscriptPane[]) {
    if (!panes.some(p => p.agent === 'opencode' && p.agentSession)) { child?.kill(); child = null; cache.clear(); pageBytes = 0 }
  }
  return { chat, model, image, search, models, patchModel, pending: pendingRequests, replyPermission, replyForm, inbox, inboxDelete, shell, status, dispose, observe }
}
