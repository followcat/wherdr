// Keep a machine awake for a while, extend, or turn off: { key, mode }.
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { coreSetAwake } from '../../utils/coreAwake'

export default defineApi((_event, body) => coreSetAwake(coreAdminDeps(), body))
