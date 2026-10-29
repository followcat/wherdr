import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { DEVIN_QUERY } from './devinStore'
import { boundedOutput, type ShellExec } from './fsx'
import type { ChatItem, ChatResponse, ModelInfo } from '../../shared/types'
import type { TranscriptPane } from './transcripts'
import { excerpt, matchAt } from '../../shared/searchText'
import { cleanModelName } from './models'

// JSON saved by Devin is versioned independently of wherdr.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>
interface Row { id: number, message: Json, digest: string }
interface Snapshot { available: boolean, file?: string, model?: string, rows?: Row[], context?: Row[], start?: number, prefix?: string, rewritten?: boolean, limited?: boolean }
export interface DevinOptions { since?: string, from?: number | null, before?: number | null, anchor?: string }
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24)
// ASCII argv also works when SSH or a service starts under the C locale.
const jsonArgument = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
const clip = (s: unknown) => typeof s === 'string' ? s.slice(0, 20000) : ''
const tokenParts = (token = '') => {
  const m = /^devin:(devin-[a-f0-9]{24}):(\d+):([a-f0-9]{24}):[a-f0-9]{24}(?=[~#]|$)/.exec(token)
  return m ? { file: m[1]!, start: Number(m[2]), prefix: m[3]! } : null
}

function localQuery(home: string, request: Json, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-X', 'utf8', '-c', DEVIN_QUERY, home, jsonArgument(request)], { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = boundedOutput(maxBytes)
    const err = boundedOutput(4096)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 15000)
    child.stdout.on('data', (b: Buffer) => { if (!out.push(b)) child.kill() })
    child.stderr.on('data', (b: Buffer) => { if (!err.push(b)) child.kill() })
    child.on('error', () => { clearTimeout(timer); reject(new Error('Python 3 is required to read Devin conversations')) })
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut || out.over) return reject(new Error('Devin conversation read exceeded its limit'))
      const body = out.take()
      if (code !== 0) {
        let message = 'Unable to read Devin conversation'
        try { message = JSON.parse(body.toString()).error || message } catch { /* process failed before JSON output */ }
        reject(new Error(message))
      } else resolve(body)
    })
  })
}

function blocks(message: Json): Json[] {
  const parts = message.metadata?.extensions?.['chisel/acp-content-blocks']
  if (Array.isArray(parts)) return parts
  return Array.isArray(message.content) ? message.content : []
}
function images(value: unknown): Json[] {
  if (Array.isArray(value)) return value.flatMap(images)
  if (!value || typeof value !== 'object') return []
  const obj = value as Json
  if (obj.type === 'image' && typeof obj.data === 'string' && typeof obj.mimeType === 'string') return [obj]
  return Object.values(obj).flatMap(images)
}
function contentText(value: unknown): string {
  if (typeof value === 'string') return clip(value)
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n')
  if (!value || typeof value !== 'object') return ''
  const obj = value as Json
  if (obj.type === 'text') return clip(obj.text)
  if (obj.type === 'resource') return clip(obj.resource?.text)
  if (obj.type === 'content') return contentText(obj.content)
  return ''
}
function toolData(call: Json, result?: Row) {
  const meta = result?.message.metadata?.extensions || {}
  const rich = meta['chisel/tool_call_content'] || []
  const output = result ? contentText(result.message.content) : ''
  const exit = meta['chisel/terminal_output']?.exit?.exit_code ?? meta['chisel/tool_result_meta']?.exit_code
  return { output, rich, error: meta['chisel/tool_result_meta']?.success === false || (typeof exit === 'number' && exit !== 0), title: call.name || 'Tool' }
}

export function parseDevin(snapshot: Snapshot): ChatItem[] {
  const rows = snapshot.rows || []
  const results = new Map<string, Row>()
  for (const r of [...rows, ...snapshot.context || []]) if (r.message.role === 'tool' && typeof r.message.tool_call_id === 'string') results.set(r.message.tool_call_id, r)
  const items: ChatItem[] = []
  for (const row of rows) {
    const m = row.message
    const ts = typeof m.metadata?.created_at === 'string' ? m.metadata.created_at : null
    const ref = (slot: string) => `${row.id}:${slot}`
    if (m.role === 'user') {
      if (m.metadata?.is_user_input !== true) continue
      const parts = blocks(m)
      const text = clip(m.content) || contentText(parts)
      const count = images(parts).length
      if (text || count) items.push({ role: 'user', text, ts, ref: ref('u'), ...(count ? { images: count } : {}) })
    }
    if (m.role !== 'assistant') continue
    const thinking = typeof m.thinking === 'string' ? m.thinking : m.thinking?.thinking
    if (thinking) items.push({ role: 'thinking', text: clip(thinking), ts, ref: ref('h') })
    const text = contentText(m.content)
    const count = images(blocks(m)).length
    if (text || count) items.push({ role: 'assistant', text, ts, ref: ref('a'), ...(count ? { images: count } : {}) })
    for (const [index, call] of (Array.isArray(m.tool_calls) ? m.tool_calls : []).entries()) {
      if (typeof call.id !== 'string') continue
      const result = results.get(call.id)
      const data = toolData(call, result)
      const input = call.arguments || {}
      const summary = input.command || input.file_path || input.path || input.query || input.pattern || data.title
      const rich = result?.message.metadata?.extensions?.['chisel/tool_call_content'] || data.rich
      const count = images(rich).length
      items.push({ role: 'tool', name: call.name || data.title, text: clip(summary), ts,
        ref: count && result ? `${result.id}:r` : ref(`t${index}`), ...(data.output ? { out: data.output } : {}),
        ...(data.error ? { error: true } : {}), ...(count ? { images: count } : {}) })
    }
  }
  return items
}

