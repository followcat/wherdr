// { project, autopilot }: the user sets the coordinator's autopilot (goal,
// interval, events, limits, hours). { project, runNow: true }: wake it now,
// whatever wake is still open. The user's session only: the coordinator's
// token never reaches this route.
import { cleanAutopilot } from '../../../shared/pm/autopilot'
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { HerdrError } from '../../utils/herdr'
import { pmStore } from '../../utils/pmStore'
import { runNow } from '../../utils/pmWakes'

export default defineApi(async (_event, body) => {
  const store = pmStore()
  const key = typeof body.project === 'string' ? body.project : ''
  if (!(await store.projects()).some(p => p.key === key)) throw new HerdrError('not_found', 'Unknown project')
  if (body.runNow === true) return { sent: await runNow({ ...coreAdminDeps(), store }, key) }
  const r = cleanAutopilot(body.autopilot)
  if ('error' in r) throw new HerdrError('bad_input', r.error)
  await store.saveCoordinator({ project: key, tokenHash: '', ...(await store.coordinator(key)), autopilot: r.autopilot })
  return r
})
