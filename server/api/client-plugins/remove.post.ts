import { removeClientPlugin } from '../../utils/pluginInstall'

// { id }: deletes the plugin's folder.
export default defineApi(async (_event, body) => {
  await removeClientPlugin(String(body.id || ''))
  return { ok: true }
})
