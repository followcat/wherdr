// { id }: the user's Restart the review: the reviewer that stopped without a
// verdict (or is past the step's time limit) ends, and a new one reviews the
// branch's current head on the next pass (server/utils/pmWatchdog.ts).
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { restartReview } from '../../utils/pmWatchdog'
import { pmStore } from '../../utils/pmStore'
import { publicTask } from '../../../shared/pm/run'

export default defineApi(async (_event, body) => ({
  task: publicTask(await restartReview({ ...coreAdminDeps(), store: pmStore() }, body.id, 'user', 'restarted the review')),
}))
