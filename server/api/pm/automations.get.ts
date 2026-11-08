// ?project=KEY: the project's automations, and its template's task types (for the editor).
import { HerdrError } from '../../utils/herdr'
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (event) => {
  const store = pmStore()
  const p = await store.project(String(getQuery(event).project ?? ''))
  if (!p) throw new HerdrError('not_found', 'Unknown project')
  const t = p ? await store.workflow(p.key) : null
  return { automations: (await store.automations(p.key)).automations, types: Object.keys(t?.taskTypes ?? {}) }
})
