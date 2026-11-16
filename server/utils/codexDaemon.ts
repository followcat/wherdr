import path from 'node:path'
import { createHash, randomInt } from 'node:crypto'
import type { ChatItem, ChatResponse } from '../../shared/types'
import type { TranscriptPane } from './transcripts'
import type { CodexRpc } from './codexDaemonRpc'
import { codexModelLabel } from './models'
import { clip, isNoise } from './transcriptText'

interface Thread {
  id: string
  name: string | null
  cwd: string
  parentThreadId?: string | null
  historyMode: string
  model?: string | null
  reasoningEffort?: string | null
}
interface Entry {
  startedAtMs?: number | null
  completedAtMs?: number | null
  item: {
    id: string, type: string, text?: string, command?: string, exitCode?: number | null,
    content?: { type: string, text?: string }[], arguments?: unknown,
    tool?: string, error?: unknown, success?: boolean, status?: string,
    changes?: { path: string }[],
  }
}
interface Page<T> { data: T[], nextCursor?: string | null }
interface Options { since?: string, from?: number | null, before?: number | null, signal?: AbortSignal }
export interface CodexHistory { chat: (pane: TranscriptPane, options?: Options) => Promise<ChatResponse | null> }
interface Cursor { thread: string, cursor: string, anchor: string | undefined }
interface Pin { identity: string, bornAt?: number, thread: Thread, last: ChatResponse }
const replyKeys = new WeakMap<ChatItem, string>()
export const codexDaemonReplyKey = (item: ChatItem) => replyKeys.get(item)
const clean = (value: string | null | undefined) => (value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim()

export function codexPaneName(pane: TranscriptPane) {
  const title = clean(pane.title)
  const suffix = ` | ${path.basename(pane.cwd || '')}`
  const name = title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title
  return name && !['codex', 'Codex', 'GPT', path.basename(pane.cwd || '')].includes(name) ? name : null
}
export function codexHistoryItems(entries: Entry[]): ChatItem[] {
  const result: ChatItem[] = []
  for (const entry of entries) {
    const item = entry.item
    const time = entry.startedAtMs ?? entry.completedAtMs
    const ts = time != null && Number.isFinite(time) ? new Date(time).toISOString() : null
    if (item.type === 'userMessage') {
      const text = (item.content || []).filter(p => p.type === 'text').map(p => p.text || '').join('\n').trim()
      if (text && !isNoise(text)) result.push({ role: 'user', text: clip(text), ts })
    } else if (item.type === 'agentMessage' && item.text?.trim()) {
      const reply: ChatItem = { role: 'assistant', text: clip(item.text), ts }
      replyKeys.set(reply, `codex-daemon:${item.id}`)
      result.push(reply)
    } else if (item.type === 'commandExecution') {
      result.push({ role: 'tool', name: 'shell', text: clip(item.command || '', 300), ts, error: item.exitCode != null && item.exitCode !== 0 })
    } else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
      result.push({ role: 'tool', name: item.tool || 'tool', text: clip(JSON.stringify(item.arguments ?? {}), 300), ts, error: Boolean(item.error) || item.success === false })
    } else if (item.type === 'fileChange') {
      result.push({ role: 'tool', name: 'apply_patch', text: clip((item.changes || []).map(c => c.path).join(', '), 300), ts, error: item.status === 'failed' })
    }
  }
  return result
}

