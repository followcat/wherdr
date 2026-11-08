// { id, how }: the user takes a stopped task up again: continue, as-is or archive.
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { resumeTask } from '../../utils/pmStop'
import { pmStore } from '../../utils/pmStore'
import { publicTask } from '../../../shared/pm/run'
import type { Resume } from '../../../shared/pm/stop'

export default defineApi(async (event, body) => ({
  task: publicTask(await resumeTask({ ...coreAdminDeps(), store: pmStore(), origin: getRequestURL(event).origin }, body.id, body.how as Resume, { who: 'user' }, 'user')),
}))
