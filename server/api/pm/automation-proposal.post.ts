// { project, id, accept }: the user's answer to an automation the coordinator or Alfred proposed.
import { coreAdminDeps } from '../../utils/coreAdminDeps'
import { answerAutomationProposal } from '../../utils/pmAutomations'
import { pmStore } from '../../utils/pmStore'

export default defineApi((_event, body) =>
  answerAutomationProposal({ ...coreAdminDeps(), store: pmStore() }, String(body.project ?? ''), String(body.id ?? ''), body.accept === true))
