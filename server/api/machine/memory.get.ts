// Settings › Machines and › Pace: each machine's memory, its agents at once and its settings.
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { memoryView } from '../../utils/pmMemory'
import { pmStore } from '../../utils/pmStore'

export default defineApi(() => memoryView({ ...coreAdminDeps(), store: pmStore() }))
