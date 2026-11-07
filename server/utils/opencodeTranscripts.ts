// Read-only OpenCode conversation reader for core panes (A5). The pane's
// session was already selected fail-closed by opencodeCore.ts; this module
// reads it through the verified snapshot assembly (opencodeSnapshot.ts):
// every page body arrives fingerprint-bound to the server generation, and
// an `expect` meta revalidates a cached page with zero body bytes. No
// writes, no stream, no model/permission/inbox/shell endpoints — later
// interaction features stay unwired by design.
//
// Cursor model: the shared chat API speaks numeric start/from/before where
// an older page's start must be BELOW the cursor it was asked with. Native
// page cursors are opaque strings, so this reader mints numeric ids —
// decreasing from MAX_SAFE_INTEGER — that resolve back to {file, message
// id}: a tail join looks the anchor up in the descending page walk, an
// older slice is the messages strictly below its anchor. A cursor never
// crosses a session's file identity (server generation, session, revert
// token), so a stale id can only yield a fresh bottom, never another
// conversation's items.
import { createHash } from 'node:crypto'
import type { ShellExec, MachineFs } from './fsx'
import { opencodeSnapshots, type OpencodeSnapshot } from './opencodeSnapshot'
import type { ChatItem, ChatResponse, ConversationHit, ModelInfo } from '../../shared/types'
import type { Loc, TranscriptPane } from './transcripts'
import { cleanModelName } from './models'
import { excerpt, matchAt } from './conversationSearch'

type Json = Record<string, any>
type Read = (home: string, request: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<OpencodeSnapshot>

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24)
const clip = (s: unknown) => typeof s === 'string' ? s.slice(0, 20000) : ''
const tsOf = (m: Json) => Number.isFinite(m.time?.created) && Math.abs(m.time.created) <= 8.64e15 ? new Date(m.time.created).toISOString() : null
// User attachments count as images when they carry inline data or a local
// file:/data: URI — the reader resolves session-referenced URIs only.
const imageFiles = (files: unknown): Json[] => Array.isArray(files) ? files.filter(f => /^image\/(png|jpeg|gif|webp|avif)$/.test(f?.mime) && (typeof f.data === 'string' || typeof f.uri === 'string')) : []
const toolImages = (content: unknown): Json[] => Array.isArray(content) ? content.filter(f => f?.type === 'file' && /^image\/(png|jpeg|gif|webp|avif)$/.test(f.mime) && /^(?:file:|data:image\/)/.test(f.uri)) : []
const toolText = (content: unknown) => typeof content === 'string' ? clip(content) : Array.isArray(content)
  ? content.filter(p => p?.type === 'text').map(p => clip(p.text)).join('\n').slice(0, 20000) : ''

