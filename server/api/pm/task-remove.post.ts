// { id, why? }: the user removes a task never started (no agent, worktree or
// branch); its project's log keeps the line.
import { removeTask } from '../../utils/pmStop'
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (_event, body) =>
  removeTask({ store: pmStore() }, body.id, { who: 'user' }, typeof body.why === 'string' ? body.why : '', 'user'))
