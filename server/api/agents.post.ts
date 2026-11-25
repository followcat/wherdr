import { coreAdminDeps } from '../utils/coreAdminDeps'
import { coreCreate } from '../utils/coreCreate'

export default defineApi((_event, b) => coreCreate(coreAdminDeps(typeof b.beside === 'string' && b.beside ? b.beside : b.machine), b))
