import { parseSource } from '../../../shared/clientPlugins'
import { HerdrError } from '../../utils/herdr'
import { installFromGitHub } from '../../utils/pluginInstall'

// { source: { repo, ref, commit } }: installs (or updates) a plugin at that exact commit.
export default defineApi(async (_event, body) => {
  const source = parseSource(body.source)
  if (!source) throw new HerdrError('plugin_install', 'Bad source.')
  return { plugin: await installFromGitHub(source) }
})
