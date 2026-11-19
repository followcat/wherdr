import type { PushSub } from '../../utils/push'
// Registered devices with the result of their last delivery (no endpoint or key
// leaves the server). `remove`: id of a device to forget. `endpoint`: this
// browser's subscription, to mark it as the current device.
export default defineApi(async (event, b) => {
  let subs: PushSub[]
  if (b.remove !== undefined) {
    if (typeof b.remove !== 'string' || !/^[0-9a-f]{16}$/.test(b.remove)) throw new HerdrError('bad_device', 'Unknown device')
    let removed = false
    subs = await updateSubs((all) => {
      const next = all.filter(s => pushDeviceId(s.endpoint) !== b.remove)
      removed = next.length !== all.length
      return removed ? next : null
    })
    if (removed) log(`push: device ${b.remove} removed (${subs.length} device(s))`)
  } else subs = await readSubs()
  return { devices: pushDeviceViews(subs, typeof b.endpoint === 'string' ? b.endpoint : '') }
})
