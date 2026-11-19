// { key, workflow }: the user saves the project's workflow; a guard change is
// refused (guards have their own route, project-guards.post.ts).
// { key, reset: true }: a workspace's project follows its workspace's workflow again.
import { resetMemberWorkflow, saveProjectWorkflow } from '../../utils/pmProject'
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (_event, body): Promise<object> => (body.reset === true ? resetMemberWorkflow(pmStore(), body.key) : saveProjectWorkflow(pmStore(), body.key, body.workflow)))
