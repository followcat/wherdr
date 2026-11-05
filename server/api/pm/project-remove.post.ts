// { key }: forgets a project (its folder and repository stay as they are).
import { pmStore } from '../../utils/pmStore'

export default defineApi(async (_event, body) => {
  await pmStore().removeProject(body.key)
  return { ok: true }
})
