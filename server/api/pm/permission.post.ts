// { id, allow }: the user's answer to a task agent's permission request (Decisions).
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { answerPermission } from '../../utils/pmPermission'
import { pmStore } from '../../utils/pmStore'
import { publicTask } from '../../../shared/pm/run'

export default defineApi(async (_event, body) => ({ task: publicTask(await answerPermission({ ...coreAdminDeps(), store: pmStore() }, body.id, body.allow)) }))