export function createDevinTranscripts({ home, exec }: { home: string, exec?: ShellExec }) {
  const pending = new Map<string, Promise<Snapshot>>()
  async function query(session: string, op: string, options: Json = {}): Promise<Snapshot> {
    const request = { session, op, ...options }
    const key = JSON.stringify(request)
    const known = pending.get(key)
    if (known) return known
    const work = (async () => {
      const maxBytes = op === 'image' ? 84 * 1024 * 1024 : 24 * 1024 * 1024
      let body: Buffer
      if (exec) {
        const r = await exec('python3 -X utf8 -c "$1" "$2" "$3"', [DEVIN_QUERY, home, jsonArgument(request)], { timeoutMs: 15000, maxBytes })
        if (r.code !== 0) {
          let error = r.code === 127 ? 'Python 3 is required to read Devin conversations' : 'Unable to read Devin conversation on the remote machine'
          try { error = JSON.parse(r.stdout.toString()).error || error } catch { /* SSH or runtime unavailable */ }
          throw new Error(error)
        }
        body = r.stdout
      } else body = await localQuery(home, request, maxBytes)
      return JSON.parse(body.toString('utf8')) as Snapshot
    })()
    pending.set(key, work)
    try { return await work } finally { pending.delete(key) }
  }
  async function chat(pane: TranscriptPane, opts: DevinOptions = {}): Promise<ChatResponse> {
    if (!pane.agentSession) return { available: false, reason: 'not_found' }
    const r = await query(pane.agentSession, 'page', { from: opts.from, before: opts.before, anchor: tokenParts(opts.anchor || opts.since) })
    if (!r.available) return { available: false, reason: 'not_found' }
    const items = parseDevin(r)
    const token = `devin:${r.file}:${r.start}:${r.prefix}:${hash(JSON.stringify([r.rows?.map(n => n.digest), r.context?.map(n => n.digest), r.model, items]))}`
    const base = { available: true, file: r.file, session: pane.agentSession }
    if (opts.before != null) return { ...base, older: true, items, start: r.start, ...(r.rewritten ? { rewritten: true } : {}) }
    if (!r.rewritten && token === opts.since) return { ...base, token, unchanged: true }
    return { ...base, token, items, start: r.start, queue: [], ...(r.rewritten ? { rewritten: true } : {}) }
  }
  async function image(pane: TranscriptPane, file: string | null, ref: string | null, index: number): Promise<{ type: string, body: Buffer } | null> {
    const m = /^(\d+):(u|a|r|t\d+)$/.exec(ref || '')
    if (!pane.agentSession || !m || !Number.isSafeInteger(index) || index < 0) return null
    const r = await query(pane.agentSession, 'image', { node: Number(m[1]) })
    if (!r.available || r.file !== file || !r.rows?.[0]) return null
    const message = r.rows[0].message
    const slot = m[2]!
    let rich: unknown = blocks(message)
    if (slot === 'r') rich = message.metadata?.extensions?.['chisel/tool_call_content']
    if (slot.startsWith('t')) return null // Tool images reference their result node.
    const img = images(rich)[index]
    if (!img || img.data.length > 80 * 1024 * 1024) return null
    const body = Buffer.from(img.data, 'base64')
    if (body.length > 60 * 1024 * 1024) return null
    const mime = img.mimeType.toLowerCase()
    return { type: /^image\/(?:png|jpeg|gif|webp|avif)$/.test(mime) ? mime : 'application/octet-stream', body }
  }
  async function search(pane: TranscriptPane, text: string, deadline: number) {
    if (!pane.agentSession || Date.now() >= deadline) return { hits: [], limited: Date.now() >= deadline, kind: 'devin' }
    const r = await query(pane.agentSession, 'search', { seconds: Math.max(.1, (deadline - Date.now()) / 1000) })
    const hits = parseDevin(r).filter(i => i.role === 'user' || i.role === 'assistant').flatMap(i => {
      const at = matchAt(i.text, text)
      return at < 0 ? [] : [{ role: i.role, text: i.text.slice(0, 180), excerpt: excerpt(i.text, at, 120, text), ts: i.ts, offset: Number(i.ref!.split(':')[0]) + 1 }]
    }).slice(0, 8)
    return { hits, limited: Boolean(r.limited), kind: 'devin' }
  }
  async function model(pane: TranscriptPane): Promise<ModelInfo | null> {
    if (!pane.agentSession) return null
    const r = await query(pane.agentSession, 'model')
    return typeof r.model === 'string' && r.model ? { id: r.model, label: cleanModelName(r.model) } : null
  }
  return { chat, image, search, model }
}
