// { key, machine }: runs the readiness check of an allowed machine for the
// project (pmReady.ts), as the project sheet does after adding it.
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { checkMachine } from '../../utils/pmReady'
import { pmStore } from '../../utils/pmStore'

export default defineApi((event, body) => checkMachine({ ...coreAdminDeps(), store: pmStore(), origin: getRequestURL(event).origin }, body.key, body.machine))
