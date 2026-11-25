import { setResponseStatus } from 'h3'
import { validateBacklotAction } from '../../../shared/backlot'
import { clearBacklotDocs, findBacklotActionEntry } from '../../utils/backlotDocs'
import { runBacklotAction } from '../../utils/backlotActions'
import { corePool, corePrimary } from '../../utils/state'

// One validated Studio action on the studio's machine; the next /api/backlot
// read reflects its result at once.
export default defineApi(async (event, body) => {
  corePrimary()
  const entries = corePool.entries()
  if (!entries.length) {
    setResponseStatus(event, 503)
    return { ok: false, error: 'herdr-core unavailable' }
  }
  const action = validateBacklotAction(body)
  const entry = action ? await findBacklotActionEntry(entries, action.machine) : entries[0]
  if (!entry) {
    setResponseStatus(event, 503)
    return { ok: false, error: 'herdr-core unavailable' }
  }
  const result = await runBacklotAction({
    call: (method, params, timeout) => entry.call(method, params, timeout),
    clearDocs: clearBacklotDocs,
  }, body)
  if (!result.ok) setResponseStatus(event, result.status || 502)
  return result
})
