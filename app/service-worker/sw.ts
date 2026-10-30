// wherdr service worker: installable + notifications.
// Network first (the app only makes sense connected to the server): the cache
// only serves to show the shell if the network is down or silent. Fingerprinted
// build files, which never change under their name, come from the cache once there.
// Never any cache for /api/, /ws/ or /uploads/.

import { networkFirst } from './networkFirst'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface SwGlobal {
  __WB_MANIFEST: Array<{ url: string, revision: string | null } | string>
  location: Location
  registration: {
    showNotification: (title: string, opts: Record<string, unknown>) => Promise<void>
  }
  clients: {
    claim: () => Promise<void>
    matchAll: (opts: Record<string, unknown>) => Promise<Array<{ url: string, postMessage: (m: unknown) => void, focus: () => Promise<unknown> }>>
    openWindow: (url: string) => Promise<unknown>
  }
  navigator: Navigator & { setAppBadge?: (n: number) => Promise<void> }
  skipWaiting: () => Promise<void>
  addEventListener: (type: string, fn: (e: any) => void) => void
}
const sw = self as unknown as SwGlobal

const CACHE = 'wherdr-v1'
// Silent server: the cached copy past this delay (see networkFirst.ts).
const NETWORK_WAIT_MS = 3000
// Files of the built app (hashes in the name) + the page.
// (written as is: workbox looks for "self.__WB_MANIFEST" to inject the list there)
const WB_MANIFEST = self.__WB_MANIFEST
const PRECACHE = ['/', ...WB_MANIFEST.map(e => '/' + (typeof e === 'string' ? e : e.url).replace(/^\//, ''))]

sw.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE)
    // A missing file must not prevent installation.
    await Promise.all(PRECACHE.map(u => c.add(new Request(u, { cache: 'no-cache' })).catch(() => {})))
    // No skipWaiting here: a new version waits for the user
    // to click "Reload" (app banner), never a switch in the middle of use.
  })())
})

sw.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'skip-waiting') sw.skipWaiting()
})

sw.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k)
    await sw.clients.claim()
  })())
})

// Copy taken at once (before the page reads the body), stored afterwards.
async function keep(req: Request, res: Response) {
  if (!res.ok) return
  const copy = res.clone()
  await (await caches.open(CACHE)).put(req, copy)
}

sw.addEventListener('fetch', (e) => {
  const req: Request = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== sw.location.origin
    || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/') || url.pathname.startsWith('/uploads/')) return
  // Fingerprinted build files never change under their name: once cached, no
  // round trip (a silent server would otherwise hold up each file of the shell).
  if (url.pathname.startsWith('/_nuxt/') && !url.pathname.startsWith('/_nuxt/builds/')) {
    const cached = caches.match(req).catch(() => undefined)
    const fresh = cached.then(hit => (hit ? undefined : fetch(req)))
    // Not cached yet: stored before the worker may stop (iOS stops it early).
    e.waitUntil(fresh.then(res => res && keep(req, res)).catch(() => {}))
    e.respondWith(cached.then(async hit => hit || (await fresh)!))
    return
  }
  // no-cache: always revalidate with the server, never serve an old
  // version from the phone's HTTP cache.
  const network = fetch(req, { cache: 'no-cache' })
  // Also kept when the answer comes after the cached copy was served.
  e.waitUntil(network.then(res => keep(req, res)).catch(() => {}))
  if (req.mode === 'navigate') {
    // The app shell is precached: serve it at once instead of holding the
    // page on a possibly-silent network. The fingerprinted /_nuxt files it
    // names are immutable, so the cached pair stays consistent; the network
    // answer still refreshes the cache (kept above) and the update banner
    // announces a new build. First install finds nothing cached: the
    // network answer, however late.
    e.respondWith(caches.match('/').then(hit => hit || network))
    return
  }
  const fromCache = async () => (await caches.match(req)) || undefined
  e.respondWith(networkFirst(network, fromCache, NETWORK_WAIT_MS))
})

sw.addEventListener('push', (e) => {
  let d: Record<string, any> = {}
  try { d = e.data ? e.data.json() : {} }
  catch { d = { body: e.data ? e.data.text() : '' } }
  e.waitUntil((async () => {
    await sw.registration.showNotification(d.title || 'wherdr', {
      body: d.body || '',
      tag: d.tag || 'herdr', // one notification per pane, replaced on each change
      renotify: true,
      icon: '/icons/icon-192.png?v=5',
      badge: '/icons/icon-192.png?v=5',
      data: { url: d.url || '/' },
    })
    try {
      if (typeof d.badge === 'number' && sw.navigator.setAppBadge) await sw.navigator.setAppBadge(d.badge)
    } catch { /* not supported */ }
  })())
})

sw.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil((async () => {
    let target = '/'
    try {
      const u = new URL((e.notification.data && e.notification.data.url) || '/', sw.location.origin)
      if (u.origin === sw.location.origin) target = u.pathname + u.search + u.hash
    } catch { /* adresse illisible */ }
    const wins = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of wins) {
      if (c.url.startsWith(sw.location.origin)) {
        c.postMessage({ type: 'navigate', url: target })
        return c.focus()
      }
    }
    return sw.clients.openWindow(target)
  })())
})

declare global {
  interface Window { __WB_MANIFEST: SwGlobal['__WB_MANIFEST'] }
}
export {}
