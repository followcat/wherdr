// { id }: starts the task's worker. Answers with the task: 'working', or
// 'waiting' with the reason it could not start.
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { startTask } from '../../utils/pmLaunch'
import { pmStore } from '../../utils/pmStore'
import { publicTask } from '../../../shared/pm/run'

export default defineApi(async (event, body) => ({ task: publicTask(await startTask({ ...coreAdminDeps(), store: pmStore(), origin: getRequestURL(event).origin }, body.id)) }))
