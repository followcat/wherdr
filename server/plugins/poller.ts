// Background tasks: herdr-core state (see state.ts), VAPID keys, the phone
// address `tailscale serve` publishes (server/utils/phone.ts), purge of photos
// and attached files older than 7 days, and of the pasted texts kept for 30 days;
// leftover worktrees of done or archived tasks (server/utils/pmCleanup.ts).
import { coreAdminDeps } from '../utils/coreAdminDeps'
import { sweepWorktrees } from '../utils/pmCleanup'
import { pmStore } from '../utils/pmStore'

export default defineNitroPlugin((nitroApp) => {
  initVapid()
  startPolling()
  startTailnetWatch()
  cleanUploads()
  cleanAttachments()
  purgePastes()
  const purge = setInterval(() => {
    cleanUploads(); cleanAttachments(); purgePastes()
    void sweepWorktrees({ ...coreAdminDeps(), store: pmStore() }).catch(() => {})
  }, 6 * 3600 * 1000)
  nitroApp.hooks.hook('close', () => { stopPolling(); stopTailnetWatch(); clearInterval(purge) })
})
