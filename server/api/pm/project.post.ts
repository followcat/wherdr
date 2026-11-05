// Adds a project: { key, name?, machine, path, base?, template? }. The folder
// must be a git repository on a machine herdr-core reaches.
import { pmStore } from '../../utils/pmStore'
import { pmFolderCheck } from '../../utils/pmFolder'

export default defineApi(async (_event, body) => ({ project: await pmStore().addProject(body, pmFolderCheck) }))
