// ?task=&phase=before|after, the image as the body: a screenshot the agent
// gives as its current step's evidence. Sent by the agent (curl), not the app:
// the task's key (X-Wherdr-Shot-Token) stands for the Origin check and the
// passkey session (server/middleware/guard.ts).
import { SHOT_MAX_BYTES, SHOT_TOKEN_HEADER } from '../../../shared/pm/shots'
import { uploadShot } from '../../utils/pmBoard'
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (event, b) => {
  const q = getQuery(event)
  return { shot: await uploadShot(pmStore(), q.task, q.phase, b.data, b.ctype, getRequestHeader(event, SHOT_TOKEN_HEADER)) }
}, { agentKey: true, raw: /^image\/(png|jpeg|webp)$/, max: SHOT_MAX_BYTES, tooLarge: 'Image too large (10 MB max)' })
