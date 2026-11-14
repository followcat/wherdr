// ?key=: the project, its own workflow, the workflow's log, its machines' last readiness and the coordinator's waiting proposal.
import { projectView } from '../../utils/pmProject'
import { pmStore } from '../../utils/pmStore'

export default defineApi(event => projectView(pmStore(), String(getQuery(event).key ?? '')))
