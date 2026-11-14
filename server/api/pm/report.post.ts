// { id, text, shots?, block? }: the user reports a problem on a task that waits
// for them, sent to the project's coordinator. { id, withdraw: true }: taken back.
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { coordinatorUrls } from '../../utils/pmCoordinator'
import { userReport, withdrawReport } from '../../utils/pmReport'
import { pmStore } from '../../utils/pmStore'
import { publicTask } from '../../../shared/pm/run'

export default defineApi(async (event, body) => ({
  task: publicTask(body.withdraw === true
    ? await withdrawReport(pmStore(), body.id)
    : await userReport({ ...coreAdminDeps(), store: pmStore() }, body, coordinatorUrls(getRequestURL(event)))),
}))
