// ?projects=A,B&q=&offset=: archived tasks, newest first, a page at a time (archive.ts).
// ?id=: one task's card, archived or not, for a link to a task the board leaves out.
import { archivedCards, cardById } from '../../utils/pmBoard'
import { pmStore } from '../../utils/pmStore'
import { coreAdminDeps } from '../../utils/coreAdminDeps'

export default defineApi(async (event): Promise<unknown> => {
  const q = getQuery(event)
  if (q.id !== undefined) return cardById(pmStore(), coreAdminDeps().machines(), String(q.id))
  const projects = String(q.projects ?? '').split(',').filter(Boolean)
  return archivedCards(pmStore(), coreAdminDeps().machines(), { projects, search: String(q.q ?? '').slice(0, 200), offset: Number(q.offset) || 0 })
})
