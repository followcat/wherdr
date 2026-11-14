// New app version after a redeployment: never a reload by itself. We compare
// the identifier of the loaded build with the one the server serves
// (/_nuxt/builds/latest.json) and offer a "Reload" banner, also when a code
// chunk of the running build cannot be loaded.
// Not to be confused with the new image notice (server/utils/updates.ts).

// True if the server announces a build other than the one running.
export function isNewBuild(current: string | undefined, latest: unknown): boolean {
  if (!current || !latest || typeof latest !== 'object') return false
  const id = (latest as { id?: unknown }).id
  return typeof id === 'string' && id !== '' && id !== current
}

// What to do when a new service worker finishes installing.
// - No controller: first installation on this origin, nothing to announce.
// - Startup (before our first explicit update check): activate the SW silently
//   for future navigations, without reloading the current page. A cache-first
//   navigation may still run an older shell; the startup build check offers
//   the Reload banner separately. This also covers a reinstall over an old SW.
// - Otherwise the update arrived while the app is in use: banner, so that a
//   message being typed is never lost to a reload.
export type InstalledSwAction = 'none' | 'activate' | 'banner'
export function installedSwAction(hasController: boolean, startup: boolean): InstalledSwAction {
  if (!hasController) return 'none'
  return startup ? 'activate' : 'banner'
}

// Error loading a code chunk (dynamic import): wordings
// of Chromium, WebKit and Firefox.
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(msg)
}
