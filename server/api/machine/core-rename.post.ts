import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { coreRenameMachine } from '../../utils/coreCreate'

export default defineApi((_event, body) => coreRenameMachine(coreAdminDeps(body.key), body))
