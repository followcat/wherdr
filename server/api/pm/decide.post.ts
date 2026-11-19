// { id, choice }: the user's answer to a review handed to them (Tasks to review, the task's sheet).
import { userDecide } from '../../utils/pmBoard'
import { pmStore } from '../../utils/pmStore'
import { publicTask } from '../../../shared/pm/run'

export default defineApi(async (_event, body) => ({ task: publicTask(await userDecide(pmStore(), body.id, body.choice)) }))
