// `wherdr pm …` from a project coordinator: { argv, input? } with its token
// (Authorization: Bearer). The token is the only right: one project, checked
// command by command (server/utils/pmCoordinator.ts).
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { runCommand, scopeOf, takeUpdateNotice } from '../../utils/pmCoordinator'
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (event, body) => {
  const token = String(getRequestHeader(event, 'authorization') || '').replace(/^Bearer\s+/i, '')
  const out = await runCommand({ ...coreAdminDeps(), store: pmStore(), clients: () => eventClients.values() }, token, body)
  // Once after an update: the line the command's output starts with (the CLI prints it).
  const notice = await takeUpdateNotice(pmStore(), await scopeOf(pmStore(), token))
  if (notice) setResponseHeader(event, 'x-wherdr-notice', notice)
  return out
})
