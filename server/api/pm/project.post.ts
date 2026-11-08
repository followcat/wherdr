// Adds a project: { key, name?, machine, path, base?, template? } (a library
// template id or example:<id>, copied into the project's own workflow). The folder
// must be a git repository on a machine herdr-core reaches, unless plain: true
// (the New sheet), which also takes create (a missing folder) and gitInit.
// Whether its repository is public is checked at once (pmVisibility.ts).
import { pmStore } from '../../utils/pmStore'
import { pmFolderCheck } from '../../utils/pmFolder'
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { ensureVisibility } from '../../utils/pmVisibility'

export default defineApi(async (_event, body) => {
  const store = pmStore()
  const opts = { create: body.create === true, gitInit: body.gitInit === true, plain: body.plain === true }
  return { project: await ensureVisibility({ ...coreAdminDeps(), store }, await store.addProject(body, pmFolderCheck, opts)) }
})
