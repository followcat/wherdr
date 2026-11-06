import type { ChatItem, ChatResponse, CommandCodeToolUpdate } from '#shared/types'

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

// Command Code late outcomes (ChatResponse.toolUpdates): a tool result
// appended after its call was shown arrives as an update matched by toolId.
// `at` is the absolute byte offset of the result it comes from — its
// revision: an older or an unknown revision never downgrades a newer known
// one. Anything else counts as no revision at all.
const toolRev = (x: number | undefined): number | null =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : null

// `inc` (later arrival) wins over `cur`, unless `cur`'s revision is known to
// be strictly newer. An equal revision takes the later arrival — the record
// at that byte may have been rewritten since.
const pickUpdate = (inc: CommandCodeToolUpdate, cur: CommandCodeToolUpdate): CommandCodeToolUpdate => {
  const ri = toolRev(inc.at); const rc = toolRev(cur.at)
  return rc !== null && (ri === null || ri < rc) ? cur : inc
}

// Apply updates to the items whose toolId matches — immutably: an item with
// nothing to apply keeps its identity, and so does the whole array, so Vue
// re-renders nothing. An applied update replaces the item's whole outcome —
// out, error, images, ref, imageAt and hashes are cleared first, then the
// update's own fields land (empty output, a false error, zero images/index
// are clears) — and toolAt takes the revision the outcome came from.
export function applyToolUpdates(items: ChatItem[], updates: CommandCodeToolUpdate[] | undefined): ChatItem[] {
  if (!updates?.length || !items.length) return items
  const byId = new Map<string, CommandCodeToolUpdate>()
  for (const u of updates) byId.set(u.id, byId.has(u.id) ? pickUpdate(u, byId.get(u.id)!) : u)
  let changed = false
  const next = items.map((it) => {
    const u = it.toolId ? byId.get(it.toolId) : undefined
    if (!u) return it
    const ru = toolRev(u.at); const ri = toolRev(it.toolAt)
    if (ri !== null && (ru === null || ru < ri)) return it
    const toolAt = ru ?? it.toolAt
    const out = u.out || undefined
    const error = u.error ? true : undefined
    const images = u.images || undefined
    const ref = images && u.ref ? u.ref : undefined
    const imageAt = images && u.imageAt ? u.imageAt : undefined
    // The normalized outcome is already what the item shows (a repeated
    // reply, the same byte re-sent): nothing to redo — same item, and the
    // same array if every item says so. Present hashes still must clear.
    if (it.toolAt === toolAt && it.out === out && it.error === error && it.images === images
      && it.ref === ref && it.imageAt === imageAt && it.hashes === undefined) return it
    changed = true
    const n: ChatItem = { ...it, toolAt }
    delete n.out; delete n.error; delete n.images; delete n.ref; delete n.imageAt; delete n.hashes
    if (out) n.out = out
    if (error) n.error = true
    if (images) {
      n.images = images
      if (ref) n.ref = ref
      if (imageAt) n.imageAt = imageAt
    }
    return n
  })
  return changed ? next : items
}

// The effective outcome set of a reply: its updates merged with the outcomes
// still pending, once, the newest revision per id — so a call only now
// becoming visible (an older page arriving after the result) receives the
// remembered outcome, not just what this one response carried.
export function mergeToolUpdates(pending: ReadonlyMap<string, CommandCodeToolUpdate>, updates: CommandCodeToolUpdate[] | undefined): CommandCodeToolUpdate[] {
  const byId = new Map<string, CommandCodeToolUpdate>()
  for (const u of pending.values()) byId.set(u.id, u)
  for (const u of updates ?? []) byId.set(u.id, byId.has(u.id) ? pickUpdate(u, byId.get(u.id)!) : u)
  return [...byId.values()]
}

// After the merged set was applied to every item list shown (the tail and
// the retained older pages — one list alone must never satisfy a result):
// an update whose call is visible at an equal or newer toolAt is done and
// removed; the rest stay pending for the page still in flight — an older
// response cannot delete a newer pending result just because its call has
// appeared. Bounded at 256 ids, oldest insertion first, like the server's.
export function retainToolUpdates(pending: Map<string, CommandCodeToolUpdate>, itemLists: readonly ChatItem[][], updates: CommandCodeToolUpdate[] | undefined): void {
  if (!updates?.length) return
  for (const u of updates) {
    const cur = pending.get(u.id)
    const u2 = cur ? pickUpdate(u, cur) : u
    const ru = toolRev(u2.at)
    const satisfied = ru !== null && itemLists.some(list => list.some((it) => {
      if (it.toolId !== u2.id) return false
      const ri = toolRev(it.toolAt)
      return ri !== null && ri >= ru
    }))
    if (satisfied) { pending.delete(u.id); continue }
    pending.set(u.id, u2)
    if (pending.size > 256) pending.delete(pending.keys().next().value!)
  }
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
export function restartsTail(c: { file: string | null, tailStart: number | null }, r: Pick<ChatResponse, 'file' | 'start' | 'rewritten'>): boolean {
  return Boolean(c.file && r.file !== c.file)
    || Boolean(c.file && r.rewritten)
    || (c.tailStart !== null && r.start !== undefined && r.start !== c.tailStart)
}

// Query of a re-read of the bottom: the token and item count of the list held
// here let the server send only what changed.
// `n` also tells the server this client splices incremental replies (other
// readers of /api/chat, such as plugins, get full lists and are not remembered).
export function tailQuery(pane: string, c: { token: string, tailStart: number | null, tail: ChatItem[] }): URLSearchParams {
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
