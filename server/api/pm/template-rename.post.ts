// { id, to }: the template library's Rename.
import { pmStore } from '../../utils/pmStore'

export default defineApi((_event, body) => pmStore().renameTemplate(body.id, body.to))
