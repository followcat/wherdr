// { key, id }: "Save as template": the project's workflow is copied into the library as `id`.
import { templateFromProject } from '../../utils/pmProject'
import { pmStore } from '../../utils/pmStore'

export default defineApi((_event, body) => templateFromProject(pmStore(), body.key, body.id))
