// { key, guards }: the project's guards, from the user's session or with
// Alfred's token; a project coordinator's token is refused (pmProject.ts).
// The merges they now give the engine are tried again at once.
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { guardsAuthor, saveProjectGuards } from '../../utils/pmProject'
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (event, body) => {
  const store = pmStore()
  const by = await guardsAuthor(store, getRequestHeader(event, 'authorization'))
  return saveProjectGuards(store, body.key, body.guards, by, coreAdminDeps())
})
