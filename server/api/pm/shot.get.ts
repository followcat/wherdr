// ?task=&file=: a task's screenshot, for its gallery.
import { pmStore } from '../../utils/pmStore'

const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const file = String(q.file || '')
  const body = await pmStore().shot(String(q.task || ''), file)
  if (!body) return sendError(event, 404, { error: 'Image not found' })
  return sendImage(event, { type: TYPES[file.split('.').pop()!]!, body })
})
