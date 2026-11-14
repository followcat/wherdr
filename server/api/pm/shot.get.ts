// ?task=&file=: a task's screenshot, for its gallery. An agent reads one the
// user pointed at with its task's key (X-Wherdr-Shot-Token), checked here.
import { timingSafeEqual } from 'node:crypto'
import { SHOT_TOKEN_HEADER } from '../../../shared/pm/shots'
import { pmStore } from '../../utils/pmStore'

const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }
const same = (a: string | undefined, b: string) => !!a && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const file = String(q.file || ''), id = String(q.task || ''), store = pmStore()
  const key = getRequestHeader(event, SHOT_TOKEN_HEADER)
  // With a key, only that task's: an unknown task and a wrong key answer the same.
  if (key !== undefined && !same((await store.task(id))?.shotToken, key)) return sendError(event, 404, { error: 'Image not found' })
  const body = await store.shot(id, file)
  if (!body) return sendError(event, 404, { error: 'Image not found' })
  return sendImage(event, { type: TYPES[file.split('.').pop()!]!, body })
})
