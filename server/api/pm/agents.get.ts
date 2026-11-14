// The running agents of tasks, by herdr-core address: the task each works on
// and its role, for their sidebar rows ({} with projects off).
import { boardAgents } from '../../utils/pmBoard'
import { pmStore } from '../../utils/pmStore'

export default defineApi(() => boardAgents(pmStore()))
