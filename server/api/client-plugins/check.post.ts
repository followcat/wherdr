import { checkPluginSource } from '../../utils/pluginInstall'

// { id }: the newer commit of a plugin installed from GitHub, or null. Installs nothing.
export default defineApi(async (_event, body) => ({ update: await checkPluginSource(String(body.id || '')) }))
