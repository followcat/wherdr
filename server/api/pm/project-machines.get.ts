// ?key=: the project's Machines view (machinesNow): each allowed machine's
// state, memory, agents and what it takes now, the strategy, and the next task.
import { HerdrError } from '../../utils/herdr'
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { machinesNow } from '../../utils/pmPlace'
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (event) => {
  const store = pmStore(), key = String(getQuery(event).key ?? '')
  const p = (await store.projects()).find(x => x.key === key)
  if (!p) throw new HerdrError('not_found', 'Unknown project')
  return machinesNow({ ...coreAdminDeps(), store }, p)
})
