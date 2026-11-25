// wherdr plugins: the page-side host (utils/pluginHost.ts) wired to the app.
import { effectScope, onBeforeUnmount, watch } from 'vue'
import { projectAgents, projectMachines, readPrefs } from '#shared/clientPlugins'
import type { ClientPluginInfo, PluginPrefs, PluginSource, PublicAgent } from '#shared/clientPlugins'
import { createHeaderActionsMount } from '~/utils/headerActions'
import { createPluginHost, type HostDeps, type PluginRow } from '~/utils/pluginHost'
import { settingsSync, syncedRef } from './useSyncedSettings'

const PREFS_KEY = 'wherdr:plugins'
export const clientPlugins = ref<PluginRow[]>([])
// The Community plugins switch (server-wide, shared/clientPlugins.ts). The
// loader starts from the server's answer; a change here or on another device
// reaches the host through this ref.
export const communityPlugins = syncedRef('communityPlugins', raw => raw === '1', v => (v ? '1' : '0'))
let host: ReturnType<typeof createPluginHost> | null = null
const draftFocusers: { pane: () => string, live: () => boolean, focus: () => void }[] = []

/** Register the active conversation's composer focus handler for plugin draft.focus(). */
export function useDraftFocus(pane: () => string, live: () => boolean, focus: () => void) {
  const entry = { pane, live, focus }
  draftFocusers.push(entry)
  onBeforeUnmount(() => {
    const i = draftFocusers.indexOf(entry)
    if (i >= 0) draftFocusers.splice(i, 1)
  })
}

const loadPrefs = () => { try { return readPrefs(localStorage.getItem(PREFS_KEY)) } catch { return readPrefs(null) } }
const savePrefs = (p: PluginPrefs) => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch { /* storage unavailable */ } }

function createHerdrAgentsSubscription() {
  const subs = new Set<(agents: PublicAgent[]) => void>()
  let stopWatch: (() => void) | null = null
  let lastJson = ''

  const startWatch = () => {
    lastJson = JSON.stringify(projectAgents(herdrState.value.panes))
    const scope = effectScope(true)
    scope.run(() => {
      watch(herdrState, (state) => {
        const next = projectAgents(state.panes)
        const nextJson = JSON.stringify(next)
        if (nextJson === lastJson) return
        lastJson = nextJson
        for (const sub of [...subs]) if (subs.has(sub)) sub(next)
      }, { flush: 'sync' })
    })
    stopWatch = () => scope.stop()
  }

  return (cb: (agents: PublicAgent[]) => void) => {
    subs.add(cb)
    if (subs.size === 1) startWatch()
    return () => {
      if (!subs.delete(cb) || subs.size > 0) return
      stopWatch?.()
      stopWatch = null
      lastJson = ''
    }
  }
}

/** Build host dependencies wired to the running Nuxt app (exposed for tests). */
export function createAppPluginDeps(changed: () => void, overrides: Partial<HostDeps> = {}): HostDeps {
  const router = useRouter()
  const mountHeaderAction = createHeaderActionsMount()
  const subscribeAgents = createHerdrAgentsSubscription()
  return {
    list: () => api<{ plugins: ClientPluginInfo[], enabled: boolean }>('/api/client-plugins'),
    // The commit sits in the folder part (`<id>@<commit>/`), so the bundle's
    // relative imports also get new URLs after an update, not only the main file.
    load: info => import(/* @vite-ignore */ `${location.origin}/api/client-plugins/${encodeURIComponent(info.id)}${info.source?.commit ? `@${info.source.commit}` : ''}/${encodeURIComponent(info.main)}`),
    getDraft: () => (curPane.value ? useDraft(curPane.value).text : null),
    setDraft: (text) => {
      if (!curPane.value) return
      useDraft(curPane.value).text = text
    },
    insertDraft: (text) => {
      if (!curPane.value) return
      const d = useDraft(curPane.value)
      d.text = d.text && !/\s$/.test(d.text) ? `${d.text} ${text}` : d.text + text
    },
    focusDraft: () => {
      if (!curPane.value) return
      for (let i = draftFocusers.length - 1; i >= 0; i--) {
        const entry = draftFocusers[i]!
        if (entry.live() && entry.pane() === curPane.value) { entry.focus(); return }
      }
    },
    currentAgent: () => {
      const p = herdrState.value.panes.find(x => x.id === curPane.value)
      return p ? { id: p.id, agent: p.agent, name: p.name || p.label || null, machine: p.machine || null } : null
    },
    agents: () => projectAgents(herdrState.value.panes),
    machines: () => projectMachines(herdrState.value.machines ?? []),
    subscribeNavigate: cb => router.afterEach(to => cb(to.fullPath)),
    subscribeAgents,
    mountHeaderAction,
    prefs: loadPrefs,
    savePrefs,
    changed,
    // The server's answer updates the copy as a server value: never sent back.
    onCommunity: (on) => { settingsSync.receive({ communityPlugins: on ? '1' : '0' }) },
    ...overrides,
  }
}

export function startClientPlugins() {
  if (host) return host
  host = createPluginHost(createAppPluginDeps(() => { clientPlugins.value = host!.rows() }))
  const h = host
  // Detached: the first caller can be a component, and this outlives it.
  effectScope(true).run(() => watch(communityPlugins, on => h.setCommunity(on)))
  h.init()
  return h
}
export const setClientPluginEnabled = (id: string, on: boolean) => startClientPlugins().setEnabled(id, on)

// Install from GitHub (server/utils/pluginInstall.ts). What would be installed,
// with the exact commit; nothing is written until installPlugin.
export interface PluginPreview extends ClientPluginInfo { source: PluginSource, resolved: string, update: boolean }
export const previewPlugin = (spec: string) => api<{ preview: PluginPreview }>('/api/client-plugins/preview', { spec }).then(r => r.preview)
export const checkPluginUpdate = (id: string) => api<{ update: PluginPreview | null }>('/api/client-plugins/check', { id }).then(r => r.update)
// Installing comes after the full-access warning, so it also turns Community plugins on.
export async function installPlugin(source: PluginSource) {
  await updatePlugin(source)
  communityPlugins.value = true
}
// Update writes the new commit and leaves Community plugins as it is: only the
// Install sheet and the switch, each after the full-access warning, turn it on.
export async function updatePlugin(source: PluginSource) {
  await api('/api/client-plugins/install', { source })
  await startClientPlugins().refresh()
}
export async function removePlugin(id: string) {
  await api('/api/client-plugins/remove', { id })
  await startClientPlugins().refresh()
}
