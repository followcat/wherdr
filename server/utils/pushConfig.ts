// Only an HTTPS address can serve as the VAPID contact for this app.
// Locally or with an invalid configuration, push stays unavailable.
export const FALLBACK_VAPID_SUBJECT = 'mailto:wherdr@localhost'

export function pushConfig(appUrl: string): { enabled: boolean, subject: string } {
  try {
    const url = new URL(appUrl)
    if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) {
      return { enabled: true, subject: url.href }
    }
  } catch { /* adresse absente ou invalide */ }
  return { enabled: false, subject: FALLBACK_VAPID_SUBJECT }
}

// Push services of the browsers: Apple (Safari), FCM (Chrome, Edge on
// Android, Samsung, Opera, Brave), Mozilla autopush (Firefox), WNS (Edge on
// Windows). The server posts to the endpoint, so nothing else is accepted (no
// private address, no other host of the network).
const PUSH_HOSTS = ['fcm.googleapis.com']
const PUSH_DOMAINS = ['push.apple.com', 'push.services.mozilla.com', 'notify.windows.com']
export function knownPushService(host: string): boolean {
  const h = host.toLowerCase()
  return PUSH_HOSTS.includes(h) || PUSH_DOMAINS.some(d => h.endsWith(`.${d}`))
}

// Subscription sent by the browser: the server will then post to
// `endpoint`, so only an HTTPS address of a known push service (default
// port), with its keys.
export function validPushSubscription(b: unknown): boolean {
  if (!b || typeof b !== 'object') return false
  const { endpoint, keys } = b as { endpoint?: unknown, keys?: { p256dh?: unknown, auth?: unknown } }
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !knownPushService(url.hostname)) return false
  } catch { return false }
  return Boolean(keys && typeof keys === 'object'
    && typeof keys.p256dh === 'string' && keys.p256dh.length > 0 && keys.p256dh.length <= 256
    && typeof keys.auth === 'string' && keys.auth.length > 0 && keys.auth.length <= 256)
}

// New subscription of a device: replaces its entry (same endpoint) and,
// after being turned off then on again (the browser changes endpoint),
// the old `previous` entry, whose still-active quiet setting is carried over.
export function replaceSubscription<T extends { endpoint: string, quiet?: Q }, Q>(
  all: T[], next: T, previous: unknown, active: (quiet: Q) => boolean): T[] {
  const old = typeof previous === 'string' && previous !== next.endpoint ? previous : null
  const quiet = [next.endpoint, old].map(e => all.find(s => s.endpoint === e)?.quiet).find(q => q !== undefined && active(q))
  const subs = all.filter(s => s.endpoint !== next.endpoint && s.endpoint !== old)
  subs.push(quiet === undefined ? next : { ...next, quiet })
  return subs
}
