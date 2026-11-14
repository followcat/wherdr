// { id }: the template library's Delete. Projects started from it keep their own workflow.
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (_event, body) => { await pmStore().removeTemplate(body.id); return { removed: body.id } })
