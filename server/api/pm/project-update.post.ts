// { key, name?, base?, prefs?, worktree? }: the project's General settings ('' base: the repository's current branch).
import { updateProject } from '../../utils/pmProject'
import { pmStore } from '../../utils/pmStore'

export default defineApi((_event, body) => updateProject(pmStore(), body.key, body))
