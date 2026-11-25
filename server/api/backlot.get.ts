// The backlot summary of every machine that publishes a `backlot/1` document.
// A machine without one is absent, so the Studio view stays invisible.
import { readPoolBacklotDocs } from '../utils/backlotDocs'
import { corePool, corePrimary } from '../utils/state'

export default defineApi(async () => {
  corePrimary()
  const res = await readPoolBacklotDocs(corePool.entries())
  if (!res.ok) return { ok: false, machines: [], error: res.error || 'herdr-core unavailable' }
  return { ok: true, machines: res.views }
})
