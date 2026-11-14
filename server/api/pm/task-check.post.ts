// { id }: "Check on GitHub": the task's PR read now (server/utils/pmGhCheck.ts).
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { checkOnGithub } from '../../utils/pmGhCheck'
import { pmStore } from '../../utils/pmStore'
import { publicTask } from '../../../shared/pm/run'

export default defineApi(async (_event, body) => {
  const { task, check } = await checkOnGithub({ ...coreAdminDeps(), store: pmStore() }, body.id, 'user')
  return { task: publicTask(task), check }
})
