// Project management after a restart: once herdr-core answers, each unfinished
// run finds its terminal again by its labels (server/utils/pmLaunch.ts). Then,
// every 30 s, the engine's wakes go to project coordinators (pmCoordinator.ts).
import { coreAdminDeps } from '../utils/coreAdminDeps'
import { reconcileRuns } from '../utils/pmLaunch'
import { deliverWakes } from '../utils/pmCoordinator'
import { pmStore } from '../utils/pmStore'

export default defineNitroPlugin((nitroApp) => {
  let tries = 0
  const timer = setInterval(() => {
    if (++tries > 30) return clearInterval(timer)
    reconcileRuns({ ...coreAdminDeps(), store: pmStore() }).then(() => clearInterval(timer), () => {})
  }, 10_000)
  let busy = false
  const wakes = setInterval(() => {
    if (busy) return
    busy = true
    deliverWakes({ ...coreAdminDeps(), store: pmStore() }).catch(() => {}).finally(() => { busy = false })
  }, 30_000)
  nitroApp.hooks.hook('close', () => { clearInterval(timer); clearInterval(wakes) })
})
