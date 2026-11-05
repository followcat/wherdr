// `wherdr pm …` from a project coordinator: { argv, input? } with its token
// (Authorization: Bearer). The token is the only right: one project, checked
// command by command (server/utils/pmCoordinator.ts).
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { runCommand } from '../../utils/pmCoordinator'
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (event, body) => {
  const token = String(getRequestHeader(event, 'authorization') || '').replace(/^Bearer\s+/i, '')
  return runCommand({ ...coreAdminDeps(), store: pmStore() }, token, body)
})
