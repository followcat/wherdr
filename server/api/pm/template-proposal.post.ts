// { project, accept }: the user's answer to the coordinator's template change.
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { answerProposal } from '../../utils/pmCoordinator'
import { pmStore } from '../../utils/pmStore'

export default defineApi((_event, body) => answerProposal({ ...coreAdminDeps(), store: pmStore() }, body.project, body.accept))
