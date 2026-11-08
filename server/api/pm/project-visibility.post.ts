// { key, value: 'public' | 'private' }: the user's override; { key, check: true }:
// wherdr checks the repository again.
import { pmStore } from '../../utils/pmStore'
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { checkVisibility } from '../../utils/pmVisibility'
import { HerdrError } from '../../utils/herdr'

export default defineApi(async (_event, body) => {
  const store = pmStore()
  if (body.check === true) return { project: await checkVisibility({ ...coreAdminDeps(), store }, body.key) }
  if (body.value !== 'public' && body.value !== 'private') throw new HerdrError('bad_input', 'value: public or private')
  return { project: await store.setVisibility(body.key, { value: body.value, at: Date.now(), by: 'user' }) }
})
