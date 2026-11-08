// { id, why? }: the user stops the task. Its agent ends; worktree, branch and
// work stay; it waits for the user's Continue, Take it as it is or Archive.
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { stopTask } from '../../utils/pmStop'
import { pmStore } from '../../utils/pmStore'
import { publicTask } from '../../../shared/pm/run'

export default defineApi(async (_event, body) => ({
  task: publicTask(await stopTask({ ...coreAdminDeps(), store: pmStore() }, body.id, { who: 'user' }, typeof body.why === 'string' ? body.why : '', 'user')),
}))