export function createCodexDaemonHistory({ rpc, now = Date.now }: { rpc: CodexRpc, now?: () => number }): CodexHistory {
  const lists = new Map<string, { at: number, data: Thread[] }>()
  const pins = new Map<string, Pin>()
  const cursors = new Map<number, Cursor>()
  const cursorIds = new Map<string, number>()
  // Do not reuse another reader process's numeric cursor ids after a restart.
  let sequence = randomInt(1, 2 ** 47)
  async function threads(cwd: string, signal?: AbortSignal) {
    const hit = lists.get(cwd)
    if (hit && now() - hit.at < 2000) return hit.data
    let cursor: string | null = null
    const found: Thread[] = []
    do {
      signal?.throwIfAborted()
      const page = await rpc('thread/list', { cwd, cursor, limit: 100, useStateDbOnly: true }, signal) as Page<Thread>
      found.push(...page.data)
      cursor = page.nextCursor || null
      // An incomplete inventory cannot establish uniqueness.
      if (found.length >= 1000 && cursor) return []
    } while (cursor)
    if (lists.size >= 64) lists.clear()
    lists.set(cwd, { at: now(), data: found })
    return found
  }
  async function resolve(pane: TranscriptPane, signal?: AbortSignal, pinned?: Thread) {
    const id = pinned?.id || pane.agentSession
    if (id) {
      const value = (await rpc('thread/read', { threadId: id, includeTurns: false }, signal) as { thread: Thread }).thread
      return value.id === id && value.cwd === pane.cwd ? value : null
    }
    const name = codexPaneName(pane)
    if (!name || !pane.cwd) return undefined
    const matches = (await threads(pane.cwd, signal)).filter(t => t.cwd === pane.cwd && !t.parentThreadId && clean(t.name) === name)
    return matches.length === 1 ? matches[0]! : null
  }
  function remember(thread: string, cursor: string | null | undefined, anchor: string | undefined) {
    if (!cursor) return 0
    const key = `${thread}|${cursor}`
    if (cursorIds.has(key)) return cursorIds.get(key)!
    const id = ++sequence
    cursors.set(id, { thread, cursor, anchor })
    cursorIds.set(key, id)
    if (cursors.size > 512) {
      const oldest = cursors.keys().next().value!
      const old = cursors.get(oldest)!
      cursorIds.delete(`${old.thread}|${old.cursor}`)
      cursors.delete(oldest)
    }
    return id
  }
  async function readChat(pane: TranscriptPane, options: Options, pinned?: Thread): Promise<{ response: ChatResponse, thread: Thread } | null> {
    options.signal?.throwIfAborted()
    const thread = await resolve(pane, options.signal, pinned)
    options.signal?.throwIfAborted()
    // No unique match is not evidence that the existing JSONL reader has none.
    if (!thread || thread.historyMode !== 'paginated') return null
    const done = (response: ChatResponse) => ({ response, thread })
    const file = `codex-daemon-${thread.id}.jsonl`
    const base = {
      available: true, file, session: thread.id, guessed: !pane.agentSession, cursorKind: 'opaque' as const,
      model: thread.model ? { id: thread.model, label: codexModelLabel(thread.model), effort: thread.reasoningEffort } : undefined,
    }
    const before = options.before == null ? null : cursors.get(options.before)
    if (options.before != null && (!before || before.thread !== thread.id)) return done({ ...base, reload: true })
    const from = options.from == null ? null : cursors.get(options.from)
    const anchor = from?.thread === thread.id ? from.anchor : null
    let cursor = before?.cursor ?? null
    let entries: Entry[] = []
    let nextCursor: string | null = null
    for (let pageNumber = 0; ; pageNumber++) {
      const page = await rpc('thread/items/list', { threadId: thread.id, cursor, limit: 100, sortDirection: 'desc' }, options.signal) as Page<Entry>
      entries.push(...page.data)
      nextCursor = page.nextCursor || null
      cursor = nextCursor
      if (!anchor || entries.some(e => e.item.id === anchor) || !nextCursor) break
      if (pageNumber >= 19) return done({ ...base, reload: true })
    }
    entries.reverse()
    const at = anchor ? entries.findIndex(e => e.item.id === anchor) : -1
    if (at >= 0) entries = entries.slice(at)
    const items = codexHistoryItems(entries)
    const start = at >= 0 ? options.from! : remember(thread.id, nextCursor, entries[0]?.item.id)
    const digest = createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 24)
    if (options.before != null) return done({ ...base, older: true, items, start })
    const token = `${file}:${start}:${digest}`
    if (options.since === token) return done({ ...base, unchanged: true, token })
    return done({
      ...base, token, items, start, queue: [],
      rewritten: options.from != null && options.from !== start,
    })
  }
  async function chat(pane: TranscriptPane, options: Options = {}): Promise<ChatResponse | null> {
    options.signal?.throwIfAborted()
    // A spinner changing does not select a different thread. This only keeps
    // an already-established binding; initial lookup still requires an exact name.
    const name = codexPaneName(pane)?.replace(/^[\u2800-\u28ff\u25d0-\u25d3]\s*/, '')
    const identity = JSON.stringify([pane.cwd, pane.agentSession || null, pane.agentSession ? null : name])
    let pin = pins.get(pane.id)
    const sameBirth = pin && (pin.bornAt == null || pane.bornAt == null || pin.bornAt === pane.bornAt)
    const sameContext = pin && sameBirth && pane.cwd === pin.thread.cwd && (pane.agentSession
      ? pane.agentSession === pin.thread.id
      : !name || pin.identity === identity || name === clean(pin.thread.name))
    if (!sameContext) { pins.delete(pane.id); pin = undefined }
    const stale = (): ChatResponse | null => pin ? {
      ...pin.last, stale: true,
      // Existing readers keep their exact tail and older pages; a new reader
      // gets the last known snapshot, including stable reply identities.
      ...(options.from != null || options.since || options.before != null
        ? { unchanged: true, items: undefined, token: options.since || pin.last.token } : {}),
    } : null
    const stop = new AbortController()
    const timer = setTimeout(() => stop.abort(new Error('Codex history budget exceeded')), 3000)
    const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal
    try {
      const result = await readChat(pane, { ...options, since: pin ? options.since : undefined, signal }, pin?.thread)
      if (!result) return stale()
      const { response, thread } = result
      if (response.items && !response.older && !response.reload) {
        if (pins.size >= 128 && !pins.has(pane.id)) pins.delete(pins.keys().next().value!)
        pins.set(pane.id, { identity, bornAt: pane.bornAt, thread, last: { ...response } })
      } else if (pin && response.unchanged) {
        pins.set(pane.id, { ...pin, thread, last: { ...pin.last, model: response.model, guessed: response.guessed } })
      }
      return response
    }
    catch {
      // Before binding, the optional daemon must not hide an existing JSONL
      // conversation. After binding, a failed read must not switch its source.
      options.signal?.throwIfAborted()
      return stale()
    }
    finally { clearTimeout(timer) }
  }
  return { chat }
}
