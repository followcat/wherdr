// { project, program }: starts the project's coordinator in its own
// folder, with its role files and a new token (the one before stops working).
// It reaches wherdr on loopback when it runs on this machine; from another
// machine, at wherdr's published address (or the one this request came to,
// when it is not loopback).
// { project, resend: true }: Send again, the first message its session never got (a new
// conversation when that session ended).
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { coordinatorUrls, startCoordinator } from '../../utils/pmCoordinator'
import { resendFirst } from '../../utils/coordinatorFirst'
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (event, body) => {
  const deps = { ...coreAdminDeps(), store: pmStore() }
  const urls = coordinatorUrls(getRequestURL(event))
  if (body.resend === true) return resendFirst(deps, String(body.project), () => startCoordinator(deps, body.project, {}, urls))
  return startCoordinator(deps, body.project, body, urls)
})
