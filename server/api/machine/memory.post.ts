// { key, minFreeGb?, maxAgents? }: the user's memory settings of a machine
// (minFreeGb or maxAgents null: back to Auto). Answers with every machine.
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { HerdrError } from '../../utils/herdr'
import { memoryView, setMemorySettings } from '../../utils/pmMemory'
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (_event, body) => {
  const deps = { ...coreAdminDeps(), store: pmStore() }
  if (typeof body.key !== 'string' || !deps.machines().some(m => m.key === body.key)) throw new HerdrError('bad_machine', 'unknown machine')
  await setMemorySettings(body.key, body)
  return memoryView(deps)
})
