import { userMessageTo } from '../utils/pmCoordinator'
import { pmStore } from '../utils/pmStore'

// The user's message. To a project coordinator, it also starts a user turn
// (what --user-said and template edit need), noted before it is sent.
export default defineApi(async (_event, b) => {
  const deps = coreInputDeps()
  if (typeof b.text === 'string' && b.text.trim()) await userMessageTo(pmStore(), deps.pane(String(b.pane_id))?.coreAddress, b.text).catch(() => {})
  return coreSend(deps, b)
})
