// { id }: the user asks the project's coordinator to check a step it holds
// that waits on them (past its time limit, or until the user writes).
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { coordinatorUrls } from '../../utils/pmCoordinator'
import { askCoordinator } from '../../utils/pmReport'
import { pmStore } from '../../utils/pmStore'
import { publicTask } from '../../../shared/pm/run'

export default defineApi(async (event, body) => ({
  task: publicTask(await askCoordinator({ ...coreAdminDeps(), store: pmStore() }, body.id, coordinatorUrls(getRequestURL(event)))),
}))
