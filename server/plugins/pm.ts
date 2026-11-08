// Project management after a restart: once herdr-core answers, each unfinished
// run finds its terminal again by its labels (server/utils/pmLaunch.ts), and
// leftover worktrees of done tasks go (pmCleanup.ts; again in poller.ts). Then,
// every 30 s, the coordinators' wake queue ticks (pmWakes.ts), and every
// minute the engine makes its mechanical moves (pmMechanic.ts). Every 30 s,
// one grouped push for new Decisions (pmDecisions.ts), and the projects'
// automations fire (pmAutomations.ts).
import { coreAdminDeps } from '../utils/coreAdminDeps'
import { reconcileRuns } from '../utils/pmLaunch'
import { sweepWorktrees } from '../utils/pmCleanup'
import { wakeTick } from '../utils/pmWakes'
import { mechanicTick } from '../utils/pmMechanic'
import { pmStore } from '../utils/pmStore'
import { decisionsTick } from '../utils/pmDecisions'
import { automationTick } from '../utils/pmAutomations'

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
    reconcileRuns({ ...coreAdminDeps(), store: pmStore() }).then(() => {
      clearInterval(timer)
      void sweepWorktrees({ ...coreAdminDeps(), store: pmStore() }).catch(() => {})
    }, () => {})
  }, 10_000)
  const wakes = every(30_000, () => wakeTick({ ...coreAdminDeps(), store: pmStore() }))
  const mechanic = every(60_000, () => mechanicTick({ ...coreAdminDeps(), store: pmStore() }))
  const decisions = every(30_000, () => decisionsTick(pmStore()))
  const automations = every(30_000, () => automationTick({ ...coreAdminDeps(), store: pmStore() }))
  nitroApp.hooks.hook('close', () => { clearInterval(timer); clearInterval(wakes); clearInterval(mechanic); clearInterval(decisions); clearInterval(automations) })
})
