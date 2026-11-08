// { project, autopilot } (project: a project's key, or the main coordinator's): the user sets the coordinator's autopilot (goal,
// interval, fixed times, events, limits, hours). { project, runNow: true }: wake it now,
// whatever wake is still open. The user's session only: the coordinator's
// token never reaches this route.
import { cleanAutopilot } from '../../../shared/pm/autopilot'
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { HerdrError } from '../../utils/herdr'
import { pmStore } from '../../utils/pmStore'
import { isCoordinatorKey } from '../../utils/pmCoordinator'
import { runNow } from '../../utils/pmWakes'

export default defineApi(async (_event, body) => {
  const store = pmStore()
  const key = typeof body.project === 'string' ? body.project : ''
  if (!(await isCoordinatorKey(store, key))) throw new HerdrError('not_found', 'Unknown project')
  if (body.runNow === true) return { sent: await runNow({ ...coreAdminDeps(), store }, key) }
  const r = cleanAutopilot(body.autopilot)
  if ('error' in r) throw new HerdrError('bad_input', r.error)
  const c = await store.coordinator(key)
  // New fixed times count from now: no wake for a slot before they were set.
  const atRan = r.autopilot.at && r.autopilot.at !== c?.autopilot?.at ? Date.now() : c?.atRan
  await store.saveCoordinator({ project: key, tokenHash: '', ...c, autopilot: r.autopilot, ...(atRan ? { atRan } : {}) })
  return r
})
