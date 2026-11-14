// { id }: an archived task back in Done.
import { unarchiveTask } from '../../utils/pmBoard'
import { pmStore } from '../../utils/pmStore'
import { publicTask } from '../../../shared/pm/run'

export default defineApi(async (_event, body) => ({ task: publicTask(await unarchiveTask(pmStore(), body.id)) }))
