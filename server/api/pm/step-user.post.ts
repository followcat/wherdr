// { id }: the user's button on the task's current step ("Merged", "OK").
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { userStep } from '../../utils/pmBoard'
import { pmStore } from '../../utils/pmStore'
import { publicTask } from '../../../shared/pm/run'

export default defineApi(async (_event, body) => ({ task: publicTask(await userStep({ ...coreAdminDeps(), store: pmStore() }, body.id)) }))
