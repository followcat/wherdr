// `wherdr alfred …` from Alfred: { argv } with the token of its home
// (Authorization: Bearer). Only from this machine: a request relayed from
// the tailnet or anywhere else is refused, whatever its token.
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { runAlfredCommand } from '../../utils/alfredCli'
import { HerdrError } from '../../utils/herdr'
import { checkRequestClient } from '../../utils/network'
import { coordinatorUrls, takeUpdateNotice } from '../../utils/pmCoordinator'
import { MAIN } from '../../../shared/pm/coordinator'
import { pmFolderCheck } from '../../utils/pmFolder'
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (event, body) => {
  const check = checkRequestClient(event.node.req.socket?.remoteAddress, event.node.req.headers)
  if (!check.ok || check.zone !== 'local') throw new HerdrError('forbidden', 'wherdr alfred works on wherdr\'s own machine only')
  const token = String(getRequestHeader(event, 'authorization') || '').replace(/^Bearer\s+/i, '')
  const out = await runAlfredCommand({ ...coreAdminDeps(), store: pmStore(), check: pmFolderCheck, urls: coordinatorUrls(getRequestURL(event)), clients: () => eventClients.values() }, token, body)
  const notice = await takeUpdateNotice(pmStore(), MAIN)
  if (notice) setResponseHeader(event, 'x-wherdr-notice', notice)
  return out
})
