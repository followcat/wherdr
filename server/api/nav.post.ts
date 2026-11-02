// Computer keyboard on a "Your turn" card (interactive menu, choice
// prompt): ↑ ↓ Enter Escape sent as is to the terminal, like the key
// bar. Arrows use the displayed card; confirming keys re-read the screen. Enter
// is never sent to a menu where it is not a simple choice (/model:
// "set as default"). ← →: between the tabs of omp's "Ask" box, or between
// OpenCode's permission buttons. The state is broadcast again right after
// (screen re-read).
import { TOP, clickMovesOnly } from '../../shared/menuScreen'

const KEYS = new Set(['up', 'down', 'enter', 'esc', 'left', 'right'])

export default defineApi(async (event, b) => {
  if (!PANE_RE.test(b.pane_id || '')) throw new HerdrError('bad_pane', 'Invalid pane')
  const pane: string = b.pane_id
  if (findPane(pane)?.stopped) throw new HerdrError('stale', 'Use the restart buttons for this stopped agent.')
  const key = String(b.key || '')
  if (!KEYS.has(key)) throw new HerdrError('bad_request', 'Invalid key')
  try {
    // Arrows cannot confirm a choice. Use the published card to avoid queued
    // detection reads before sending; Enter still validates the live screen.
    const shown = findPane(pane)
    // A horizontal prompt (OpenCode permission) only moves with ←/→.
    const arrow = shown?.prompt?.horizontal
      ? key === 'left' || key === 'right'
      : key === 'up' || key === 'down'
    if (arrow && shown && !shown.leaving && shown.status !== 'working'
      && !shown.menu?.unavailable && !shown.prompt?.unavailable
      && (shown.menu || shown.prompt)) {
      await herdr('pane.send_input', { pane_id: pane, keys: [key] })
      watchScreen(pane, 30000)
      setTimeout(() => refreshNativeScreen(pane), 50)
      return { ok: true }
    }
    const r = await herdr('pane.read', { pane_id: pane, source: 'detection' }, 4000)
    const text = r.read && r.read.text
    const agent = findPane(pane)?.agent
    const framed = agent !== 'omp' && String(text || '').split('\n').some((l: string) => TOP.test(l))
    const menu = framed ? await readMenu(pane) : null
    if (key === 'enter') {
      const current = menu ? menuIdentity(menu) : screenChoices(text, agent)?.identity
      if (!b.identity || current !== b.identity) throw new HerdrError('stale', 'The question has changed — check the current screen.')
    }
    if (menu) {
      if (key === 'enter' && clickMovesOnly(menu)) throw new HerdrError('stale', 'Enter doesn’t confirm from here — use the buttons.')
      if (key === 'left' || key === 'right') throw new HerdrError('stale', 'The screen has changed — check the current screen.')
    } else {
      const choices = screenChoices(text, agent)
      if (!choices || (choices.horizontal && (key === 'up' || key === 'down'))
        || ((key === 'left' || key === 'right') && !((choices.tabs && !choices.typing) || choices.horizontal))) {
        throw new HerdrError('stale', 'The screen has changed — check the current screen.')
      }
    }
    await herdr('pane.send_input', { pane_id: pane, keys: [key] })
    watchScreen(pane, 30000)
    // Quick re-read: the new selection shows without waiting for the poll.
    setTimeout(() => refreshNativeScreen(pane), 50)
    return { ok: true }
  } finally {
    choicesCache.delete(pane)
    setTimeout(poll, 0)
  }
})
