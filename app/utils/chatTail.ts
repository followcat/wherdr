import type { ChatCursor, ChatItem, ChatResponse } from '#shared/types'

export const hasOlder = (cursor: ChatCursor | null): boolean => typeof cursor === 'string' ? cursor.length > 0 : typeof cursor === 'number' && cursor > 0
export function olderCursor(r: Pick<ChatResponse, 'olderCursor' | 'start'>, before?: ChatCursor | null): ChatCursor | null {
  const next = r.olderCursor !== undefined ? r.olderCursor : r.start ?? null
  if (!hasOlder(next) || next === before) return null
  if (typeof next === 'number' && typeof before === 'number' && next >= before) return null
  return next
}

// Bottom of the conversation after a re-read. With `keep` (incremental reply,
// see server/utils/chatDelta.ts) the first `keep` items stay as they are (same
// objects, so Vue has nothing to redo for them) and the reply's items replace
// the rest. null: the reply does not fit the list held here, reload in full.
export function nextTail(tail: ChatItem[], r: Pick<ChatResponse, 'items' | 'keep'>): ChatItem[] | null {
  const items = r.items || []
  if (r.keep === undefined) return items
  if (!Number.isInteger(r.keep) || r.keep < 0 || r.keep > tail.length) return null
  return r.keep === tail.length && !items.length ? tail : tail.slice(0, r.keep).concat(items)
}

// Whether a reply means starting again from the bottom, dropping the older
// pages loaded above: another file (/clear, new session), or a bottom the
// server read from another byte. The latter happens when the file grew more
// than 24 MB past our start (the server then reads back from the end) or
// became shorter than our start; the older pages would not join the new
// bottom. Keeping them across a 24 MB jump would need each message's byte
// position (left for later): the reading position is lost in that case.
// `rewritten`: the file was rewritten above our start (same size or shorter,
// see anchorOf in server/utils/transcripts.ts), even if the new bottom happens
// to start at the same byte.
export function restartsTail(c: { file: string | null, tailStart: ChatCursor | null }, r: Pick<ChatResponse, 'file' | 'start' | 'rewritten'>): boolean {
  return Boolean(c.file && r.file !== c.file)
    || Boolean(c.file && r.rewritten)
    || (c.tailStart !== null && r.start !== undefined && r.start !== c.tailStart)
}

// Query of a re-read of the bottom: the token and item count of the list held
// here let the server send only what changed.
// `n` also tells the server this client splices incremental replies (other
// readers of /api/chat, such as plugins, get full lists and are not remembered).
export function tailQuery(pane: string, c: { token: string, tailStart: ChatCursor | null, tail: ChatItem[] }): URLSearchParams {
  const q = new URLSearchParams({ pane, since: c.token })
  if (c.tailStart !== null) q.set('from', String(c.tailStart))
  q.set('n', String(c.token ? c.tail.length : 0))
  return q
}

// One re-read of the bottom at a time, for its whole life. `step` returns
// true to run again at once (session changed, delta did not fit), up to `max`
// steps, still holding the lock: a polling tick or a return to the app during
// those steps starts nothing. `invalidate()` (another pane) lets a new load
// start at once; the step still in flight then sees `current()` turn false
// and drops its reply, even if it comes back after the new one.
export function createTailLoader(step: (current: () => boolean) => Promise<boolean>, max = 3) {
  let gen = 0
  let running: number | null = null
  async function load(): Promise<void> {
    if (running === gen) return
    const g = gen
    running = g
    const current = () => g === gen
    try {
      for (let k = 0; k < max && current(); k++) if (!await step(current)) break
    } finally { if (running === g) running = null }
  }
  return { load, invalidate: () => { gen++ } }
}
