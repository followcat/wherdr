// ?task=&phase=before|after, the image as the body: a screenshot the agent
// gives as its current step's evidence. Sent by the agent (curl), not the app:
// the task's key (X-Wherdr-Shot-Token) stands for the Origin check and the
// passkey session (server/middleware/guard.ts).
import { SHOT_MAX_BYTES, SHOT_TOKEN_HEADER } from '../../../shared/pm/shots'
import { uploadShot, worktreeHead } from '../../utils/pmBoard'
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { pmStore } from '../../utils/pmStore'
import type { Task } from '../../../shared/pm/run'

export default defineApi(async (event, b) => {
  const q = getQuery(event), store = pmStore()
  const head = (task: Task) => worktreeHead(coreAdminDeps(), store, task)
  return { shot: await uploadShot(store, q.task, q.phase, b.data, b.ctype, getRequestHeader(event, SHOT_TOKEN_HEADER), head) }
}, { agentKey: true, raw: /^image\/(png|jpeg|webp)$/, max: SHOT_MAX_BYTES, tooLarge: 'Image too large (10 MB max)' })
