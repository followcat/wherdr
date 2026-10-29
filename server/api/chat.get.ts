import { fmt } from '../../shared/message'
import { integrationCommand, missingIntegration } from '../../shared/integrations'
import { integrationStatus } from '../utils/integrations'
import { multiMachine } from '../utils/machines'
import { chatDelta } from '../utils/chatDelta'
export default defineApi(async (event) => {
  const q = getQuery(event)
  const p = findPane(String(q.pane || ''))
  if (!p) throw new HerdrError('bad_pane', 'Pane not found')
  // Machine distante injoignable : ses transcriptions aussi (lues par SSH).
  const m = machineOfPane(p.id)
  if (m && !m.local && m.status !== 'online') throw new HerdrError('unreachable', fmt('{machine} is unreachable', { machine: m.label }))
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
  const cursor = (k: string) => p.agent === 'opencode' && typeof q[k] === 'string' ? String(q[k]).slice(0, 256) : num(k)
  const from = cursor('from')
  const r = await transcripts.chat(p, {
    since: mark ? (since.endsWith(mark) ? since.slice(0, -mark.length) : '') : since,
    from, // re-read from this byte (bottom of the conversation already shown)
    anchor: sent, // join check above `from`, even for a list the server forgot
    before: cursor('before'), // native page cursor or legacy byte boundary
  })
  // Not found because Herdr's integration of this agent is missing: say so,
  // with the command (a fresh agent keeps "No conversation yet").
  if (!r.available && r.reason === 'not_found' && m && p.agent && !p.agentSession
    && missingIntegration(p, await integrationStatus(m), m.transcripts.wasActive(p.id, p.agent))) {
    return { ...r, reason: 'no_integration', integration: { agent: p.agent, command: integrationCommand(p.agent), machine: multiMachine() ? m.label : null } }
  }
  if (r.token) r.token += mark
  if (r.unchanged) r.token = sent
  if (r.items) {
    r.items = chatPasted(withoutTakenBack(r.items, hidden))
    await addUploadHashes(r.items)
    // Bottom of the conversation: only what changed since the client's list
    // when the server still knows it (`n`: the number of items it holds).
    if (r.token && !r.older) {
      const d = chatDelta.reply(p.id, r.token, r.items, sent, count, from !== null && r.start === from && !r.rewritten)
      r.token = d.token
      r.items = d.items
      if (d.keep !== undefined) r.keep = d.keep
    }
  }
  if (r.queue && r.queue.length) r.queue = withSentText(p.id, r.queue)
  // Current model ("Opus 5.5", "GPT-6-Sol"): cached by file size.
  return r.available ? { ...r, model: await currentModel(p).catch(() => null) } : r
})
