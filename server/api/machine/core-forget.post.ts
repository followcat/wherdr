import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { coreForgetMachine } from '../../utils/coreCreate'

export default defineApi((_event, body) => coreForgetMachine(coreAdminDeps(body.key), body.key))
