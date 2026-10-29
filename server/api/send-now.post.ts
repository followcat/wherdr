import { parseClaudeScreen } from '../utils/claudeScreen'

// Claude's shortcut drains its native queue, not wherdr's held messages.
// Re-read under the send lock: an old button must not submit a new draft.
export default defineApi(async (_event, b) => {
  if (!PANE_RE.test(b.pane_id || '')) throw new HerdrError('bad_pane', 'Invalid pane')
  await withPaneLock(b.pane_id, async () => {
    const p = findPane(b.pane_id)
    if (!p || p.agent !== 'claude' || p.status !== 'working' || p.stopped || p.leaving) {
      throw new HerdrError('stale', 'The screen has changed — check the current screen.')
    }
    const r = await herdr('pane.read', { pane_id: b.pane_id, source: 'detection' }, 4000)
    if (!parseClaudeScreen(r.read?.text)?.sendNow) {
      throw new HerdrError('stale', 'The screen has changed — check the current screen.')
    }
    await herdr('pane.send_input', { pane_id: b.pane_id, keys: ['ctrl+enter'] })
  })
  setTimeout(poll, 0)
  return { ok: true }
})
