// Workspaces: opening a space from the list (remembered tab),
// tabs at the top of a space, plan of a tab (phone), side-by-side view
// (computer), swiping between the panes of a tab.
import { tabEntry, workspaceTree } from '#shared/workspaces'
import { type Closing, type Landing, type TabMemory, type Viewed, afterClose, neighborTab, rememberTab, spaceTab } from '#shared/spaces'

// Last opened tab of each space, kept on the device.
const tabMemory = ref<TabMemory>({})
if (import.meta.client) {
  try { tabMemory.value = JSON.parse(localStorage.getItem('spaceTabs') || '{}') || {} }
  catch { /* stockage indisponible */ }
}
function saveMemory(m: TabMemory) {
  tabMemory.value = m
  try { localStorage.setItem('spaceTabs', JSON.stringify(m)) }
  catch { /* stockage indisponible */ }
}
// Tab being viewed (tab view, or pane alone in its tab): remembered for its space.
export function noteTab(tabId: string) {
  const e = tabOf(tabId)
  if (!e || tabMemory.value[e.tab.workspace] === tabId) return
  const open = herdrState.value.ok ? herdrState.value.workspaces.map(w => w.id) : undefined
  saveMemory(rememberTab(tabMemory.value, e.tab.workspace, tabId, open))
}

// Panes just closed from the app, hidden until Herdr's state
// removes them (a tab whose panes are all gone disappears with them):
// no ghost tab or cell between the close and the next state.
const gone = shallowRef<Set<string>>(new Set())
watch(herdrState, (s) => {
  if (!gone.value.size) return
  const ids = new Set(s.panes.map(p => p.id))
  const keep = [...gone.value].filter(id => ids.has(id))
  if (keep.length !== gone.value.size) gone.value = new Set(keep)
})
const liveState = computed(() => {
  const s = herdrState.value
  return gone.value.size ? { ...s, panes: s.panes.filter(p => !gone.value.has(p.id)) } : s
})

// Tabs of a space (those that have panes), in Herdr's order.
export function spaceTabs(workspaceId: string) {
  const ws = liveState.value.workspaces.find(w => w.id === workspaceId)
  if (!ws) return []
  return workspaceTree(liveState.value, ws.machine || '').find(w => w.workspace.id === workspaceId)?.tabs.filter(e => e.panes.length) || []
}

// Direction of the last swipe (+1 next, -1 previous): the incoming pane slides
// in from that side.
export const swipeDir = ref<0 | 1 | -1>(0)

export const tabOf = (tabId: string | null | undefined) => (tabId ? tabEntry(liveState.value, tabId) : null)

export const tabPath = (tabId: string) => `/t/${encodeURIComponent(tabId)}`
export const panePath = (paneId: string) => `/a/${encodeURIComponent(paneId)}`

// Path of a tab: a single pane, that pane directly; otherwise its plan
// (phone) or its panes side by side (computer).
export function tabTarget(tabId: string) {
  const e = tabOf(tabId)
  return e && e.panes.length === 1 ? panePath(e.panes[0]!.id) : tabPath(tabId)
}
export function openTab(tabId: string) {
  haptic()
  return navigateTo(tabTarget(tabId))
}
// Open a space from the list: its last tab, otherwise `preferred` (the
// card's representative tab), otherwise that of its most urgent pane.
export function openSpace(workspaceId: string, preferred?: string) {
  const tab = spaceTab(spaceTabs(workspaceId), tabMemory.value, workspaceId, preferred)
  if (tab) return openTab(tab)
}
// Switch tabs in a space (tabs at the top): same history entry.
export function switchSpaceTab(tabId: string) {
  haptic()
  noteTab(tabId)
  return navigateTo(tabTarget(tabId), { replace: true })
}

// Back to the tab's plan: a history back if we came from it (swiping
// replaces the history entry), otherwise we go there.
export function backToTab(tabId: string) {
  haptic()
  const back = (history.state as { back?: string } | null)?.back
  if (back === tabPath(tabId)) return useRouter().back()
  return navigateTo(tabPath(tabId))
}

// ------------------------------------------------------------ closing
// Panes and tabs being closed from the app: their view does not show
// "closed" while it makes way for the destination.
const closingIds = shallowRef<Set<string>>(new Set())
export const isClosing = (id: string) => closingIds.value.has(id)
// Open view (tab or pane), otherwise null.
function viewedNow(): Viewed | null {
  const route = useRouter().currentRoute.value
  if (route.path.startsWith('/t/')) return { tab: String(route.params.tab || '') }
  if (route.path.startsWith('/a/')) return { pane: String(route.params.pane || '') }
  return null
}
// Go to the destination of a close: a history back if we came from it,
// otherwise in place of the closed view (no dead entry in the history).
function land(l: Landing) {
  if (!l) return
  const path = l === 'home' ? '/' : 'tab' in l ? tabPath(l.tab) : panePath(l.pane)
  const back = (history.state as { back?: string } | null)?.back
  if (back === path) return useRouter().back()
  return navigateTo(path, { replace: true })
}
// Close confirmed, before the call to Herdr: destination decided on the known
// state (closing a tab shows its neighbour, like Herdr; the list only
// when the space has nothing left). Returns the continuation, called with the result of
// the call: on success, hide what is leaving, remember the neighbouring tab, go there.
export function prepareClose(closing: Closing, groupWorkspaces: string[] = []) {
  const s = liveState.value
  const viewed = viewedNow()
  const viewedPane = viewed && 'pane' in viewed ? s.panes.find(p => p.id === viewed.pane) : undefined
  const viewedWorkspace = viewedPane?.workspace ?? (viewed && 'tab' in viewed ? s.tabs?.find(t => t.id === viewed.tab)?.workspace : undefined)
  const landing = groupWorkspaces.length && viewedWorkspace && groupWorkspaces.includes(viewedWorkspace)
    ? 'home' : afterClose(s, closing, viewed)
  const panes = s.panes.filter(p => groupWorkspaces.length ? groupWorkspaces.includes(p.workspace)
    : 'tab' in closing ? p.tab === closing.tab : 'pane' in closing ? p.id === closing.pane : p.workspace === closing.workspace)
  // Tab disappearing (closed, or its last pane): its neighbour becomes
  // the space's remembered tab if it was.
  const p0 = panes[0]
  const tab = groupWorkspaces.length ? null : 'tab' in closing ? closing.tab : 'pane' in closing && p0 && s.panes.filter(p => p.tab === p0.tab).length === 1 ? p0.tab : null
  const ws = p0?.workspace
  const next = tab ? neighborTab(s, tab) : null
  const ids = [...panes.map(p => p.id), ...new Set(panes.map(p => p.tab))]
  closingIds.value = new Set([...closingIds.value, ...ids])
  const release = () => { closingIds.value = new Set([...closingIds.value].filter(id => !ids.includes(id))) }
  return (ok: boolean) => {
    // The closed view has time to leave before announcing "closed".
    if (!ok) return release()
    setTimeout(release, 1500)
    gone.value = new Set([...gone.value, ...panes.map(p => p.id)])
    if (tab && next && ws && tabMemory.value[ws] === tab) saveMemory(rememberTab(tabMemory.value, ws, next))
    land(landing)
  }
}
