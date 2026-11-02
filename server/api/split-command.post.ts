import { runSplitCommand } from '../utils/splitCommand'
import { poll } from '../utils/state'

export default defineApi(async (_event, body) => {
  try { return await runSplitCommand(String(body.pane_id || ''), body.command) }
  finally { await poll() }
})
