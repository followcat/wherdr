// New version after a deployment (replaces Nuxt's automatic
// reloads, turned off in nuxt.config.ts): check every
// 5 min, on returning to the page and on reconnection to the server (at most once a minute);
// missing code chunk during a navigation → the banner if a newer build is served,
// never a reload by itself (the user reloads with the banner).
import { isChunkLoadError } from '../utils/appVersion'

const CHECK_EVERY_MS = 5 * 60000

export default defineNuxtPlugin((nuxtApp) => {
  const router = useRouter()
  const chunkErrors = new Set<unknown>()
  router.beforeEach(() => { chunkErrors.clear() })
  nuxtApp.hook('app:chunkError', ({ error }) => { chunkErrors.add(error) })
  router.onError((error) => {
    if (!chunkErrors.has(error) && !isChunkLoadError(error)) return
    void offerNewBuild()
  })

  setInterval(() => { if (!document.hidden) checkNewVersion() }, CHECK_EVERY_MS)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkNewVersionOnWake() })
})
