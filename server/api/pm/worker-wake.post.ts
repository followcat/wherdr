// { id }: the user opens the conversation of a worker the engine released:
// started again with its conversation (pmRelease.ts wakeReleased).
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { wakeReleased } from '../../utils/pmRelease'
import { pmStore } from '../../utils/pmStore'
import { publicTask } from '../../../shared/pm/run'

export default defineApi(async (_event, body) => ({
  task: publicTask(await wakeReleased({ ...coreAdminDeps(), store: pmStore() }, String(body.id))),
}))
