// { id }: starts the task's worker. Answers with the task: 'working', or
// 'waiting' with the reason it could not start. The user's start always goes;
// on a machine short on memory, `memory` says so (also in the task's log).
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { startTask } from '../../utils/pmLaunch'
import { memoryHold } from '../../utils/pmMemory'
import { pmStore } from '../../utils/pmStore'
import { publicTask } from '../../../shared/pm/run'

export default defineApi(async (event, body) => {
  const deps = { ...coreAdminDeps(), store: pmStore(), origin: getRequestURL(event).origin }
  const before = await deps.store.task(body.id)
  const short = before ? await memoryHold(deps, before.project) : undefined
  let task = await startTask(deps, body.id)
  if (short) task = await deps.store.logTask(task, 'user', `${short}: started anyway, as the user asked`)
  return { task: publicTask(task), ...(short ? { memory: `${short}: started anyway` } : {}) }
})
