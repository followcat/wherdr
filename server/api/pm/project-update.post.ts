// { key, name?, base?, prefs?, worktree? }: the project's General settings ('' base: the repository's current branch).
// onStateChange: the user's only, never with a token.
import { updateProject } from '../../utils/pmProject'
import { pmStore } from '../../utils/pmStore'

export default defineApi((event, body) => updateProject(pmStore(), body.key, body, getRequestHeader(event, 'authorization')))
