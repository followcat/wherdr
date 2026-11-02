import { parseClaudeScreen } from '../utils/claudeScreen'
import { parseDevinScreen } from '../utils/devinScreen'
import { devinFieldLine } from '../utils/unqueue'

// The agent's own "send now" drains its native queue, not wherdr's held
// messages. Re-read under the send lock: an old button must not submit a
// new draft.
export default defineApi(async (_event, b) => {
  if (!PANE_RE.test(b.pane_id || '')) throw new HerdrError('bad_pane', 'Invalid pane')
  await withPaneLock(b.pane_id, async () => {
    const p = findPane(b.pane_id)
    if (!p || p.stopped || p.leaving) throw new HerdrError('stale', 'The screen has changed — check the current screen.')
    // Claude's shortcut only exists on a turn's screen — checked cheaply,
    // before any read. Other agents than Devin's have no send-now at all.
    if (p.agent === 'claude' && p.status !== 'working') {
      throw new HerdrError('stale', 'The screen has changed — check the current screen.')
    }
    if (p.agent !== 'claude' && p.agent !== 'devin') throw new HerdrError('unsupported', 'This agent has no send-now')
    const r = await herdr('pane.read', { pane_id: b.pane_id, source: 'detection' }, 4000)
    if (p.agent === 'claude') {
      if (!parseClaudeScreen(r.read?.text)?.sendNow) {
        throw new HerdrError('stale', 'The screen has changed — check the current screen.')
      }
      await herdr('pane.send_input', { pane_id: b.pane_id, keys: ['ctrl+enter'] })
      return
    }
    // Devin's flush is Enter on the EMPTY field ("↵ send now" of its queue
    // header): with anything drafted it would submit that instead.
    if (!parseDevinScreen(r.read?.text)?.sendNow || devinFieldLine(r.read?.text) !== '') {
      throw new HerdrError('stale', 'The screen has changed — check the current screen.')
    }
    await herdr('pane.send_input', { pane_id: b.pane_id, keys: ['enter'] })
  })
  setTimeout(poll, 0)
  return { ok: true }
})
