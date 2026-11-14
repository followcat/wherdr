import { userMessageTo } from '../utils/pmCoordinator'
import { pmStore } from '../utils/pmStore'
import { keepPastes } from '../utils/pastes'

// The user's message. To a project coordinator, it also starts a user turn
// (what --user-said and template edit need), noted before it is sent.
// Codex installing or updating itself: the message waits on the server and is
// typed once Codex is ready (coreHeld.ts). Codex stopped by its update: refused
// ("Not sent"), the conversation offers to restart it first.
export default defineApi(async (_event, b) => {
  const deps = coreInputDeps()
  const p = deps.pane(String(b.pane_id))
  const text = typeof b.text === 'string' ? b.text : ''
  if (p?.stopped && text.trim()) throw new HerdrError('agent_stopped', 'Codex exited after updating itself: restart it, then send again.')
  if (p?.installing && p.coreAddress && text.trim()) {
    keepPastes(text, b.pastes)
    const queued = heldMessages.hold(p, text, b.client_id)
    deps.refresh()
    return { ok: true, queued }
  }
  if (text.trim()) await userMessageTo(pmStore(), p?.coreAddress, text).catch(() => {})
  return coreSend(deps, b)
})
