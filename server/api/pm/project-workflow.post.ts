// { key, workflow }: the user saves the project's workflow; a guard change is
// refused (guards have their own route, project-guards.post.ts).
import { saveProjectWorkflow } from '../../utils/pmProject'
import { pmStore } from '../../utils/pmStore'

export default defineApi((_event, body) => saveProjectWorkflow(pmStore(), body.key, body.workflow))
