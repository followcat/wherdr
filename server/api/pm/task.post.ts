// Adds a task to do: { project, title, description?, type }.
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (_event, body) => ({ task: await pmStore().addTask(body) }))
