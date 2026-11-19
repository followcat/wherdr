// Hermes Agent (NousResearch/hermes-agent) keeps its chats in `<HERMES_HOME>/state.db`
// (SQLite, WAL). Pure part of the reader: rows → chat items. Columns are read by
// name; a column an older schema lacks is simply undefined. `schema_version` is
// never consulted: Hermes only adds columns, so a newer or older database still reads.
import type { ChatItem } from '../../shared/types'
import { clip } from './transcriptText'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

// Every column this module reads (tests/hermesParse.test.ts checks them against
// Hermes' own schema).
export const HERMES_COLUMNS = {
  sessions: ['id', 'parent_session_id', 'end_reason', 'started_at', 'model'],
  messages: ['id', 'session_id', 'role', 'content', 'tool_call_id', 'tool_calls', 'tool_name', 'timestamp',
    'reasoning', 'reasoning_content', 'active', 'compacted', 'display_metadata', 'message_uid'],
  state_meta: ['key', 'value'],
} as const

export interface HermesSession { id: string, parent_session_id?: string | null, end_reason?: string | null, started_at?: number | null, model?: string | null }
export interface HermesMessage {
  id: number
  session_id: string
  role: string
  content?: string | null
  tool_call_id?: string | null
  tool_calls?: string | null
  tool_name?: string | null
  timestamp?: number | null
  reasoning?: string | null
  reasoning_content?: string | null
  active?: number | null
  compacted?: number | null
  display_metadata?: string | null
  message_uid?: string | null
}

// state_meta key of a local conversation's receipt: its current segment and lineage.
export const HERMES_POLICY_PREFIX = 'gateway.local_policy.v1:'
const JSON_PREFIX = '\x00json:'

function parseJson(s: unknown): unknown {
  if (typeof s !== 'string' || !s) return null
  try { return JSON.parse(s) } catch { return null }
}

// Segments of one conversation, oldest first. `receipt` is the state_meta value
// under HERMES_POLICY_PREFIX + id, when there is one; otherwise follow
// parent_session_id up while the parent ended by compression. Only the receipt
// crosses a /reset: without it, a reset child is its own conversation, as in
// Hermes' session picker.
export function hermesLineage(id: string, sessions: HermesSession[], receipt?: string | null): string[] {
  const r = parseJson(receipt) as Json | null
  const known = new Set(sessions.map(s => s.id))
  if (r && Array.isArray(r.lineage) && r.lineage.length && r.lineage.every((x: unknown) => typeof x === 'string' && known.has(x))) {
    return [...new Set(r.lineage as string[])]
  }
  const byId = new Map(sessions.map(s => [s.id, s]))
  const chain: string[] = []
  let cur = byId.get(id)
  while (cur && !chain.includes(cur.id)) {
    chain.unshift(cur.id)
    const parent = cur.parent_session_id ? byId.get(cur.parent_session_id) : undefined
    cur = parent?.end_reason === 'compression' ? parent : undefined
  }
  return chain
}

const modelOnly = (m: HermesMessage) => (parseJson(m.display_metadata) as Json | null)?.model_only === true

// Hermes' display rule, simplified: rows `active=1 OR compacted=1` (a rewind is
// active=0, compacted=0), no `model_only`, in `id` order, one per `message_uid`
// (position of its first copy, content of its newest); without a uid, one per row.
export function hermesVisible(rows: HermesMessage[]): HermesMessage[] {
  const sorted = rows
    .filter(m => (Number(m.active ?? 1) === 1 || Number(m.compacted ?? 0) === 1) && !modelOnly(m))
    .sort((a, b) => a.id - b.id)
  const out: HermesMessage[] = []
  const at = new Map<string, number>()
  for (const m of sorted) {
    const uid = m.message_uid
    const slot = uid ? at.get(uid) : undefined
    if (slot === undefined) {
      if (uid) at.set(uid, out.length)
      out.push(m)
    } else {
      out[slot] = { ...m, id: out[slot]!.id, session_id: out[slot]!.session_id }
    }
  }
  return out
}

