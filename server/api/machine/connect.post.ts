import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { coreConnectMachine } from '../../utils/coreCreate'

export default defineApi((_event, body) => coreConnectMachine(coreAdminDeps(body.key), body.key))
