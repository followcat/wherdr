import { usesTerminalException } from '../../shared/interactiveScreen'
import { isSlashCommand } from '../../shared/queuedMatch'

export default defineApi(async (event, b) => {
  if (!PANE_RE.test(b.pane_id || '')) throw new HerdrError('bad_pane', 'Invalid pane')
  // Text then keys, in two calls: in a single one, Herdr sends the keys first.
  // Not in the middle of another send of wherdr's (see guardedSend.ts).
  const held = await withPaneLock(b.pane_id, async () => {
    try {
      const now = findPane(b.pane_id)
      if (b.native) {
        const asked = now?.agent === 'claude' ? await transcripts.pendingClaudeQuestions(now).catch(() => []) : []
        const r = await herdr('pane.read', { pane_id: b.pane_id, source: 'detection' }, 4000)
        const text = r.read?.text
        const choices = screenChoices(text, now?.agent, asked)
        if (now?.stopped || now?.leaving || !b.identity || choices?.identity !== b.identity
          || usesTerminalException({ text: String(text || ''), agent: now?.agent, status: now?.status })) {
          throw new HerdrError('stale', 'The question has changed — check the current screen.')
        }
      }
      if (now?.stopped || now?.leaving) {
        // Old clients and other callers can still reach the raw route.
        // Preserve complete messages; never send raw keys or commands to a shell.
        if (typeof b.text !== 'string' || !b.text.trim() || isSlashCommand(b.text)
          || !Array.isArray(b.keys) || b.keys.length !== 1 || b.keys[0] !== 'enter') {
          throw new HerdrError('stale', now.stopped ? 'Restart Codex before sending a command.' : 'Codex just stopped. Try again in a few seconds.')
        }
        const q = addQueued(b.pane_id, b.text, { held: true })
        setTimeout(poll, 50)
        return q
      }
      // OpenCode blocked: its permission/question dialog owns the keys, and
      // older clients still route composer sends through this raw endpoint —
      // typing text + Enter there would answer it. Hold the message like a
      // prompt-route send would; a bare key press is refused outright.
      if (now?.agent === 'opencode' && now.status === 'blocked' && !b.native) {
        // Only a complete submission (text + Enter) is worth holding; a raw
        // draft or stray keys have nothing safe to do.
        if (typeof b.text !== 'string' || !b.text.trim() || isSlashCommand(b.text)
          || !Array.isArray(b.keys) || b.keys.length !== 1 || b.keys[0] !== 'enter') {
          throw new HerdrError('stale', 'OpenCode is asking something — answer it in its terminal.')
        }
        const q = addQueued(b.pane_id, b.text, { held: true })
        setTimeout(poll, 50)
        return q
      }
      // Devin's permission/question dialog replaces its composer while the
      // pane still reads "done" — the status check that covers OpenCode
      // can't see it. Older clients route composer sends through this raw
      // endpoint, so re-read the screen: no field means typed text + Enter
      // would answer the dialog. Hold the message like a prompt send would.
      if (now?.agent === 'devin' && !b.native) {
        const r = await herdr('pane.read', { pane_id: b.pane_id, source: 'detection' }, 4000)
        if (!inputVisible(r.read?.text, 'devin')) {
          if (typeof b.text !== 'string' || !b.text.trim() || isSlashCommand(b.text)
            || !Array.isArray(b.keys) || b.keys.length !== 1 || b.keys[0] !== 'enter') {
            throw new HerdrError('stale', 'Devin is asking something — answer it in its terminal.')
          }
          const q = addQueued(b.pane_id, b.text, { held: true })
          setTimeout(poll, 50)
          return q
        }
      }
      // Command Code reports no "blocked": a dialog, a "/" menu, or a draft
      // all read idle/unknown while owning the keys. Same re-read guard.
      if (now?.agent === 'cmd' && !b.native) {
        const r = await herdr('pane.read', { pane_id: b.pane_id, source: 'detection' }, 4000)
        if (!inputVisible(r.read?.text, 'cmd')) {
          if (typeof b.text !== 'string' || !b.text.trim() || isSlashCommand(b.text)
            || !Array.isArray(b.keys) || b.keys.length !== 1 || b.keys[0] !== 'enter') {
            throw new HerdrError('stale', 'Command Code is asking something — answer it in its terminal.')
          }
          const q = addQueued(b.pane_id, b.text, { held: true })
          setTimeout(poll, 50)
          return q
        }
      }
      if (typeof b.text === 'string' && b.text) await herdr('pane.send_input', { pane_id: b.pane_id, text: b.text })
      if (Array.isArray(b.keys) && b.keys.length) await herdr('pane.send_input', { pane_id: b.pane_id, keys: b.keys.map(String) })
    } finally {
      if (b.native) { choicesCache.delete(b.pane_id); setTimeout(poll, 0) }
    }
  })
  if (held) return { ok: true, queued: held }
  // Free-form answer to an agent (e.g. "Type something"): tracked like a message.
  const p = findPane(b.pane_id)
  if (p && p.agent && typeof b.text === 'string' && b.text.trim() && !isSlashCommand(b.text)) {
    const q = addQueued(b.pane_id, b.text)
    setTimeout(poll, 50)
    return { ok: true, queued: q }
  }
  return { ok: true }
})
