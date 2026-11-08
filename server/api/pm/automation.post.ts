// The user's automations of a project: { project, automation } adds one, or
// changes the one with its `id`; { project, id, remove: true } removes it;
// { project, id, runNow: true } fires it now, on or off. The user's session
// only: the coordinator reads them with `wherdr pm automation`.
import { cleanAutomation } from '../../../shared/pm/automations'
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { HerdrError } from '../../utils/herdr'
import { fireAutomation } from '../../utils/pmAutomations'
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (event, body) => {
  const store = pmStore()
  const key = typeof body.project === 'string' ? body.project : ''
  const p = await store.project(key)
  if (!p) throw new HerdrError('not_found', 'Unknown project')
  const types = Object.keys(((await store.workflow(p.key))?.taskTypes) || {})
  const id = typeof body.id === 'string' ? body.id : typeof body.automation?.id === 'string' ? body.automation.id : ''
  if (body.runNow === true) return { firing: await fireAutomation({ ...coreAdminDeps(), store, origin: getRequestURL(event).origin }, key, id) }
  const automations = await store.changeAutomations(key, (f) => {
    const i = f.automations.findIndex(a => a.id === id)
    if ((id || body.remove === true) && i < 0) throw new HerdrError('not_found', 'Unknown automation')
    if (body.remove === true) return { file: { ...f, automations: f.automations.filter(a => a.id !== id) }, out: f.automations.filter(a => a.id !== id) }
    const r = cleanAutomation(body.automation, f.automations[i], Date.now())
    if ('error' in r) throw new HerdrError('bad_input', r.error)
    if (r.automation.type && !types.includes(r.automation.type)) throw new HerdrError('bad_input', `type: one of the template's task types (${types.join(', ') || 'none yet'})`)
    if (i < 0 && f.automations.some(a => a.id === r.automation.id)) throw new HerdrError('exists', 'An automation already has this name')
    const list = i < 0 ? [...f.automations, r.automation] : f.automations.map((a, j) => (j === i ? r.automation : a))
    return { file: { ...f, automations: list }, out: list }
  })
  return { automations }
})
