import { createHash } from 'node:crypto'
import path from 'node:path'
import type { ChatItem, ChatResponse, ModelInfo } from '../../shared/types'
import type { TranscriptPane } from './transcripts'
import { excerpt, matchAt } from '../../shared/searchText'
import { ompModelLabel } from './models'
import { HerdrError } from './herdr'
import { type MachineFs, localFs } from './fsx'

// JSON saved by Devin is versioned independently of wherdr (ATIF-v1.7).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>
type Step = Json
interface ImagePayload { mimeType: string, data?: string, hash?: string }
interface AtifDoc {
  file: string
  model: string | null
  steps: Step[]
  images: Map<string, ImagePayload[]>
  fingerprints: Map<number, string>
  results: Map<string, ToolResult>
}
export interface DevinOptions { since?: string, from?: number | null, before?: number | null, anchor?: string }

const PAGE_ITEMS = 120
const MAX_READ_BYTES = 24 * 1024 * 1024
// Base64 + JSON framing must remain below coreCall's 16 MiB reply limit.
const READ_CHUNK_BYTES = 4 * 1024 * 1024
const MAX_TEXT = 20000
const FAIL_QUIET_MS = 1500
const IMAGE_TYPES = /^image\/(?:png|jpeg|gif|webp|avif)$/
const hash12 = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12)
const clip = (s: unknown) => typeof s === 'string' ? s.slice(0, MAX_TEXT) : ''
const genOf = (st: { mtimeMs: number, ino?: number }) => `${st.ino ? `${st.ino}-` : ''}${Math.round(st.mtimeMs * 1000)}`
const HEAD = /^(.*):(\d+):(null|\d+):(?:(\d+)-)?(\d+)(!?)(?=[/~#]|$)/
const ANCHOR = /\/(\d+)\.([0-9a-f]{12})(?=[~#]|$)/

function isMissing(e: unknown): boolean {
  const err = e as { code?: string, message?: string } | null
  if (!err) return false
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return true
  return err.code === 'remote' && /no such file|not a directory|introuvable/i.test(err.message || '')
}

export function cliDir(home: string, honorEnv = true): string {
  if (honorEnv) {
    const sessions = process.env.DEVIN_SESSIONS_DIR
    if (sessions) return sessions
    const xdg = process.env.XDG_DATA_HOME
    if (xdg) return path.join(xdg, 'devin/cli')
  }
  return path.join(home, '.local/share/devin/cli')
}

export function transcriptPath(home: string, session: string, honorEnv = true): string | null {
  if (!session || /[/\\]|\0/.test(session)) return null
  return path.join(cliDir(home, honorEnv), 'transcripts', `${session}.json`)
}

function asList(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(v => v && typeof v === 'object') as Json[] : []
}

function isUserStep(step: Step): boolean {
  if (step.is_copied_context === true) return false
  if (step.metadata?.is_user_input === false) return false
  if (step.metadata?.is_user_input === true) return true
  return step.source === 'user'
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

function images(value: unknown): Json[] {
  if (Array.isArray(value)) return value.flatMap(images)
  if (!value || typeof value !== 'object') return []
  const obj = value as Json
  if (obj.type === 'image') return [obj]
  return Object.values(obj).flatMap(images)
}

function imagePayload(img: Json): ImagePayload | null {
  const mime = String(img.mimeType || img.media_type || img.source?.media_type || 'image/png')
  const data = typeof img.data === 'string' && img.data ? img.data
    : typeof img.extra?.data === 'string' && img.extra.data ? img.extra.data
      : typeof img.source?.data === 'string' && img.source.data ? img.source.data
        : undefined
  // An ATIF attachment is not permission to open another file on the machine.
  return data ? { mimeType: mime, data } : null
}

function payloads(value: unknown): ImagePayload[] {
  return images(value).map(imagePayload).filter((img): img is ImagePayload => Boolean(img))
}

function extraBlocks(step: Step): unknown {
  return step.metadata?.extensions?.['chisel/acp-content-blocks']
}

function toolCalls(step: Step): Json[] {
  return asList(step.tool_calls).map(call => ({
    id: typeof call.tool_call_id === 'string' ? call.tool_call_id : call.id,
    name: call.function_name || call.name || 'Tool',
    arguments: call.arguments && typeof call.arguments === 'object' ? call.arguments : {},
    extra: call.extra,
  })).filter(call => typeof call.id === 'string')
}

interface ToolResult { step: Step, result: Json, index: number }
const resultRef = (hit: ToolResult) => `${Number(hit.step.step_id)}:r${hit.index || ''}`
function observations(steps: Step[]): Map<string, ToolResult> {
  const found = new Map<string, ToolResult>()
  for (const step of steps) {
    for (const [index, result] of asList(step.observation?.results).entries()) {
      const id = result.source_call_id
      if (typeof id === 'string' && !found.has(id)) found.set(id, { step, result, index })
    }
  }
  return found
}

function toolError(result: Json | undefined): boolean {
  if (!result) return false
  const extra = result.extra || result.metadata?.extensions || {}
  const meta = extra['chisel/tool_result_meta'] || extra
  const exit = meta.exit_code ?? extra.exit_code ?? extra.exit?.exit_code ?? extra['chisel/terminal_output']?.exit?.exit_code
  return meta.success === false || extra.success === false || (typeof exit === 'number' && exit !== 0)
}

function latestModel(doc: AtifDoc): string | null {
  for (let i = doc.steps.length - 1; i >= 0; i--) {
    const step = doc.steps[i]!
    const name = step.metadata?.generation_model || step.extra?.generation_model || step.model_name
    if (typeof name === 'string' && name) return name
  }
  return doc.model
}

function resultImages(hit: ToolResult | undefined): ImagePayload[] {
  if (!hit) return []
  return payloads(hit.result.content).concat(payloads(hit.result.extra), payloads(hit.result.metadata))
}

export function parseDevin(steps: Step[], all: Step[] = steps, imagesByRef?: Map<string, ImagePayload[]>, results = observations(all)): ChatItem[] {
  const items: ChatItem[] = []
  // Same payload bytes a /chat/image request serves — hashed so the view can
  // collapse a picture repeated in a later message (shared/imageDupes.ts).
  const imageHashes = (ref: string) => {
    const list = imagesByRef?.get(ref)
    return list && list.length ? list.map((i, n) => i.hash || hash12(i.data || `${ref}:${n}`)) : undefined
  }
  for (const step of steps) {
    if (step.is_copied_context === true || step.source === 'system') continue
    const ts = typeof step.timestamp === 'string' ? step.timestamp
      : typeof step.metadata?.created_at === 'string' ? step.metadata.created_at
        : null
    const id = Number(step.step_id)
    if (!Number.isSafeInteger(id) || id < 1) continue
    const ref = (slot: string) => `${id}:${slot}`
    if (isUserStep(step)) {
      const parts = step.message
      const blocks = extraBlocks(step)
      const text = clip(contentText(parts) || contentText(blocks))
      const count = imagesByRef ? imagesByRef.get(ref('u'))?.length || 0 : payloads(parts).length + payloads(blocks).length
      if (text || count) items.push({ role: 'user', text, ts, ref: ref('u'), ...(count ? { images: count } : {}), ...(imageHashes(ref('u')) ? { hashes: imageHashes(ref('u')) } : {}) })
      continue
    }
    if (step.source !== 'agent' && step.source !== undefined) continue
    const thinking = typeof step.reasoning_content === 'string' ? step.reasoning_content : ''
    if (thinking) items.push({ role: 'thinking', text: clip(thinking), ts, ref: ref('h') })
    const text = clip(contentText(step.message))
    const count = imagesByRef ? imagesByRef.get(ref('a'))?.length || 0 : payloads(step.message).length + payloads(extraBlocks(step)).length
    if (text || count) items.push({ role: 'assistant', text, ts, ref: ref('a'), ...(count ? { images: count } : {}), ...(imageHashes(ref('a')) ? { hashes: imageHashes(ref('a')) } : {}) })
    for (const [index, call] of toolCalls(step).entries()) {
      const hit = results.get(call.id)
      const output = hit ? clip(contentText(hit.result.content)) : ''
      const input = call.arguments || {}
      const title = call.name || 'Tool'
      const summary = input.command || input.file_path || input.path || input.query || input.pattern || title
      const imgCount = imagesByRef ? hit && imagesByRef.get(resultRef(hit))?.length || 0 : resultImages(hit).length
      const imgRef = imgCount && hit ? resultRef(hit) : null
      items.push({
        role: 'tool', name: title, text: clip(String(summary || title)), ts,
        ref: imgRef || ref(`t${index}`),
        ...(imgRef && imageHashes(imgRef) ? { hashes: imageHashes(imgRef) } : {}),
        ...(output ? { out: output } : {}),
        ...(toolError(hit?.result) ? { error: true } : {}),
        ...(imgCount ? { images: imgCount } : {}),
      })
    }
  }
  return items
}

function collectImages(steps: Step[], results: Map<string, ToolResult>): Map<string, ImagePayload[]> {
  const found = new Map<string, ImagePayload[]>()
  const add = (ref: string, list: ImagePayload[]) => { if (list.length) found.set(ref, list) }
  for (const step of steps) {
    if (step.is_copied_context === true || step.source === 'system') continue
    const id = Number(step.step_id)
    if (!Number.isSafeInteger(id) || id < 1) continue
    if (isUserStep(step)) {
      add(`${id}:u`, payloads(step.message).concat(payloads(extraBlocks(step))))
      continue
    }
    if (step.source !== 'agent' && step.source !== undefined) continue
    add(`${id}:a`, payloads(step.message).concat(payloads(extraBlocks(step))))
    for (const call of toolCalls(step)) {
      const hit = results.get(call.id)
      const rich = resultImages(hit)
      if (rich.length && hit) add(resultRef(hit), rich)
    }
  }
  return found
}

function normalize(raw: Json, file: string): AtifDoc {
  const original = asList(raw.steps)
  const found = observations(original)
  const steps = stripImages(original) as Step[]
  const model = typeof raw.agent?.model_name === 'string' ? raw.agent.model_name : null
  const resultHashes = new Map([...found].map(([id, hit]) => [id, hash12(JSON.stringify([hit.step.step_id, hit.index, hit.result]))]))
  const fingerprints = new Map(original.map(step => [Number(step.step_id), hash12(JSON.stringify([
    step, toolCalls(step).map(call => resultHashes.get(call.id) || null),
  ]))]))
  // An older call's fingerprint includes its later observation dependency. A
  // changed result invalidates pages holding that call even if its step is intact.
  const results = new Map([...found].map(([id, hit]) => [id, {
    step: { step_id: hit.step.step_id }, index: hit.index, result: stripImages(hit.result) as Json,
  }]))
  return { file, model, steps, images: collectImages(original, found), fingerprints, results }
}

function pageTooLarge(steps: Step[], maxPageBytes: number): boolean {
  let used = 0
  for (const step of steps) {
    used += Buffer.byteLength(JSON.stringify(step))
    if (used > maxPageBytes) return true
  }
  return false
}

function takeVisible(steps: Step[], doc: AtifDoc, limit: number): { steps: Step[], start: number, items: ChatItem[] } {
  const kept: Step[] = []
  let visible = 0
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!
    kept.push(step)
    // The result index belongs to the document version: never scan all history
    // again to count one step. Hidden context costs a constant-time check.
    if (step.source !== 'system' && step.is_copied_context !== true) visible += parseDevin([step], doc.steps, doc.images, doc.results).length
    if (visible >= limit) break
  }
  kept.reverse()
  const items = parseDevin(kept, doc.steps, doc.images, doc.results)
  // Image refs can point to a later observation step. Pagination follows the
  // selected source steps, independently of where attachment bytes are stored.
  const start = kept.length < steps.length ? Number(kept[0]?.step_id) || 0 : 0
  return { steps: kept, start, items }
}

function prefixOf(doc: AtifDoc, start: number): string {
  return hash12(JSON.stringify(doc.steps.filter(s => Number(s.step_id) < start).map(s => [s.step_id, doc.fingerprints.get(Number(s.step_id))])))
}

function stripImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripImages)
  if (!value || typeof value !== 'object') return value
  const obj = value as Json
  if (obj.type === 'image') {
    const next = { ...obj }
    if (typeof next.data === 'string') next.data = ''
    if (next.extra && typeof next.extra === 'object') next.extra = { ...next.extra, data: '' }
    if (next.source && typeof next.source === 'object') next.source = { ...next.source, data: '' }
    return next
  }
  const next: Json = {}
  for (const [k, v] of Object.entries(obj)) next[k] = stripImages(v)
  return next
}

function headOf(token: string | null | undefined) {
  const m = HEAD.exec(String(token || ''))
  if (!m) return null
  return { file: m[1]!, size: Number(m[2]), from: m[3] === 'null' ? null : Number(m[3]), ino: m[4] ? Number(m[4]) : null, gen: `${m[4] ? `${m[4]}-` : ''}${m[5]}` }
}

function anchorOf(token: string | null | undefined) {
  const m = ANCHOR.exec(String(token || ''))
  return m ? { start: Number(m[1]), hash: m[2]! } : null
}

function hasStep(steps: Step[], id: number): boolean {
  return id === 0 || steps.some(s => Number(s.step_id) === id)
}

export function createDevinTranscripts({
  home, fs = localFs, now = Date.now, maxPageBytes = MAX_READ_BYTES, failQuietMs = FAIL_QUIET_MS,
}: {
  home: string
  fs?: MachineFs
  now?: () => number
  maxPageBytes?: number
  failQuietMs?: number
}) {
  const honorEnv = fs === localFs
  const loaded = new Map<string, { gen: string, size: number, doc: AtifDoc }>()
  const lastGood = new Map<string, { file?: string, token?: string }>()
  const lastModel = new Map<string, ModelInfo | null>()
  const failAt = new Map<string, number>()
  const inflight = new Map<string, Promise<AtifDoc>>()

  function pathOf(session: string): string | null {
    return transcriptPath(home, session, honorEnv)
  }

  function quiet(session: string): boolean {
    const at = failAt.get(session)
    return at !== undefined && now() - at < failQuietMs
  }

  async function statFile(file: string) {
    const st = await fs.stat(file)
    if (!st.isFile) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    return st
  }

  async function readDoc(file: string, size: number, gen: string, withImages = false): Promise<AtifDoc> {
    const hit = withImages ? null : loaded.get(file)
    if (hit && hit.gen === gen && hit.size === size) return hit.doc
    const key = `${file}|${gen}|${size}|${withImages}`
    const known = inflight.get(key)
    if (known) return known
    const work = (async () => {
      if (size > MAX_READ_BYTES) throw new Error('Devin conversation exceeds the supported size limit')
      const chunks: Buffer[] = []
      for (let start = 0; start < size; start += READ_CHUNK_BYTES) {
        const len = Math.min(READ_CHUNK_BYTES, size - start)
        const chunk = await fs.read(file, start, len)
        if (chunk.length !== len) throw new Error('Incomplete Devin transcript read')
        chunks.push(chunk)
      }
      const buf = Buffer.concat(chunks, size)
      let raw: Json
      try { raw = JSON.parse(buf.toString('utf8')) }
      catch { throw new Error('Unsupported Devin transcript format') }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema_version !== 'ATIF-v1.7' || !Array.isArray(raw.steps) || raw.session_id !== path.basename(file, '.json')) throw new Error('Unsupported Devin transcript format')
      const doc = normalize(raw, path.basename(file))
      if (!withImages) {
        // Polling retains only metadata and hashes; image views re-read the
        // bounded source on demand rather than pinning base64 across sessions.
        doc.images = new Map([...doc.images].map(([ref, list]) => [ref, list.map((img, n) => ({
          mimeType: img.mimeType,
          hash: hash12(img.data || `${ref}:${n}`),
        }))]))
        loaded.set(file, { gen, size, doc })
        if (loaded.size > 32) loaded.delete(loaded.keys().next().value!)
      }
      return doc
    })()
    inflight.set(key, work)
    try { return await work }
    finally { inflight.delete(key) }
  }

  function failOpen(session: string, e: unknown, opts: DevinOptions): never | ChatResponse {
    if (isMissing(e)) {
      lastGood.delete(session)
      lastModel.delete(session)
      failAt.delete(session)
      return { available: false, reason: 'not_found' }
    }
    const good = lastGood.get(session)
    const first = !failAt.has(session)
    failAt.set(session, now())
    if (good && opts.since === good.token && opts.before == null) return { available: true, file: good.file, session, token: good.token, unchanged: true }
    if (first) throw e
    throw new HerdrError('internal', 'Unable to read Devin conversation')
  }

  async function load(session: string, withImages = false): Promise<{ st: Awaited<ReturnType<typeof statFile>>, file: string, doc: AtifDoc } | null> {
    const file = pathOf(session)
    if (!file) return null
    const st = await statFile(file)
    const doc = await readDoc(file, st.size, genOf(st), withImages)
    return { st, file, doc }
  }

  async function chat(pane: TranscriptPane, opts: DevinOptions = {}): Promise<ChatResponse> {
    const session = pane.agentSession
    if (!session) return { available: false, reason: 'not_found' }
    const base = { available: true as const, session }
    if (quiet(session)) {
      const good = lastGood.get(session)
      if (good && opts.since === good.token && opts.before == null) return { ...base, file: good.file, token: good.token, unchanged: true }
      throw new HerdrError('internal', 'Unable to read Devin conversation')
    }
    try {
      const got = await load(session)
      if (!got) return { available: false, reason: 'not_found' }
      const { st, file, doc } = got
      failAt.delete(session)
      const fileId = path.basename(file)
      const gen = genOf(st)
      const from = opts.from === undefined ? null : opts.from
      const prev = headOf(opts.since)
      if (!opts.before && prev && prev.file === fileId && prev.size === st.size && prev.gen === gen) {
        const r = { ...base, file: fileId, token: opts.since, unchanged: true as const }
        return r
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
        const r = { ...base, file: fileId, older: true as const, items: [] as ChatItem[], start: 0, rewritten: true as const }
        return r
      }
      let rewritten = invalid
      let selected: Step[]
      let start: number
      let items: ChatItem[]
      if (before != null) {
        const end = before === 0 ? 0 : doc.steps.findIndex(s => Number(s.step_id) >= before)
        const slice = end < 0 ? doc.steps : doc.steps.slice(0, end)
        const page = takeVisible(slice, doc, PAGE_ITEMS)
        selected = page.steps
        start = page.start
        items = page.items
      } else if (from != null && !rewritten) {
        const lo = from === 0 ? 0 : doc.steps.findIndex(s => Number(s.step_id) >= from)
        selected = lo < 0 ? doc.steps : doc.steps.slice(lo)
        if (pageTooLarge(selected, maxPageBytes)) {
          rewritten = true
          const page = takeVisible(doc.steps, doc, PAGE_ITEMS)
          selected = page.steps
          start = page.start
          items = page.items
        } else {
          items = parseDevin(selected, doc.steps, doc.images, doc.results)
          start = selected[0] && selected.length < doc.steps.length ? Number(selected[0].step_id) || 0 : 0
        }
      } else {
        const page = takeVisible(doc.steps, doc, PAGE_ITEMS)
        selected = page.steps
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
        lastGood.set(session, { file: reply.file, token: reply.token })
        if (lastGood.size > 32) lastGood.delete(lastGood.keys().next().value!)
      }
      const model = latestModel(doc)
      lastModel.set(session, model ? { id: model, label: ompModelLabel(model) } : null)
      return reply
    } catch (e) {
      return failOpen(session, e, opts)
    }
  }

  async function image(pane: TranscriptPane, fileId: string | null, ref: string | null, index: number) {
    const m = /^(\d+):(u|a|r\d*|t\d+)$/.exec(ref || '')
    if (!pane.agentSession || !m || !Number.isSafeInteger(index) || index < 0) return null
    const got = await load(pane.agentSession, true).catch(e => { if (isMissing(e)) return null; throw e })
    if (!got || path.basename(got.file) !== fileId) return null
    const img = got.doc.images.get(ref!)?.[index]
    if (!img) return null
    let body: Buffer | null = null
    if (img.data) {
      if (img.data.length > 80 * 1024 * 1024) return null
      body = Buffer.from(img.data, 'base64')
    }
    if (!body || body.length > 60 * 1024 * 1024) return null
    const mime = img.mimeType.toLowerCase()
    return { type: IMAGE_TYPES.test(mime) ? mime : 'application/octet-stream', body }
  }

  async function search(pane: TranscriptPane, text: string, deadline: number) {
    if (!pane.agentSession || Date.now() >= deadline) return { hits: [], limited: Date.now() >= deadline, kind: 'devin' }
    const got = await load(pane.agentSession).catch(e => { if (isMissing(e)) return null; throw e })
    if (!got) return { hits: [], limited: false, kind: 'devin' }
    const hits = parseDevin(got.doc.steps, got.doc.steps, got.doc.images, got.doc.results).filter(i => i.role === 'user' || i.role === 'assistant').reverse().flatMap(i => {
      const at = matchAt(i.text, text)
      return at < 0 ? [] : [{ role: i.role, text: i.text.slice(0, 180), excerpt: excerpt(i.text, at, 120, text), ts: i.ts, offset: Number(i.ref!.split(':')[0]) }]
    }).slice(0, 8)
    return { hits, limited: Date.now() >= deadline, kind: 'devin' }
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
      const name = latestModel(got.doc)
      const info = name ? { id: name, label: ompModelLabel(name) } : null
      lastModel.set(session, info)
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

  return { chat, image, search, model, pathOf }
}
