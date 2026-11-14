// A machine's keep-awake state (Settings › Machines, its tab's menu): ?key=, '' = this one.
import { getQuery } from 'h3'
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { coreAwakeStatus } from '../../utils/coreAwake'

export default defineApi(event => coreAwakeStatus(coreAdminDeps(), getQuery(event).key))
