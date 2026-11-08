// What waits for the user's choice, grouped, the recommended answer first.
import { decisions } from '../../utils/pmDecisions'
import { pmStore } from '../../utils/pmStore'

export default defineApi(() => decisions(pmStore()))
