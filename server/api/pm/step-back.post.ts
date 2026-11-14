// { id, note, shots? }: the user sends their step (a visual merge) back to the task's
// worker, with what to change and the screenshots they point at (userSendBack).
import { userSendBack } from '../../utils/pmBoard'
import { pmStore } from '../../utils/pmStore'
import { publicTask } from '../../../shared/pm/run'

export default defineApi(async (event, body) => ({ task: publicTask(await userSendBack(pmStore(), body.id, body.note, body.shots, getRequestURL(event).origin)) }))
