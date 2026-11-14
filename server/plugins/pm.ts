// Project management after a restart: once herdr-core answers, each unfinished
// run finds its terminal again by its labels (server/utils/pmLaunch.ts), and
// leftover worktrees of done tasks go (pmCleanup.ts; again in poller.ts), and
// done tasks still marked as the user's turn leave it (pmStop.ts), and
// the running coordinators get this version's role files. Then,
// every 30 s, the coordinators' wake queue ticks (pmWakes.ts), and every
// minute the engine makes its mechanical moves (pmMechanic.ts), its step actions
// started outside the tick (pmBoard.ts startAction). Every 30 s,
// one grouped push for new Decisions (pmDecisions.ts), and the projects'
// automations fire (pmAutomations.ts). Every minute, one task's TL;DR is
// written again after a significant change (pmSummary.ts). At start and every
// 5 minutes, the processes left in the worktrees of tasks with no live agent
// are killed (pmProcs.ts). A merge cut by the last restart goes on
// (resumeMerges), and a shutdown first waits a little for a merge that runs.
import { coreAdminDeps } from '../utils/coreAdminDeps'
import { reconcileRuns } from '../utils/pmLaunch'
import { rewriteRoleFiles } from '../utils/pmCoordinator'
import { sweepWorktrees } from '../utils/pmCleanup'
import { repairDoneTasks } from '../utils/pmStop'
import { wakeTick } from '../utils/pmWakes'
import { mechanicTick } from '../utils/pmMechanic'
import { pmStore } from '../utils/pmStore'
import { decisionsTick } from '../utils/pmDecisions'
import { automationTick } from '../utils/pmAutomations'
import { resumeMerges } from '../utils/pmBoard'
import { mergesSettled } from '../utils/pmActions'
import { sweepOrphans } from '../utils/pmProcs'
import { summaryTick } from '../utils/pmSummary'
import { Holds } from '../utils/pmHold'

// Under Nitro's 30 s shutdown and the updater's wait before it kills the server.
const MERGE_WAIT_MS = 20_000

// One run at a time: a pass still going skips the next, said once in the log
// with what it does; a pass hung past its limit no longer holds the next (pmHold.ts).
const every = (name: string, ms: number, fn: (doing: (what: string) => void) => Promise<unknown>) => {
  const busy = new Holds('pass', Math.max(30 * 60_000, 10 * ms))
  let at = 0, doing = '', said = false
  return setInterval(() => {
    const release = busy.take(name, 'its last pass')
    if (!release) {
      if (!said) console.warn(`[pm] ${name}: a pass has run ${Math.round((Date.now() - at) / 1000)} s, past its ${ms / 1000} s interval${doing ? `, at ${doing}` : ''}`)
      said = true
      return
    }
    at = Date.now(), doing = '', said = false
    fn((what) => { doing = what }).catch(() => {}).finally(release)
  }, ms)
}

export default defineNitroPlugin((nitroApp) => {
  void repairDoneTasks(pmStore()).catch(() => {})
  let tries = 0
  const timer = setInterval(() => {
    if (++tries > 30) return clearInterval(timer)
    reconcileRuns({ ...coreAdminDeps(), store: pmStore() }).then(() => {
      clearInterval(timer)
      void sweepWorktrees({ ...coreAdminDeps(), store: pmStore() }).catch(() => {})
      void rewriteRoleFiles({ ...coreAdminDeps(), store: pmStore() }).catch(() => {})
      void resumeMerges({ ...coreAdminDeps(), store: pmStore() }).catch(() => {})
      void sweepOrphans({ ...coreAdminDeps(), store: pmStore() }).catch(() => {})
    }, () => {})
  }, 10_000)
  const wakes = every('wakes', 30_000, () => wakeTick({ ...coreAdminDeps(), store: pmStore() }))
  const mechanic = every('mechanic', 60_000, doing => mechanicTick({ ...coreAdminDeps(), store: pmStore() }, Date.now(), doing))
  const decisions = every('decisions', 30_000, () => decisionsTick(pmStore()))
  const automations = every('automations', 30_000, () => automationTick({ ...coreAdminDeps(), store: pmStore() }))
  const summaries = every('summaries', 60_000, () => summaryTick({ store: pmStore() }))
  const orphans = every('orphans', 300_000, () => sweepOrphans({ ...coreAdminDeps(), store: pmStore() }))
  nitroApp.hooks.hook('close', async () => {
    clearInterval(timer); clearInterval(wakes); clearInterval(mechanic); clearInterval(decisions); clearInterval(automations); clearInterval(summaries); clearInterval(orphans)
    await mergesSettled(MERGE_WAIT_MS)
  })
})
