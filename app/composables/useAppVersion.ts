// New app version (redeployment): state of the "Reload" banner,
// waiting service worker, periodic check of the served build.
// Pure logic and anti-loop guard: app/utils/appVersion.ts.
import { installedSwAction, isNewBuild } from '../utils/appVersion'
import { onceEvery } from '../utils/onceEvery'

export const newVersionReady = ref(false)
export const newVersionDismissed = ref(false)
let swReg: ServiceWorkerRegistration | null = null
let applying = false
// True until our first explicit update check (checkNewVersion): a new SW
// found meanwhile comes from the page load itself, not from a deployment
// made while the app was in use.
let startup = true

function markNew() {
  newVersionReady.value = true
}

function watchInstalling(sw: ServiceWorker | null, atStartup: boolean) {
  sw?.addEventListener('statechange', () => {
    if (sw.state !== 'installed') return
    const action = installedSwAction(Boolean(navigator.serviceWorker.controller), atStartup)
    if (action === 'activate') sw.postMessage({ type: 'skip-waiting' })
    else if (action === 'banner') markNew()
  })
}

// Service worker: a new SW found during use stays "waiting" until Reload is
// clicked. One found at startup (waiting since the last visit, or installing
// because of this page load) is activated silently for future navigations.
// The current page may still be a cached shell: startupBuildCheck offers the
// banner when it is older than the served build, without reloading it.
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    swReg = reg
    reg.waiting?.postMessage({ type: 'skip-waiting' })
    // updatefound may have fired before register() resolved.
    watchInstalling(reg.installing, true)
    reg.addEventListener('updatefound', () => watchInstalling(reg.installing, startup))
    startupBuildCheck()
  }).catch(() => {})
}

// Cache-first startup may serve an older shell after a redeployment. Offer
// the same banner as an update found during use; only the user reloads it.
async function startupBuildCheck() {
  try {
    const res = await fetch(`/_nuxt/builds/latest.json?${Date.now()}`, { cache: 'no-store' })
    if (res.ok && isNewBuild(useRuntimeConfig().app.buildId, await res.json())) markNew()
  } catch { /* offline: the periodic check will catch up */ }
}

// A file of the running build could not be loaded (a deployment removed it, or
// the server is restarting): the banner when a newer build is served, never a
// reload by itself. Offline or same build: nothing. True if a newer build is served.
export async function offerNewBuild(): Promise<boolean> {
  try {
    const res = await fetch(`/_nuxt/builds/latest.json?${Date.now()}`, { cache: 'no-store' })
    if (!res.ok || !isNewBuild(useRuntimeConfig().app.buildId, await res.json())) return false
  } catch { return false } // offline: the periodic check will catch up
  markNew()
  return true
}

// Returning to the page and reconnecting ask for a check: at most one a
// minute. One asked meanwhile runs at the end of the minute, so a redeployment
// right after a check is still seen.
const WAKE_CHECK_MS = 60000
const wakeCheck = onceEvery(WAKE_CHECK_MS)
let wakeLater: ReturnType<typeof setTimeout> | undefined
export function checkNewVersionOnWake() {
  if (wakeCheck.take()) { void checkNewVersion(); return }
  if (wakeLater) return
  wakeLater = setTimeout(() => {
    wakeLater = undefined
    if (!document.hidden) checkNewVersionOnWake()
  }, wakeCheck.wait())
}

// Is the server serving a build other than the one running?
export async function checkNewVersion() {
  if (newVersionReady.value) return
  wakeCheck.mark()
  try {
    const res = await fetch(`/_nuxt/builds/latest.json?${Date.now()}`, { cache: 'no-store' })
    if (res.ok && isNewBuild(useRuntimeConfig().app.buildId, await res.json())) markNew()
  } catch { /* server unreachable: we will retry */ }
  startup = false
  try { await swReg?.update() } catch { /* same */ }
}

// Activates the new SW if it is waiting, then reloads. Only on the user's
// request (Reload). Drafts are already in localStorage (useDraft).
export async function applyNewVersion() {
  if (applying) return
  applying = true
  // New SW still installing: we wait for it to be ready.
  const installing = swReg?.installing
  if (installing) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000)
      installing.addEventListener('statechange', () => { if (installing.state !== 'installing') { clearTimeout(timer); resolve() } })
    })
  }
  const waiting = swReg?.waiting
  if (waiting && 'serviceWorker' in navigator) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000)
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve() }, { once: true })
      waiting.postMessage({ type: 'skip-waiting' })
    })
  }
  location.reload()
}
