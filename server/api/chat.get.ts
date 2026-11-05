import { chatDelta } from '../utils/chatDelta'
export default defineApi(async (event) => {
  const q = getQuery(event)
  const p = findPane(String(q.pane || ''))
  if (!p) throw new HerdrError('bad_pane', 'Pane not found')
  const num = (k: string) => (q[k] !== undefined ? Math.max(0, Number(q[k]) || 0) : null)
  // Messages taken back after a Stop (see interruptRestore.ts): hidden, and
  // part of the token so that the view reloads when one is added.
  const { hidden, seq } = takenBackOf(p.id)
  const mark = hidden.length ? `~${seq}` : ''
  // Token sent back by the client: the transcript's token, the taken-back
  // mark, then the fingerprint of the list it holds (see chatDelta.ts).
  // A fingerprinted token the server does not remember with that count (server
  // restarted, list forgotten, other count) counts as no token: full list.
  const sent = String(q.since || '')
  const count = num('n')
  const since = chatDelta.sinceOf(p.id, sent, count)
  const from = num('from')
  // A Command Code reply is bound to the generation it read: the awaited
  // steps below (upload hashes, model) can observe a rewrite that detaches
  // it. Re-check the reply's own context after them — one re-issue under
  // the generation now current; a repeated detach is a read error, never
  // the detached body.
  for (let attempt = 0; ; attempt++) {
    const r = await transcripts.chat(p, {
      since: mark ? (since.endsWith(mark) ? since.slice(0, -mark.length) : '') : since,
      from, // re-read from this byte (bottom of the conversation already shown)
      anchor: sent, // join check above `from`, even for a list the server forgot
      before: num('before'), // older slice, ending at this byte
    })
    if (r.token) r.token += mark
    if (r.unchanged) r.token = sent
    if (r.items) {
      r.items = chatPasted(withoutTakenBack(r.items, hidden))
      await addUploadHashes(r.items)
    }
    // Current model ("Opus 5.5", "GPT-6-Sol"): cached by transcript state. Not read
    // for an unchanged reply (most polls): the client keeps what it has.
    const model = r.available && !r.unchanged ? await currentModel(p).catch(() => null) : undefined
    // The selection check is a real awaited lookup; the generation check
    // after it is the reply's own origin-bound predicate, synchronous, so
    // nothing can interleave before the delta registration and the return.
    const cur = r.available && !r.unchanged ? await transcripts.current(p, r) : null
    // The selection moved or is gone: never authorize the prior file's reply.
    if (cur === 'gone') return { available: false, reason: 'not_found' }
    if (cur === 'stale' || transcripts.live(p, r) === false) {
      if (attempt < 1) continue
      throw new Error('command code transcript generation changed')
    }
    if (r.items) {
      // Bottom of the conversation: only what changed since the client's list
      // when the server still knows it (`n`: the number of items it holds).
      // Registered after the currency check: a stale list is never remembered
      // as one the client could hold.
      if (r.token && !r.older) {
        const d = chatDelta.reply(p.id, r.token, r.items, sent, count, from !== null && r.start === from && !r.rewritten)
        r.token = d.token
        r.items = d.items
        if (d.keep !== undefined) r.keep = d.keep
      }
    }
    return model === undefined ? r : { ...r, model }
  }
})
