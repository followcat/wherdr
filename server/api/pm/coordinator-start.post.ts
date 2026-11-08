// { project, program }: starts the project's coordinator in its own
// folder, with its role files and a new token (the one before stops working).
// It reaches wherdr on loopback when it runs on this machine; from another
// machine, at wherdr's published address (or the one this request came to,
// when it is not loopback).
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { coordinatorUrls, startCoordinator } from '../../utils/pmCoordinator'
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (event, body) =>
  startCoordinator({ ...coreAdminDeps(), store: pmStore() }, body.project, body, coordinatorUrls(getRequestURL(event))))
