import { getQuery, setResponseStatus } from 'h3'
import { validateBacklotDocQuery } from '../../../shared/backlot'
import { findBacklotActionEntry } from '../../utils/backlotDocs'
import { readBacklotDesignDoc } from '../../utils/backlotActions'
import { corePool, corePrimary } from '../../utils/state'

// Read-only fetch of a studio's opening design document (`design/v<N>.md` or
// `design/v<N>-final.md`) through `backlot report show`, routed per session and machine.
export default defineApi(async (event) => {
  corePrimary()
  const entries = corePool.entries()
  if (!entries.length) {
    setResponseStatus(event, 503)
    return { ok: false, error: 'herdr-core unavailable' }
  }
  const q = getQuery(event)
  const input = {
    ...(q.session !== undefined ? { session: String(q.session) } : {}),
    machine: q.machine !== undefined ? String(q.machine) : '',
    studio: q.studio !== undefined ? String(q.studio) : '',
    file: q.file !== undefined ? String(q.file) : '',
  }
  const parsed = validateBacklotDocQuery(input)
  if (!parsed) {
    setResponseStatus(event, 400)
    return { ok: false, error: 'Invalid design document request' }
  }
  const entry = await findBacklotActionEntry(entries, parsed.machine, parsed.session)
  if (!entry) {
    setResponseStatus(event, 503)
    return { ok: false, error: 'herdr-core unavailable' }
  }
  const result = await readBacklotDesignDoc({
    call: (method, params, timeout) => entry.call(method, params, timeout),
  }, parsed)
  if (!result.ok) setResponseStatus(event, result.status || 502)
  return result
})
