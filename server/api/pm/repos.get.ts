// { machine, refresh? }: the git repositories under that machine's home folder
// (a few levels deep, cached a few minutes), for the New sheet's project form.
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { findRepos } from '../../utils/pmRepos'

export default defineApi((event) => {
  const q = getQuery(event)
  return findRepos(coreAdminDeps(), String(q.machine || ''), { refresh: q.refresh === '1' })
})
