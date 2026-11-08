import { coreInputDeps } from './coreInput'
import { getState, poll } from './state'
import { staleCoreDocs } from './readCoreState'
import { recentDirs, rememberDir } from './actions'
import { proxyEnvFor, readProxies, rememberProxyChoice } from './proxies'
import type { CoreAdminDeps } from './coreCreate'

// Real dependencies of the creation and machine routes in core mode.
export function coreAdminDeps(): CoreAdminDeps {
  const d = coreInputDeps()
  return {
    call: d.call,
    machines: () => getState().machines ?? [],
    panes: () => getState().panes,
    workspaces: () => getState().workspaces,
    // Machine list and documents are cached for a few seconds: drop them so the
    // rename/forget/connect that just ran shows in the pushed state at once.
    settle: () => { staleCoreDocs(); return poll() },
    recent: m => recentDirs({ local: m.local, key: m.key, profileId: null }),
    remember: (dir, m) => rememberDir(dir, { local: m.local, key: m.key, profileId: null }),
    proxyEnv: async (key, choice) => proxyEnvFor(await readProxies(), key, choice),
    rememberProxy: (key, choice) => rememberProxyChoice(key, choice),
  }
}
