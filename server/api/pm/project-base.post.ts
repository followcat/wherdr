// { key, base }: the project's working branch ('' clears it).
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (_event, body) => ({ project: await pmStore().setBase(body.key, body.base) }))
