// { id, text?, terminal? }: the user's answer to a task agent's question
// (Tasks to review), or, without text, word that they answered it in the
// agent's conversation (Composer.vue): the task leaves Your turn at once.
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { answerQuestion } from '../../utils/pmAnswer'
import { pmStore } from '../../utils/pmStore'
import { publicTask } from '../../../shared/pm/run'

export default defineApi(async (_event, body) => ({ task: publicTask(await answerQuestion({ ...coreAdminDeps(), store: pmStore() }, body.id, body.text, body.terminal)) }))
