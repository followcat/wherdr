// Background tasks: herdr-core state (see state.ts), VAPID keys, the phone
// address `tailscale serve` publishes (server/utils/phone.ts), purge of photos
// and attached files older than 7 days, and of the pasted texts kept for 30 days;
// leftover worktrees of done or archived tasks (server/utils/pmCleanup.ts), and
// done tasks past their project's delay, archived off the board (archiveDone);
// messages to Claude a restart interrupted while submitting (submitting.ts).
import { coreAdminDeps } from '../utils/coreAdminDeps'
import { sweepWorktrees } from '../utils/pmCleanup'
import { pmStore } from '../utils/pmStore'
import { archiveDone } from '../utils/pmBoard'
import { takeSubmitting } from '../utils/submitting'

export default defineNitroPlugin((nitroApp) => {
  initVapid()
  startPolling()
  startTailnetWatch()
  cleanUploads()
  cleanAttachments()
  purgePastes()
  void archiveDone(pmStore()).catch(() => {})
  const pending = takeSubmitting()
  if (pending.length) void resumeSubmitting(coreInputDeps(), pending)
  const purge = setInterval(() => {
    cleanUploads(); cleanAttachments(); purgePastes()
    void sweepWorktrees({ ...coreAdminDeps(), store: pmStore() }).catch(() => {})
    void archiveDone(pmStore()).catch(() => {})
  }, 6 * 3600 * 1000)
  nitroApp.hooks.hook('close', () => { stopPolling(); stopTailnetWatch(); clearInterval(purge) })
  // Before Nitro's graceful shutdown closes the sockets (a service restart sends SIGTERM).
  process.once('SIGTERM', announceRestart)
})
