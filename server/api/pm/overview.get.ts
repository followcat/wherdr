// Project management: the switch, the projects and the saved templates.
import { pmStore } from '../../utils/pmStore'

export default defineApi(() => pmStore().overview())
