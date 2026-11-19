// { key }: the remote branches of the project's repository, for its working branch field, its current branch and its local ones.
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { pmStore } from '../../utils/pmStore'
import { repoBranches } from '../../utils/pmRepos'
import { HerdrError } from '../../utils/herdr'

export default defineApi(async (event) => {
  const key = String(getQuery(event).key || '')
  const p = await pmStore().project(key)
  if (!p) throw new HerdrError('not_found', 'Unknown project')
  return p.git === false ? { branches: [], current: '', local: [] } : await repoBranches(coreAdminDeps(), p)
})
