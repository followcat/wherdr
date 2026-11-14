// The user's switch on a project's automation: { project, id, on }; or
// { project, id, runNow: true } fires it now, on or off. The user's session
// only: the coordinator or Alfred proposes the rest (`wherdr pm automation propose`).
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { HerdrError } from '../../utils/herdr'
import { fireAutomation } from '../../utils/pmAutomations'
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (event, body) => {
  const store = pmStore()
  const key = typeof body.project === 'string' ? body.project : ''
  if (!(await store.project(key))) throw new HerdrError('not_found', 'Unknown project')
  const id = typeof body.id === 'string' ? body.id : ''
  if (body.runNow === true) return { firing: await fireAutomation({ ...coreAdminDeps(), store, origin: getRequestURL(event).origin }, key, id) }
  if (typeof body.on !== 'boolean') throw new HerdrError('bad_input', 'on: true or false')
  const automations = await store.changeAutomations(key, (f) => {
    if (!f.automations.some(a => a.id === id)) throw new HerdrError('not_found', 'Unknown automation')
    // Switched on: missed slots count from now.
    const list = f.automations.map(a => (a.id === id ? { ...a, on: body.on, ...(body.on && !a.on ? { last: Date.now() } : {}) } : a))
    return { file: { ...f, automations: list }, out: list }
  })
  return { automations }
})
