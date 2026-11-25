import { coreAdminDeps } from '../utils/coreAdminDeps'
import { coreListDirs } from '../utils/coreCreate'

export default defineApi((event) => {
  const q = getQuery(event)
  return coreListDirs(coreAdminDeps(q.machine), String(q.path || '') || null, q.machine)
})
