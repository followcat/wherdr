// { key, template }: picks the project's template ('' clears it).
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (_event, body) => ({ project: await pmStore().setTemplate(body.key, body.template) }))
