// { template, replace? }: saves a workflow template (shared/pm/workflow.ts), checked
// first. replace: true changes a saved one (the editor opened it); without it, a taken id is refused.
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (_event, body) => ({ template: await pmStore().saveTemplate(body.template, { replace: body.replace === true }) }))
