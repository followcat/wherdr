// { machine, path }: the folder as it stands (missing, git, empty), for the
// New sheet's project form.
import { probeFolder } from '../../utils/pmFolder'

export default defineApi((event) => {
  const q = getQuery(event)
  return probeFolder(String(q.machine || ''), String(q.path || ''))
})
