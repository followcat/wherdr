// ?project=KEY: the project's automations, the proposals waiting for the user,
// and each switched-on schedule's next firing (by id), in the server's time zone.
import { nextFiring } from '../../../shared/pm/automations'
import { HerdrError } from '../../utils/herdr'
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (event) => {
  const store = pmStore()
  const p = await store.project(String(getQuery(event).project ?? ''))
  if (!p) throw new HerdrError('not_found', 'Unknown project')
  const f = await store.automations(p.key)
  const now = Date.now(), next = Object.fromEntries(f.automations.flatMap(a => { const n = nextFiring(a, now); return n ? [[a.id, n]] : [] }))
  return { automations: f.automations, proposals: (f.proposals ?? []).filter(x => !x.outcome), next }
})
