// The login incidents still holding tasks (shared/pm/incident.ts openLogins),
// for the home's one notice each; terminal: a stuck agent's, where /login renews it.
import { pmStore } from '../../utils/pmStore'
import { openLogins } from '../../../shared/pm/incident'

export default defineApi(async () => {
  const store = pmStore()
  if (!await store.enabled()) return []
  const incidents = await store.incidents(), tasks = await store.tasks(), runs = await store.runs()
  return openLogins(incidents, tasks).map((l) => {
    const i = incidents.find(x => x.id === l.id)!
    const terminal = runs.find(r => i.runs.includes(r.id) && r.state !== 'ended' && r.terminal)?.terminal
    return { ...l, ...(terminal ? { terminal } : {}) }
  })
})
