// Alfred, wherdr's assistant: its name (identity.md), the agent the user chose
// for it, and its conversation. Shown with projects on or off.
import { alfredView } from '../utils/pmCoordinator'
import { pmStore } from '../utils/pmStore'

export default defineApi(() => alfredView({ store: pmStore() }))
