// The backlot summary of every machine that publishes a `backlot/1` document.
// A machine without one is absent, so the Studio view stays invisible.
import { coreCall } from '../utils/core'
import { readBacklotDocs } from '../utils/backlotDocs'
import { coreTerminals } from '../utils/readCoreState'
import type { CoreMachine } from '../../shared/coreState'

export default defineApi(async () => {
  const endpoint = process.env.HC_SOCKET
  if (!endpoint) return { ok: false, machines: [], error: 'herdr-core unavailable' }
  try {
    const machines = (await coreCall<{ machines: CoreMachine[] }>(endpoint, 'machine.list', {}, 8000)).machines
    const terminals = await coreTerminals(endpoint).catch(() => [])
    const views = await readBacklotDocs((method, params) => coreCall(endpoint, method, params, 4000), machines, terminals)
    return { ok: true, machines: views }
  } catch {
    return { ok: false, machines: [], error: 'herdr-core unavailable' }
  }
})
