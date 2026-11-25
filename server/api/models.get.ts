// The model list a pane's picker would show (see utils/coreModelctl.ts):
// a gated menu read for claude/codex/omp/devin, the service catalog for
// opencode, `cmd --list-models` for Command Code.
import { coreModelCtl } from '../utils/state'

export default defineApi((event) => {
  const pane = getQuery(event).pane
  return coreModelCtl(pane).listModels(pane)
})
