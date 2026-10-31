import type { QueuedMessage } from '../../shared/types'
import type { GuardError } from '../utils/guardedSend'
import { closeTrailingMention } from '../../shared/attachments'
import { isSlashCommand } from '../../shared/queuedMatch'
import { possibleSubmitKey } from '../../shared/submitKeys'

export default defineApi(async (event, b) => {
  if (typeof b.client_id === 'string' && /^w-[a-z0-9]{1,32}$/.test(b.client_id) && PANE_RE.test(b.pane_id || '')) {
    return promptOnce(b.pane_id, b.client_id, String(b.text || ''), async () => await submitPrompt(event, b))
  }
  return submitPrompt(event, b)
})

const submitPrompt: Parameters<typeof defineApi<{ ok: boolean, queued?: QueuedMessage }>>[0] = async (event, b) => {
  if (!PANE_RE.test(b.pane_id || '')) throw new HerdrError('bad_pane', 'Invalid pane')
  // Attached text file last (`@<path>`): see closeTrailingMention.
  const text = closeTrailingMention(String(b.text || ''))
  if (!text.trim()) throw new HerdrError('empty', 'Empty message')
  // The app's id for the bubble it shows from the tap (see app/utils/outbox.ts).
  const id = typeof b.client_id === 'string' ? b.client_id : undefined
  // "Send with <key>": a terminator the agent is known to take (see
  // shared/submitKeys.ts), kept on the record so holds and retries keep it.
  // Whether it applies is decided at delivery (sendPrompt).
  const key = typeof b.submit_key === 'string' && b.submit_key ? b.submit_key : undefined
  const submitKey = key && !isSlashCommand(text) && possibleSubmitKey(findPane(b.pane_id)?.agent, key) ? key : undefined
  // Where its pasted texts sit: kept, to show them as cards on every device.
  if (!isSlashCommand(text)) keepPastes(text, b.pastes)
  // A restart owns the lock for its whole sequence. Holding a message does
  // not write to the pane, so do it immediately instead of timing out behind it.
  if (restarting(b.pane_id) && !isSlashCommand(text)) {
    const q = addQueued(b.pane_id, text, { held: true, id, submitKey })
    setTimeout(poll, 50)
    return { ok: true, queued: q }
  }
  const held = await withPaneLock(b.pane_id, async () => {
    const now = findPane(b.pane_id)
    if (!now?.stopped && !now?.leaving) return null
    if (isSlashCommand(text)) throw new HerdrError('stale', now.stopped ? 'Restart Codex before sending a command.' : 'Codex just stopped. Try again in a few seconds.')
    const q = addQueued(b.pane_id, text, { held: true, id, submitKey })
    setTimeout(poll, 50)
    return q
  })
  if (held) return { ok: true, queued: held }
  if (await withPaneLock(b.pane_id, () => findPane(b.pane_id)?.stopped
    ? Promise.resolve(false) : closePanel(b.pane_id).catch(() => false))) log(`panel closed before sending on ${b.pane_id}`)
  // A menu or panel still hides the input field (interactive /mcp flow…), or an
  // earlier message is held: typed now, the message would be lost. Held, it is
  // delivered on a later poll once the input is back (see state.ts deliverHeld).
  // Photos sent alone start with their path: a message, not a "/" command.
  const p = findPane(b.pane_id)
  // Restart / Codex update running: it owns the pane until the agent is back.
  if (p && p.agent && restarting(p.id) && !isSlashCommand(text)) {
    const q = addQueued(b.pane_id, text, { held: true, id, submitKey })
    log(`prompt ${b.pane_id}: restart in progress, message held`)
    setTimeout(poll, 50)
    return { ok: true, queued: q }
  }
  if (p && !isSlashCommand(text)) {
    const earlier = hasHeld(b.pane_id)
    const input = earlier || !INPUT_STATES.has(p.status || '') ? true
      : await herdr('pane.read', { pane_id: b.pane_id, source: 'detection' }, 4000)
        .then(r => inputVisible(r.read && r.read.text), () => true)
    if (shouldHold(p.agent, p.status, input, earlier)) {
      // Behind a message waiting for the turn's end: waits for it too.
      const q = addQueued(b.pane_id, text, { held: true, id, submitKey, turn: inTurn(b.pane_id) })
      log(`prompt ${b.pane_id}: input field hidden, message held`)
      setTimeout(poll, 50)
      return { ok: true, queued: q }
    }
  }
  const typedAt = Date.now()
  try {
    if (p) await sendPrompt(p, text, { submitKey })
    else await agentPrompt(b.pane_id, text)
  } catch (e) {
    // Claude's input field holds someone else's text (a draft typed in its
    // terminal…), never cleared: the message waits until it is free.
    const typed = (e as GuardError).typed ? typedAt : undefined
    if (isBusyError(e) && !(e as GuardError).typed && !isSlashCommand(text)) {
      const q = addQueued(b.pane_id, text, { held: true, busy: (e as HerdrError).code === 'input_busy', id, submitKey, typedAt: typed, turn: inTurn(b.pane_id) })
      log(`prompt ${b.pane_id}: input field not free, message held`)
      setTimeout(poll, 50)
      return { ok: true, queued: q }
    }
    // Typed but not confirmed as taken (see guardedSend.ts): kept, shown as
    // not sent with Retry / Cancel, never silently dropped. If the agent takes
    // it late after all, its transcript clears it (see reconcileQueued).
    if (e instanceof HerdrError && ['not_shown', 'not_submitted', 'clear_failed', 'input_contended', 'bash_mode', 'no_input', 'input_busy'].includes(e.code) && !isSlashCommand(text)) {
      const q = addQueued(b.pane_id, text, { failed: true, id, submitKey, typedAt: typed })
      log(`prompt ${b.pane_id}: ${e.message}, message kept as not sent`)
      setTimeout(poll, 50)
      return { ok: true, queued: q }
    }
    // Agent launched less than 3 s ago, which Herdr still considers "starting"
    // (see agentPrompt): the message goes out as soon as Herdr accepts it,
    // like the first message given at creation. Not for a command, nor
    // on top of another message already waiting.
    // Herdr sees the open menu as blocked and refuses the prompt: held too,
    // delivered once the menu is answered or closed.
    if (e instanceof HerdrError && e.code === 'agent_blocked' && p && p.agent && HOLD_AGENTS.has(p.agent) && !isSlashCommand(text)) {
      const q = addQueued(b.pane_id, text, { held: true, id, submitKey })
      log(`prompt ${b.pane_id}: agent blocked, message held`)
      setTimeout(poll, 50)
      return { ok: true, queued: q }
    }
    if (!(e instanceof HerdrError) || e.code !== 'agent_not_ready' || isSlashCommand(text) || pendingPrompts.has(b.pane_id)) throw e
    pendingPrompts.set(b.pane_id, { text, at: Date.now(), submitKey })
    log(`prompt ${b.pane_id}: agent not ready for Herdr yet, queued`)
  }
  // Commands (/compact…) are not messages: no bubble.
  // An interactive menu (/resume, /model…) may open: screen watched.
  if (isSlashCommand(text)) {
    watchScreen(b.pane_id)
    setTimeout(poll, 1500)
    return { ok: true }
  }
  const q = addQueued(b.pane_id, text, { id, typedAt, submitKey })
  setTimeout(poll, 50)
  return { ok: true, queued: q }
}
