// Project management after a restart: once herdr-core answers, each unfinished
// run finds its terminal again by its labels (server/utils/pmLaunch.ts). Then,
// every 30 s, the coordinators' wake queue ticks (pmWakes.ts), and every
// minute the engine makes its mechanical moves (pmMechanic.ts).
import { coreAdminDeps } from '../utils/coreAdminDeps'
import { reconcileRuns } from '../utils/pmLaunch'
import { wakeTick } from '../utils/pmWakes'
import { mechanicTick } from '../utils/pmMechanic'
import { pmStore } from '../utils/pmStore'

// One run at a time: a tick still going skips the next.
const every = (ms: number, fn: () => Promise<unknown>) => {
  let busy = false
  return setInterval(() => {
    if (busy) return
    busy = true
    fn().catch(() => {}).finally(() => { busy = false })
  }, ms)
}

export default defineNitroPlugin((nitroApp) => {
  let tries = 0
  const timer = setInterval(() => {
    if (++tries > 30) return clearInterval(timer)
    reconcileRuns({ ...coreAdminDeps(), store: pmStore() }).then(() => clearInterval(timer), () => {})
  }, 10_000)
  const wakes = every(30_000, () => wakeTick({ ...coreAdminDeps(), store: pmStore() }))
  const mechanic = every(60_000, () => mechanicTick({ ...coreAdminDeps(), store: pmStore() }))
  nitroApp.hooks.hook('close', () => { clearInterval(timer); clearInterval(wakes); clearInterval(mechanic) })
})
