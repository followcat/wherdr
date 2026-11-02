// Registered devices with the result of their last delivery (no endpoint or key
// leaves the server). `remove`: id of a device to forget. `endpoint`: this
// browser's subscription, to mark it as the current device.
export default defineApi(async (event, b) => {
  let subs = await readSubs()
  if (b.remove !== undefined) {
    if (typeof b.remove !== 'string' || !/^[0-9a-f]{16}$/.test(b.remove)) throw new HerdrError('bad_device', 'Unknown device')
    const next = subs.filter(s => pushDeviceId(s.endpoint) !== b.remove)
    if (next.length !== subs.length) {
      await writeSubs(next)
      log(`push: device ${b.remove} removed (${next.length} device(s))`)
    }
    subs = next
  }
  return { devices: pushDeviceViews(subs, typeof b.endpoint === 'string' ? b.endpoint : '') }
})
