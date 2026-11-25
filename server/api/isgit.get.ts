import { coreAdminDeps } from '../utils/coreAdminDeps'
import { coreIsGit } from '../utils/coreCreate'

export default defineApi(async (event) => {
  const q = getQuery(event)
  return coreIsGit(coreAdminDeps(q.machine), String(q.path || '') || null, q.machine)
})
