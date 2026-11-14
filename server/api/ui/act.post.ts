// { id, cancel?, picks?, start? }: the user clicks an action button (or Cancel) in the chat (server/utils/uiActions.ts).
// A request with a token (an agent's CLI) is refused.
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { applyProposedChange } from '../../utils/alfredCli'
import { actOnCard } from '../../utils/uiActions'
import { cardChoice, type CardChoice } from '../../../shared/uiActions'
import { coordinatorUrls } from '../../utils/pmCoordinator'
import { pmFolderCheck } from '../../utils/pmFolder'
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (event, body) => {
  const deps = { ...coreAdminDeps(), store: pmStore(), origin: getRequestURL(event).origin }
  const applyChange = (argv: string[], lines: string[], choice?: CardChoice) => applyProposedChange({ ...deps, check: pmFolderCheck, urls: coordinatorUrls(getRequestURL(event)) }, argv, lines, choice)
  return { card: await actOnCard({ ...deps, applyChange }, body.id, getRequestHeader(event, 'authorization'), body.cancel === true, cardChoice(body)) }
})
