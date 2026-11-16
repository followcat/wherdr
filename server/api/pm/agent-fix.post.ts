// { id }: the user's Ask the agent to fix it on a blocked task (pmFix.ts).
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { askAgentFix } from '../../utils/pmFix'
import { pmStore } from '../../utils/pmStore'
import { publicTask } from '../../../shared/pm/run'

export default defineApi(async (_event, body) => ({
  task: publicTask(await askAgentFix({ ...coreAdminDeps(), store: pmStore() }, String(body.id))),
}))
