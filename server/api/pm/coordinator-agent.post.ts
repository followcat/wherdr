// { project, program, model }: the project coordinator's default agent.
import { setCoordinatorAgent } from '../../utils/pmCoordinator'
import { pmStore } from '../../utils/pmStore'

export default defineApi((_event, body) => setCoordinatorAgent(pmStore(), body.project, body))
