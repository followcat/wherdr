import { previewFromGitHub } from '../../utils/pluginInstall'

// { spec: 'owner/repo[@ref]' }: what Install from GitHub would install (manifest and exact commit).
export default defineApi(async (_event, body) => ({ preview: await previewFromGitHub(String(body.spec || '')) }))