// A synthetic shell job's text is `<shell id=".." state=".." command="…">`
// wrapped around the captured output; the command is also on `description`.
const SHELL_OPEN = /^<shell\b[^>]*>/
const shellCommand = (m: Json) => {
  if (typeof m.description === 'string' && m.description) return clip(m.description)
  const c = /\bcommand="((?:[^"\\]|\\.)*)"/.exec(typeof m.text === 'string' ? m.text : '')
  return c ? clip(c[1]!.replace(/\\(["\\])/g, '$1')) : ''
}
const shellOutput = (m: Json) => {
  const t = typeof m.text === 'string' ? m.text : ''
  const open = SHELL_OPEN.exec(t)
  if (!open) return clip(t)
  const rest = t.slice(open[0].length)
  return clip(rest.endsWith('</shell>') ? rest.slice(0, -8) : rest)
}

// Native OpenCode messages -> shared items. user -> user, a shell job ->
// bash, assistant text/reasoning -> assistant/thinking, assistant tool
// parts -> tool, system/compaction/model-switched notices -> notice, and
// status markers (idle) and unknown types -> nothing.
export function parseOpenCode(messages: Json[]): ChatItem[] {
  return messages.flatMap(m => {
    if (!m || typeof m.id !== 'string') return []
    const ts = tsOf(m)
    const ref = (slot: string) => `oc:${m.id}:${slot}`
    if (m.type === 'user') {
      const images = imageFiles(m.files).length
      return m.text || images ? [{ role: 'user', text: clip(m.text), ts, ref: ref('u'), ...(images ? { images } : {}) } as ChatItem] : []
    }
    if (m.type === 'shell') return [{ role: 'bash', text: clip(m.command), out: clip(m.output?.output), ts, ref: ref('s'), ...(m.exit || m.status === 'timeout' ? { error: true } : {}) } as ChatItem]
    if (m.type === 'synthetic') {
      if (m.metadata?.source !== 'shell') return m.text || m.description
        ? [{ role: 'notice', text: clip(m.description || m.text), ts, ref: ref('n') } as ChatItem] : []
      const failed = Number.isFinite(m.metadata?.exit) && m.metadata.exit !== 0
        || ['failed', 'timeout', 'killed'].includes(String(m.metadata?.state))
      return [{ role: 'bash', text: shellCommand(m), out: shellOutput(m), ts, ref: ref('s'), ...(failed ? { error: true } : {}) } as ChatItem]
    }
    if (m.type === 'system') return m.text || m.description
      ? [{ role: 'notice', text: clip(m.description || m.text), ts, ref: ref('n') } as ChatItem] : []
    if (m.type === 'compaction') return [{ role: 'notice', name: 'compaction', text: clip(m.summary) || 'Context compacted', ts, ref: ref('n') } as ChatItem]
    if (m.type === 'model-switched') {
      const id = typeof m.model?.id === 'string' ? m.model.id : ''
      return id ? [{ role: 'notice', name: 'model', text: `Switched to ${id}`, ts, ref: ref('n') } as ChatItem] : []
    }
    if (m.type !== 'assistant') return []
    const items: ChatItem[] = []
    for (const [index, part] of (Array.isArray(m.content) ? m.content : []).entries()) {
      if ((part?.type === 'text' || part?.type === 'reasoning') && part.text) items.push({ role: part.type === 'text' ? 'assistant' : 'thinking', text: clip(part.text), ts, ref: ref(`p${index}`) })
      if (part?.type === 'tool' && typeof part.id === 'string') {
        const input = part.state?.input || {}
        const summary = typeof input === 'string' ? input : input.command || input.file_path || input.path || input.query || input.pattern || input.description || input.prompt || input.url || part.name
        const output = toolText(part.state?.content) || clip(part.state?.error?.message)
        items.push({ role: 'tool', name: clip(part.name), text: clip(summary), ts, ref: ref(`t${part.id}`),
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

// The selection identity the transcripts layer hands back in Loc.file:
// 'oc:' + server generation + session id.
const OC_FILE = /^oc:([a-f0-9]{32}):([0-9A-Za-z_-]{1,128})$/
const locOf = (file: string | undefined | null) => {
  const m = file ? OC_FILE.exec(file) : null
  return m ? { server: m[1]!, session: m[2]! } : null
}
export const ocFile = (server: string, session: string) => `oc:${server}:${session}`

const parse = (body: Buffer): Json | null => {
  try { const d = JSON.parse(body.toString('utf8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : null }
  catch { return null }
}

export function createOpencodeTranscripts({ exec, home, fs, snap }: { exec: ShellExec, home: string, fs?: MachineFs, snap?: Read }) {
  const read: Read = snap ?? opencodeSnapshots(exec).read
  // Per-pane caches: the selected session's record (fingerprinted), its
  // native pages (fingerprinted) and every minted numeric cursor. A page's
  // `expect` meta revalidates with zero body bytes, so an unchanged poll
  // walks the same fingerprints the client already holds.
  const sessions = new Map<string, { server: string, session: string, fp: string, info: Json, file: string, model: ModelInfo | null }>()
  const pages = new Map<string, Map<string, { fp: string, body: Json }>>()
  const cursors = new Map<number, { file: string, value: string }>()
  let nextCursor = Number.MAX_SAFE_INTEGER - 1
  const mint = (file: string, value: string) => {
    const id = nextCursor--
    cursors.set(id, { file, value })
    if (cursors.size > 4096) cursors.delete(cursors.keys().next().value!)
    return id
  }

  // A {status} reply is a proven absence (404 etc.): the session or page is
  // gone — the pane's selection is stale, "no conversation" is honest. An
  // {error} reply is a transport unknown (discovery failed, helper
  // unreachable): nothing is proven — a read error, so the caller's view
  // keeps what it has and the next poll retries.
  const unknown = () => { throw new Error('opencode read unknown') }

  async function sessionInfo(paneId: string, sel: { server: string, session: string }) {
    const known = sessions.get(paneId)
    const r = await read(home, { op: 'session', session: sel.session,
      ...(known && known.server === sel.server && known.session === sel.session ? { expect: known.fp } : {}) })
    if (!r.ok) return 'status' in r ? null : unknown()
    if (r.server !== sel.server) return null
    if (r.unchanged) return known ?? null
    const d = parse(r.body)
    const info = d?.data
    if (!info || typeof info !== 'object' || info.id !== sel.session) return null
    const file = 'opencode-' + hash(JSON.stringify([sel.server, sel.session, info.revert ?? null]))
    const m = info.model
    const model = typeof m?.id === 'string' ? { id: m.id, label: cleanModelName(m.id), ...(typeof m.variant === 'string' && m.variant ? { effort: m.variant } : {}) } : null
    const rec = { server: sel.server, session: sel.session, fp: r.fingerprint, info, file, model }
    sessions.set(paneId, rec)
    if (sessions.size > 64) sessions.delete(sessions.keys().next().value!)
    return rec
  }

  // One fingerprint-verified page body by native cursor key ('' = the
  // newest page). A cached page revalidates through its `expect` meta; a
  // changed one is refetched whole and its fingerprint re-proven.
  async function page(paneId: string, sel: { server: string, session: string }, key: string) {
    const known = pages.get(paneId)?.get(key)
    const r = await read(home, { op: 'page', session: sel.session, ...(key ? { cursor: key } : {}), ...(known ? { expect: known.fp } : {}) })
    if (!r.ok) return 'status' in r ? null : unknown()
    if (r.server !== sel.server) return null
    if (r.unchanged) return known?.body ?? null
    const d = parse(r.body)
    if (!d || !Array.isArray(d.data) || !(d.cursor && typeof d.cursor === 'object')) return null
    let m = pages.get(paneId)
    if (!m) pages.set(paneId, m = new Map())
    m.set(key, { fp: r.fingerprint, body: d })
    if (m.size > 40) m.delete(m.keys().next().value!)
    return d
  }
  const pageFp = (paneId: string, key: string) => pages.get(paneId)?.get(key)?.fp

  // The messages strictly older than `anchor` (a message id), newest-first,
  // up to `limit`. The anchor's own page contributes its messages below the
  // anchor; whole older pages follow until the limit or the history end.
  async function older(paneId: string, sel: { server: string, session: string }, anchor: string, limit: number) {
    let p = await page(paneId, sel, '')
    if (!p) return null
    let at = p.data.findIndex((m: Json) => m?.id === anchor)
    let next = typeof p.cursor?.next === 'string' ? p.cursor.next : ''
    let bytes = Buffer.byteLength(JSON.stringify(p.data))
    const out: Json[] = []
    for (let n = 0; at < 0; n++) {
      if (!next || n >= 10 || bytes >= 24 * 1024 * 1024) return null
      p = await page(paneId, sel, next)
      if (!p) return null
      at = p.data.findIndex((m: Json) => m?.id === anchor)
      bytes += Buffer.byteLength(JSON.stringify(p.data))
      next = typeof p.cursor?.next === 'string' ? p.cursor.next : ''
    }
    out.push(...p.data.slice(at + 1))
    let truncated = false
    while (out.length < limit && next) {
      p = await page(paneId, sel, next)
      // A page that cannot be proven right now ends the walk honestly:
      // "that's all" rather than a slice the next before would reset.
      if (!p) { truncated = true; break }
      next = typeof p.cursor?.next === 'string' ? p.cursor.next : ''
      out.push(...p.data)
    }
    return { messages: out.slice(0, limit), more: !truncated && (out.length > limit || Boolean(next)) }
  }

  async function chat(pane: TranscriptPane, loc: Loc, opts: { since?: string, from?: number | null, before?: number | null } = {}): Promise<ChatResponse> {
    const sel = locOf(loc.file)
    if (!sel) return { available: false, reason: 'not_found' }
    const s = await sessionInfo(pane.id, sel)
    if (!s) return { available: false, reason: 'not_found' }
    const base = { available: true, file: s.file, session: sel.session, guessed: true }
    if (opts.before != null) {
      const c = cursors.get(opts.before)
      if (!c || c.file !== s.file) return { ...base, older: true, rewritten: true, items: [] }
      const r = await older(pane.id, sel, c.value, 120)
      if (!r) return { ...base, older: true, rewritten: true, items: [] }
      const items = parseOpenCode([...r.messages].reverse())
      return { ...base, older: true, items, ...(r.more && r.messages.length ? { start: mint(s.file, r.messages[r.messages.length - 1]!.id) } : {}) }
    }
    const c = opts.from != null ? cursors.get(opts.from) : null
    const valid = Boolean(c && c.file === s.file)
    let p = await page(pane.id, sel, '')
    if (!p) return { available: false, reason: 'not_found' }
    const first = p
    let all: Json[] = [...p.data]
    let bytes = Buffer.byteLength(JSON.stringify(p.data))
    let next = typeof p.cursor?.next === 'string' ? p.cursor.next : ''
    // Follow native pages to the old tail anchor. Bound growth; if the
    // anchor vanished after a revert/compaction, replace the tail rather
    // than joining it.
    for (let n = 0; valid && !all.some(m => m?.id === c!.value) && next && n < 11 && bytes < 24 * 1024 * 1024; n++) {
      p = await page(pane.id, sel, next)
      if (!p) break
      all.push(...p.data)
      bytes += Buffer.byteLength(JSON.stringify(p.data))
      next = typeof p.cursor?.next === 'string' ? p.cursor.next : ''
    }
    const at = valid ? all.findIndex(m => m?.id === c!.value) : -1
    const rewritten = opts.from != null && (!valid || at < 0)
    const messages = (at >= 0 ? all.slice(0, at + 1) : [...first.data]).reverse()
    const items = parseOpenCode(messages)
    const start = valid && at >= 0 ? opts.from! : (messages[0]?.id ? mint(s.file, messages[0].id) : undefined)
    // The token is content identity, not cursor identity: the same
    // conversation re-read under a different join or a fresh numeric id is
    // still unchanged — only its items and model count.
    const token = `opencode:${s.file}:${hash(JSON.stringify([items, s.model]))}`
    if (!rewritten && token === opts.since) return { ...base, token, unchanged: true }
    return { ...base, token, ...(start !== undefined ? { start } : {}), items, ...(rewritten ? { rewritten: true } : {}) }
  }

  async function model(pane: TranscriptPane, loc: Loc): Promise<ModelInfo | null> {
    const sel = locOf(loc.file)
    if (!sel) return null
    return (await sessionInfo(pane.id, sel))?.model ?? null
  }

  // An image lives inside a page this reader can already verify: walk the
  // newest pages until the message, then its user-file or tool-content
  // entry by slot ('u' = user attachments, 't<partId>' = a tool part's
  // image entries). Inline data returns directly; file:/data: URIs resolve
  // locally — never a network fetch.
  async function image(pane: TranscriptPane, loc: Loc, fileId: string | null, ref: string | null, index: number) {
    const m = /^oc:([^:]+):(u|t.+)$/.exec(ref || '')
    if (!m || !Number.isSafeInteger(index) || index < 0) return null
    const sel = locOf(loc.file)
    if (!sel) return null
    const s = await sessionInfo(pane.id, sel)
    if (!s || s.file !== fileId) return null
    let key = ''
    for (let n = 0; n < 10; n++) {
      const p = await page(pane.id, sel, key)
      if (!p) return null
      const msg = p.data.find((x: Json) => x?.id === m![1])
      if (msg) {
        let img: Json | undefined
        if (m![2] === 'u') img = imageFiles(msg.files)[index]
        else {
          const part = (Array.isArray(msg.content) ? msg.content : [])
            .find((x: Json) => x?.type === 'tool' && typeof x.id === 'string' && `t${x.id}` === m![2])
          img = part ? toolImages(part.state?.content)[index] : undefined
        }
        if (!img || !/^image\/(png|jpeg|gif|webp|avif)$/.test(img.mime)) return null
        if (typeof img.data === 'string' && img.data.length <= 24 * 1024 * 1024) return { type: img.mime, body: Buffer.from(img.data, 'base64') }
        const uri = typeof img.uri === 'string' ? img.uri : ''
        if (uri.startsWith('data:image/')) {
          const at = uri.indexOf(';base64,')
          return at > 0 && uri.length - at - 8 <= 32 * 1024 * 1024 ? { type: img.mime, body: Buffer.from(uri.slice(at + 8), 'base64') } : null
        }
        if (uri.startsWith('file:') && fs) {
          const target = uri.slice(5).replace(/^\/\//, '/')
          try {
            const st = await fs.stat(target)
            return st.isFile && st.size <= 24 * 1024 * 1024 ? { type: img.mime, body: await fs.read(target, 0, st.size) } : null
          } catch { return null }
        }
        return null
      }
      key = typeof p.cursor?.next === 'string' ? p.cursor.next : ''
      if (!key) return null
    }
    return null
  }

  async function search(pane: TranscriptPane, loc: Loc, query: string, deadline: number) {
    const hits: Omit<ConversationHit, 'pane' | 'agent' | 'title'>[] = []
    const sel = locOf(loc.file)
    if (!sel || Date.now() >= deadline) return { hits, limited: Date.now() >= deadline, kind: 'opencode' }
    const s = await sessionInfo(pane.id, sel)
    if (!s) return { hits, limited: false, kind: 'opencode' }
    let key = ''
    let bytes = 0
    let off = 0
    for (let n = 0; n < 40 && Date.now() < deadline && bytes < 8 * 1024 * 1024; n++) {
      const p = await page(pane.id, sel, key)
      if (!p) return { hits: [], limited: true, kind: 'opencode' }
      bytes += Buffer.byteLength(JSON.stringify(p.data))
      for (const i of parseOpenCode(p.data)) {
        off++
        if (i.role !== 'user' && i.role !== 'assistant') continue
        const at = matchAt(i.text, query)
        if (at >= 0) hits.push({ role: i.role, text: i.text.slice(0, 180), excerpt: excerpt(i.text, at, 120, query), ts: i.ts, offset: off })
        if (hits.length >= 8) return { hits, limited: true, kind: 'opencode' }
      }
      key = typeof p.cursor?.next === 'string' ? p.cursor.next : ''
      if (!key) return { hits, limited: false, kind: 'opencode' }
    }
    return { hits, limited: Boolean(key), kind: 'opencode' }
  }

  function forget(paneId: string) {
    sessions.delete(paneId)
    pages.delete(paneId)
  }

  return { chat, model, image, search, forget, sessionInfo, pageFp }
}
