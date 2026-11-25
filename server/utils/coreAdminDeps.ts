import { coreInputDeps } from './coreInput'
import { CoreError } from './core'
import { takingTurns } from './terminalTurns'
import { coreForMachine, coreForPane, corePool, corePrimary, getState, heldMessages, poll, transcripts } from './state'
import { recentDirs, rememberDir } from './actions'
import { proxyEnvFor, readProxies, rememberProxyChoice } from './proxies'
import type { CoreAdminDeps } from './coreCreate'

// Real dependencies of the creation and machine routes in core mode.
export function coreAdminDeps(targetKeyOrPane?: unknown): CoreAdminDeps {
  const key = typeof targetKeyOrPane === 'string' ? targetKeyOrPane : ''
  const entry = key ? (coreForPane(key) ?? coreForMachine(key)) : corePrimary()
  const unavailable = () => Promise.reject(new CoreError('unavailable', 'Missing core endpoint'))
  const callFor = (machineKey: string) => {
    const e = machineKey ? coreForMachine(machineKey) : corePrimary()
    return takingTurns((method, params, timeout) => (e ? e.call(method, params, timeout) : unavailable()))
  }
  return {
    // The engine's messages (wakes, reports…) wait for the user's, and the reverse.
    call: takingTurns((method, params, timeout) => (entry ? entry.call(method, params, timeout) : unavailable())),
    callFor,
    machines: () => getState().machines ?? [],
    panes: () => getState().panes,
    workspaces: () => getState().workspaces,
    // Machine list and documents are cached for a few seconds: drop them so the
    // rename/forget/connect that just ran shows in the pushed state at once.
    settle: () => { corePool.staleDocs(); return poll() },
    recent: m => recentDirs({ local: m.local, key: m.key, profileId: null }),
    remember: (dir, m) => rememberDir(dir, { local: m.local, key: m.key, profileId: null }),
    proxyEnv: async (key, choice) => proxyEnvFor(await readProxies(), key, choice),
    rememberProxy: (key, choice) => rememberProxyChoice(key, choice),
    chat: async pane => (await transcripts.chat(pane)).items ?? null,
    hold: (pane, text, byHolder) => heldMessages.hold(pane, text, undefined, byHolder),
    handOver: (address, id, typed) => heldMessages.handOver(address, id, typed),
  }
}
