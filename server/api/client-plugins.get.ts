import { communityPluginsOn, listClientPlugins } from '../utils/clientPlugins'

// Installed wherdr plugins (DATA_DIR/plugins) and the Community plugins switch,
// for the page's loader: it loads none while the switch is off.
export default defineEventHandler(async () => {
  const plugins = await listClientPlugins()
  return { plugins, enabled: await communityPluginsOn(plugins.length) }
})
