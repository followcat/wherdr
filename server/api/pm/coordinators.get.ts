// Each project's coordinator: its default agent, the agent of its kept
// conversation, its terminal and the template change waiting for the user.
import { coordinatorsView } from '../../utils/pmCoordinator'
import { pmStore } from '../../utils/pmStore'

export default defineApi(() => coordinatorsView(pmStore()))
