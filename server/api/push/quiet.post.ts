// Quiet mode: read (without `scope`) or set, for this device
// (`endpoint` subscription) or for all. Reply: both current quiet periods.
import { parseQuiet, quietActive } from '../../../shared/quiet'

export default defineApi(async (event, b) => {
  const endpoint = typeof b.endpoint === 'string' ? b.endpoint : ''
  if (b.scope !== undefined) {
    const quiet = parseQuiet(b.on, b.until)
    if (quiet === undefined || (b.scope !== 'device' && b.scope !== 'all')) throw new HerdrError('bad_quiet', 'Invalid quiet setting')
    if (b.scope === 'all') await writeGlobalQuiet(quiet)
    else {
      await updateSubs((subs) => {
        const sub = subs.find(s => s.endpoint === endpoint)
        if (!sub) throw new HerdrError('no_sub', 'Notifications are not enabled on this device')
        if (quiet) sub.quiet = quiet
        else delete sub.quiet
        return subs
      })
    }
    log(`push: quiet ${b.scope === 'all' ? 'all devices' : 'one device'} ${quiet ? (quiet.until ? `until ${new Date(quiet.until).toISOString()}` : 'until turned back on') : 'off'}`)
  }
  const device = endpoint ? (await readSubs()).find(s => s.endpoint === endpoint)?.quiet : undefined
  return { global: await readGlobalQuiet(), device: device && quietActive(device) ? device : null }
})
