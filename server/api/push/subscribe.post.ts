import { quietActive } from '../../../shared/quiet'
import { replaceSubscription, validPushSubscription } from '../../utils/pushConfig'
export default defineApi(async (event, b) => {
  if (!pushReady()) throw new HerdrError('push_off', 'Web Push is not configured')
  if (!validPushSubscription(b)) throw new HerdrError('bad_sub', 'Invalid subscription')
  const sessions: Record<string, string> = {}
  if (b.sessions && typeof b.sessions === 'object' && !Array.isArray(b.sessions)) {
    for (const [key, name] of Object.entries(b.sessions)) {
      if ((key === '' || /^[0-9a-f]{4,32}$/.test(key)) && typeof name === 'string' && /^[\w.-]{1,64}$/.test(name)) sessions[key] = name
    }
  }
  // Resubscription (language…) or new endpoint after reactivation
  // (`previous`): the old entry goes away, the device's quiet setting stays.
  const subs = await updateSubs(all => replaceSubscription(all, { endpoint: b.endpoint, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth }, lang: b.lang === 'fr' ? 'fr' : 'en',
    sessions, addedAt: new Date().toISOString(), gen: auth.generation() }, b.previous, quietActive))
  log(`push: subscription saved (${subs.length} device(s))`)
  return { ok: true, devices: subs.length }
})
