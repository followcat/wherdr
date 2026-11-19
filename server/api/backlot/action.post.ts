import { setResponseStatus } from 'h3'
import { coreCall } from '../../utils/core'
import { clearBacklotDocs } from '../../utils/backlotDocs'
import { runBacklotAction } from '../../utils/backlotActions'

// One validated Studio action on the studio's machine; the next /api/backlot
// read reflects its result at once.
export default defineApi(async (event, body) => {
  const endpoint = process.env.HC_SOCKET
  if (!endpoint) {
    setResponseStatus(event, 503)
    return { ok: false, error: 'herdr-core unavailable' }
  }
  const result = await runBacklotAction({
    call: (method, params, timeout) => coreCall(endpoint, method, params, timeout),
    clearDocs: clearBacklotDocs,
  }, body)
  if (!result.ok) setResponseStatus(event, result.status || 502)
  return result
})
