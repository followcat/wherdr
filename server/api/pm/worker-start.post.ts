// { id }: the user's Start the worker on a merge that waits on it (a conflict
// or red checks no agent is on, its worker ended): started again with what to do.
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { startWorkerFor } from '../../utils/pmMechanic'
import { pmStore } from '../../utils/pmStore'
import { publicTask } from '../../../shared/pm/run'

export default defineApi(async (_event, body) => ({
  task: publicTask(await startWorkerFor({ ...coreAdminDeps(), store: pmStore() }, String(body.id))),
}))