// Text of `content`: a plain string, or "\x00json:" + JSON multimodal parts.
function contentOf(raw: unknown): { text: string, images: number } {
  if (typeof raw !== 'string') return { text: '', images: 0 }
  if (!raw.startsWith(JSON_PREFIX)) return { text: raw, images: 0 }
  const v = parseJson(raw.slice(JSON_PREFIX.length))
  if (typeof v === 'string') return { text: v, images: 0 }
  if (v === null) return { text: raw.slice(JSON_PREFIX.length), images: 0 }
  const parts = (Array.isArray(v) ? v : [v]) as Json[]
  const text = parts.map(p => (typeof p === 'string' ? p : p?.type === 'text' ? String(p.text || '') : '')).filter(Boolean).join('\n')
  const images = parts.filter(p => p && typeof p === 'object' && /^(?:image|image_url|input_image)$/.test(String(p.type))).length
  return { text, images }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const firstLine = (s: string) => s.split('\n').find(l => l.trim())?.trim() || ''

// One line for a call, from its arguments: the command, the path, the query…
export function hermesToolSummary(name: string, args: Json): string {
  for (const k of ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'goal', 'description', 'task', 'title']) {
    const v = str(args[k]).trim()
    if (v) return firstLine(v)
  }
  const v = Object.values(args).find(x => typeof x === 'string' && x.trim())
  return v ? firstLine(v as string) : name
}

interface Call { id: string, name: string, args: Json }
function callsOf(raw: unknown): Call[] {
  const list = parseJson(raw)
  if (!Array.isArray(list)) return []
  return list.filter(c => c && typeof c === 'object').map((c: Json) => {
    const fn = c.function || {}
    const args = typeof fn.arguments === 'string' ? parseJson(fn.arguments) : fn.arguments
    return { id: str(c.id), name: str(fn.name) || str(c.name) || 'Tool', args: args && typeof args === 'object' ? args as Json : {} }
  })
}

const iso = (t: unknown) => (typeof t === 'number' && Number.isFinite(t) ? new Date(t * 1000).toISOString() : null)

// Visible rows → chat items. A "Conversation cleared" line goes before the
// first row of a segment whose parent ended with /reset.
export function parseHermes(rows: HermesMessage[], sessions: HermesSession[] = []): ChatItem[] {
  const items: ChatItem[] = []
  const ended = new Map(sessions.map(s => [s.id, s.end_reason]))
  const resets = new Set(sessions.filter(s => s.parent_session_id && ended.get(s.parent_session_id) === 'session_reset').map(s => s.id))
  const results = new Map<string, HermesMessage>()
  for (const m of rows) if (m.role === 'tool' && m.tool_call_id && !results.has(m.tool_call_id)) results.set(m.tool_call_id, m)
  let segment: string | null = null
  for (const m of rows) {
    const ts = iso(m.timestamp)
    if (m.session_id !== segment) {
      if (segment !== null && resets.has(m.session_id)) items.push({ role: 'system', text: 'Conversation cleared', ts })
      segment = m.session_id
    }
    const ref = (slot: string) => `${m.id}:${slot}`
    const { text, images } = contentOf(m.content)
    if (m.role === 'user') {
      if (text || images) items.push({ role: 'user', text: clip(text), ts, ref: ref('u'), ...(images ? { images } : {}) })
      continue
    }
    if (m.role !== 'assistant') continue
    // A reasoning-only answer keeps `content` empty: it shows as thinking.
    const thinking = str(m.reasoning_content) || str(m.reasoning)
    if (thinking) items.push({ role: 'thinking', text: clip(thinking), ts, ref: ref('h') })
    if (text || images) items.push({ role: 'assistant', text: clip(text), ts, ref: ref('a'), ...(images ? { images } : {}) })
    for (const [n, call] of callsOf(m.tool_calls).entries()) {
      const hit = call.id ? results.get(call.id) : undefined
      const out = hit ? contentOf(hit.content).text : ''
      items.push({
        role: 'tool', name: call.name, text: clip(hermesToolSummary(call.name, call.args)), ts, ref: ref(`t${n}`),
        ...(out ? { out: clip(out) } : {}),
      })
    }
  }
  return items
}
