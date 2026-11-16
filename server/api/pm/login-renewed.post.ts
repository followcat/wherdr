// { id }: the user's "I logged in" on a login incident: the engine restarts
// its stuck agents on its next pass (server/utils/pmRecovery.ts), one after another.
import { HerdrError } from '../../utils/herdr'
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (_event, body) => {
  const store = pmStore()
  const i = (await store.incidents()).find(x => x.id === body.id && x.cause === 'login')
  if (!i) throw new HerdrError('not_found', 'Unknown login incident')
  await store.renewIncident(i.id, Date.now())
  return { ok: true }
})
