// Adds a task to do: { project, title, description?, type }.
import { pmStore } from '../../utils/pmStore'

// Added in wherdr: the user's, whatever the body says.
export default defineApi(async (_event, body) => ({ task: await pmStore().addTask({ ...(body && typeof body === 'object' ? body : {}), addedBy: 'user' }) }))
