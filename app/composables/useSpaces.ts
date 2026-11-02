// Actions on spaces, tabs and panes ("…" menus of the list by
// space, of a tab's plan and of the agent view): new tab, split,
// rename, close, move, drag and drop, resize. Always on an
// explicit gesture; never zoom (the layout is shared with the attached client).
import type { Pane } from '#shared/types'
import { type MoveDestination, type SpaceEntry, type SplitDirection, moveTargets, paneSpaceEntries } from '#shared/spaceActions'
import { reorderWorkspaces } from '#shared/spaces'
import { type DropSide, type PaneDirection, type TabLayout, directionNeighbor, dropPreview, layoutTree, resizePreview, swapDirections, swapInLayout } from '#shared/layout'
import { closeConfirm } from '~/utils/spaceConfirm'
import { herdrPaneId, paneIdLine } from '~/utils/paneId'

// Renommer un espace ou un onglet (le pane garde `renameTarget`).
export const renameSpace = ref<{ kind: 'workspace' | 'tab', id: string, label: string } | null>(null)
// "New tab" in this space, or "Split" this pane in this direction: the
// "New agent" sheet only creates the tab or pane on "Launch".
export const newTabSpace = ref<string | null>(null)
export const newSplit = ref<{ paneId: string, direction: SplitDirection } | null>(null)

interface SpaceReply { ok: boolean, pane_id?: string, tab_id?: string }
async function spaceApi(body: Record<string, unknown>): Promise<SpaceReply | null> {
  haptic()
  try { return await api<SpaceReply>('/api/space', body) }
  catch (err) {
    toast((err as Error).message, true)
    return null
  }
}

// New tab: the "New agent" sheet opens first, nothing is
// created; the tab is born on clicking "Launch" (NewAgentSheet), closing it
// has left no trace in Herdr.
export function newTab(workspaceId: string) {
  haptic()
  newSplit.value = null
  newTabSpace.value = workspaceId
  newAgentOpen.value = true
}
// Split: same principle, the pane is born on clicking "Launch".
export function splitPane(p: Pane, direction: SplitDirection) {
  haptic()
  newTabSpace.value = null
  newSplit.value = { paneId: p.id, direction }
  newAgentOpen.value = true
}

export function renameWorkspace(id: string) {
  const w = herdrState.value.workspaces.find(x => x.id === id)
  if (w) renameSpace.value = { kind: 'workspace', id, label: w.label }
}
export function renameTab(id: string) {
  const e = tabOf(id)
  if (e) renameSpace.value = { kind: 'tab', id, label: e.tab.label }
}
export async function saveSpaceName(label: string) {
  const x = renameSpace.value
  if (!x) return
  const r = await spaceApi(x.kind === 'tab' ? { op: 'tab.rename', tab_id: x.id, label } : { op: 'workspace.rename', workspace_id: x.id, label })
  if (!r) return
  if (!r.ok) { toast(t('Rename failed. The name was not changed.'), true); return }
  renameSpace.value = null
  toast(t('Renamed'))
}

export async function closeTab(id: string) {
  const e = tabOf(id)
  if (!e) return
  const workspace = e.tab.workspace
  const plan = await confirmClose('tab', id, () => {
    const now = tabOf(id) || e
    const ws = herdrState.value.workspaces.find(w => w.id === workspace)
    const siblings = (herdrState.value.tabs || []).filter(x => x.workspace === workspace)
    return closeConfirm({
      kind: 'tab', label: now.tab.label || String(now.tab.number), panes: now.panes,
      lastTab: siblings.length <= 1, workspaceLabel: ws?.label,
    }, tl)
  })
  if (!plan) return
  const done = prepareClose(plan.group ? { workspace } : { tab: id }, plan.group ? plan.workspaces.map(w => w.id) : [])
  if (!(await spaceApi({ op: 'tab.close', tab_id: id, close_group: plan.group }))) return done(false)
  toast(plan.group ? tl('Group closed', 'Groupe fermé') : t('Tab closed'))
  done(true)
}

export async function closeWorkspace(id: string) {
  if (!herdrState.value.workspaces.some(x => x.id === id)) return
  const plan = await confirmClose('workspace', id, () => {
    const s = herdrState.value
    const w = s.workspaces.find(x => x.id === id)
    const panes = s.panes.filter(p => p.workspace === id)
    const tabs = (s.tabs || []).filter(x => x.workspace === id && panes.some(p => p.tab === x.id))
    return closeConfirm({ kind: 'workspace', label: w?.label || id, panes, tabs: tabs.map(x => x.label || String(x.number)) }, tl)
  })
  if (!plan) return
  const done = prepareClose({ workspace: id }, plan.group ? plan.workspaces.map(w => w.id) : [])
  if (!(await spaceApi({ op: 'workspace.close', workspace_id: id, close_group: plan.group }))) return done(false)
  toast(plan.group ? tl('Group closed', 'Groupe fermé') : t('Space closed'))
  done(true)
}

// Move a pane: menu of destinations (tabs of its machine, new
// tab of its space, new space). The view that showed it follows it.
export function movePane(p: Pane) {
  const targets = moveTargets(herdrState.value, p.id)
  const go = (to: MoveDestination) => () => doMove(p, to)
  const items: MenuItem[] = [
    { label: t('New tab'), icon: 'i-lucide-plus', desc: t('in the same space'), run: go('new_tab') },
    { label: t('New space'), icon: 'i-lucide-square-plus', run: go('new_workspace') },
  ]
  let ws: string | null = null
  for (const x of targets) {
    if (x.workspace !== ws) {
      ws = x.workspace
      items.push({ kind: 'group', label: x.sameWorkspace ? t('This space') : x.workspaceLabel })
    }
    items.push({
      label: `${t('Tab')} ${x.label}`, icon: 'i-lucide-panels-top-left',
      desc: tl(`${x.panes} pane${x.panes > 1 ? 's' : ''}`, `${x.panes} pane${x.panes > 1 ? 's' : ''}`),
      run: go({ tab_id: x.tab_id }),
    })
  }
  openMenu(items, tl(`Move “${paneTitle(p)}”`, `Déplacer « ${paneTitle(p)} »`))
}
async function doMove(p: Pane, to: MoveDestination) {
  const r = await spaceApi({ op: 'pane.move', pane_id: p.id, to })
  if (!r) return
  toast(t('Pane moved'))
  // Moved to another space, the pane changes ID: the view follows it.
  const route = useRouter().currentRoute.value
  if (r.pane_id && r.pane_id !== p.id && route.path === panePath(p.id)) navigateTo(panePath(r.pane_id), { replace: true })
}

// Swap a pane with its neighbour (Ctrl+B then Shift+H/J/K/L in Herdr):
// only the directions where there is one, according to the real layout.
// The pane keeps its ID: the active cell and the view follow it on their own.
export function paneSwapDirections(p: Pane): PaneDirection[] {
  const e = tabOf(p.tab)
  // Rebuilt layout (not Herdr's): no reliable neighbours.
  if (!e || e.layout !== e.tab.layout) return []
  return swapDirections(e.layout, p.id)
}
export async function swapPane(p: Pane, direction: PaneDirection) {
  const e = tabOf(p.tab)
  const other = e ? directionNeighbor(e.layout, p.id, direction) : null
  const tabs = herdrState.value.tabs
  // New layout shown right away; the next state confirms it.
  if (tabs && other) herdrState.value = { ...herdrState.value, tabs: tabs.map(x => (x.id === p.tab && x.layout ? { ...x, layout: swapInLayout(x.layout, p.id, other) } : x)) }
  const r = await spaceApi({ op: 'pane.swap', pane_id: p.id, direction })
  if (!r) {
    if (herdrState.value.tabs !== tabs && tabs) herdrState.value = { ...herdrState.value, tabs }
    return
  }
  // Plan or side by side of its tab: the moved cell becomes the active cell.
  const router = useRouter()
  if (router.currentRoute.value.path === tabPath(p.tab)) router.replace({ query: { pane: p.id } })
}
// Layout of a tab shown right away (drag and drop, dragged
// divider), before Herdr confirms; the old one comes back if the call
// fails and no newer state arrived in the meantime.
async function withLayout(tabId: string, next: TabLayout, body: Record<string, unknown>) {
  const tabs = herdrState.value.tabs
  const mine = tabs?.map(x => (x.id === tabId && x.layout ? { ...x, layout: next } : x))
  if (mine) herdrState.value = { ...herdrState.value, tabs: mine }
  const r = await spaceApi(body)
  if (!r && tabs && herdrState.value.tabs === mine) herdrState.value = { ...herdrState.value, tabs }
  return r
}
// Drag and drop possible: Herdr's real layout, readable tree, not zoomed.
export function tabDraggable(tabId: string): boolean {
  const e = tabOf(tabId)
  return Boolean(e && e.layout === e.tab.layout && !e.layout.zoomed && e.panes.length > 1 && layoutTree(e.layout))
}
// Drop `p` onto `target` (same tab): center = swap, edge = place beside.
export async function dropPane(p: Pane, target: string, side: DropSide) {
  const e = tabOf(p.tab)
  const next = e ? dropPreview(e.layout, p.id, target, side) : null
  if (!e || !next) return
  if (!(await withLayout(p.tab, next, { op: 'pane.drop', pane_id: p.id, target_pane_id: target, side }))) return
  const router = useRouter()
  if (router.currentRoute.value.path === tabPath(p.tab)) router.replace({ query: { pane: p.id } })
}
// Divider released: a single call, with the final ratio.
export async function resizeSplit(tabId: string, path: string, ratio: number) {
  const e = tabOf(tabId)
  if (!e) return
  await withLayout(tabId, resizePreview(e.layout, path, ratio), { op: 'layout.ratio', tab_id: tabId, path, ratio })
}
const SWAP: Record<PaneDirection, { label: string, icon: string, key: string, arrow: string }> = {
  left: { label: 'Swap with the pane on the left', icon: 'i-lucide-arrow-left', key: 'H', arrow: 'arrowleft' },
  right: { label: 'Swap with the pane on the right', icon: 'i-lucide-arrow-right', key: 'L', arrow: 'arrowright' },
  up: { label: 'Swap with the pane above', icon: 'i-lucide-arrow-up', key: 'K', arrow: 'arrowup' },
  down: { label: 'Swap with the pane below', icon: 'i-lucide-arrow-down', key: 'J', arrow: 'arrowdown' },
}
export const paneSwapItems = (p: Pane): MenuItem[] => paneSwapDirections(p).map(d => ({
  label: t(SWAP[d].label), icon: SWAP[d].icon, kbds: ['alt', 'shift', SWAP[d].arrow], run: () => swapPane(p, d),
}))
// Shortcut (computer): Alt+Shift+arrow or Alt+Shift+H/J/K/L, on the pane
// being viewed, never while typing (field, terminal): these keys
// select text there or go to the program.
const SWAP_CODES: Record<string, PaneDirection> = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', KeyH: 'left', KeyL: 'right', KeyK: 'up', KeyJ: 'down',
}
export function swapShortcut(e: KeyboardEvent): boolean {
  const d = SWAP_CODES[e.code]
  if (!d || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || !desk.value) return false
  const el = e.target as HTMLElement | null
  if (el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], .xterm, [role="dialog"], [role="menu"]')) return false
  const p = herdrState.value.panes.find(x => x.id === curPane.value)
  if (!p || !paneSwapDirections(p).includes(d)) return false
  e.preventDefault()
  swapPane(p, d)
  return true
}

// Menu entries.
export const newTabItem = (workspaceId: string): MenuItem => ({ label: t('New tab'), icon: 'i-lucide-plus', run: () => newTab(workspaceId) })
// Copy the pane's Herdr ID (its machine's, without the wherdr prefix).
export function copyPaneIdItem(p: Pane): MenuItem {
  const id = herdrPaneId(p.id)
  return {
    label: t('Copy pane ID'), icon: 'i-lucide-copy', mono: true,
    desc: paneIdLine(p.id, machineName(p.machine)),
    run: async () => {
      try {
        await navigator.clipboard.writeText(id)
        toast(`${t('Copied')} : ${id}`)
      } catch { toast(t('Copy failed'), true) }
    },
  }
}
export function paneSpaceItems(p: Pane): MenuItem[] {
  return [
    { label: t('Split right'), icon: 'i-lucide-columns-2', run: () => splitPane(p, 'right') },
    { label: t('Split down'), icon: 'i-lucide-rows-2', run: () => splitPane(p, 'down') },
    { label: t('Move to…'), icon: 'i-lucide-move', run: () => movePane(p) },
    ...paneSwapItems(p),
  ]
}
export function tabItems(tabId: string): MenuItem[] {
  const e = tabOf(tabId)
  if (!e) return []
  return [
    { label: t('Rename tab'), icon: 'i-lucide-pencil', run: () => renameTab(tabId) },
    newTabItem(e.tab.workspace),
    // One entry per pane of the tab (its Herdr ID is shown under each).
    ...(e.panes.length ? [{ kind: 'separator' as const }, ...e.panes.map(p => copyPaneIdItem(p)), { kind: 'separator' as const }] : []),
    {
      label: t('Close tab'), icon: 'i-lucide-x', danger: true, run: () => closeTab(tabId),
      // Explicit scope: every pane of the tab goes.
      desc: e.panes.length === 1 ? tl('Closes its pane', 'Ferme son panneau') : tl(`Closes its ${e.panes.length} panes`, `Ferme ses ${e.panes.length} panneaux`),
    },
  ]
}
// Close a pane: stops its agent, or closes its terminal.
export function closePaneItem(p: Pane, kbds?: string[]): MenuItem {
  return {
    label: p.agent ? tl(`Close this pane (stops ${kindLabel(p.agent)})`, `Fermer ce pane (arrête ${kindLabel(p.agent)})`) : t('Close this terminal'),
    icon: 'i-lucide-trash-2', danger: true, kbds, run: () => closePane(p),
  }
}
// Phone pane sheet (the header identity): everything that manages the pane
// being viewed, then its tab. The Options menu keeps the agent's own actions.
export function currentPaneItems(p: Pane): MenuItem[] {
  return [
    { label: t('Rename pane'), icon: 'i-lucide-pencil', run: () => { renameTarget.value = p.id } },
    ...paneSpaceItems(p),
    copyPaneIdItem(p),
    // Conversation or its terminal view: the same pane, only this one.
    { ...closePaneItem(p), label: p.agent ? t('Close this conversation') : t('Close this terminal') },
  ]
}
// No "Close tab" here: a tab closes from its overview, where its panes show.
export function currentTabItems(tabId: string, overview?: MenuItem): MenuItem[] {
  const e = tabOf(tabId)
  if (!e) return []
  return [
    { label: t('Rename tab'), icon: 'i-lucide-pencil', run: () => renameTab(tabId) },
    newTabItem(e.tab.workspace),
    ...(overview ? [overview] : []),
  ]
}
// The whole space, apart from the pane actions. Absent when the pane is its
// only one: closing the pane already closes the space (a single close action).
export function currentSpaceItems(p: Pane): MenuItem[] {
  const ws = herdrState.value.workspaces.find(w => w.id === p.workspace)
  const panes = herdrState.value.panes.filter(x => x.workspace === p.workspace)
  if (!ws || panes.length <= 1) return []
  const tabs = new Set(panes.map(x => x.tab)).size
  return [
    { kind: 'group', label: tl(`Space “${ws.label}”`, `Espace « ${ws.label} »`) },
    {
      label: t('Close entire space…'), icon: 'i-lucide-trash-2', danger: true,
      desc: tl(`${tabs === 1 ? '1 tab' : `${tabs} tabs`} · ${panes.length} panes`, `${tabs === 1 ? '1 onglet' : `${tabs} onglets`} · ${panes.length} panneaux`),
      run: () => closeWorkspace(ws.id),
    },
  ]
}
export function workspaceItems(id: string, project = false): MenuItem[] {
  return [
    ...(!project ? [{ label: t('Rename space'), icon: 'i-lucide-pencil', run: () => renameWorkspace(id) }] : []),
    newTabItem(id),
    { label: t('Close space'), icon: 'i-lucide-trash-2', danger: true, run: () => closeWorkspace(id) },
  ]
}
// Space and tab of a pane (agent view, long press on its card): "Space"
// group, new tab first.
export function paneWorkspaceItems(p: Pane, project = false): MenuItem[] {
  const ws = herdrState.value.workspaces.find(w => w.id === p.workspace)
  const entries = paneSpaceEntries(herdrState.value, p.id)
  if (!ws || !entries.length) return []
  const item: Record<SpaceEntry, MenuItem> = {
    'tab.create': newTabItem(ws.id),
    'tab.rename': { label: t('Rename tab'), icon: 'i-lucide-pencil', run: () => renameTab(p.tab) },
    'tab.close': { label: t('Close tab'), icon: 'i-lucide-x', danger: true, run: () => closeTab(p.tab) },
    'workspace.rename': { label: t('Rename space'), icon: 'i-lucide-pencil', run: () => renameWorkspace(ws.id) },
    'workspace.close': { label: t('Close space'), icon: 'i-lucide-trash-2', danger: true, run: () => closeWorkspace(ws.id) },
  }
  return [{ kind: 'group', label: tl(`Space “${ws.label}”`, `Espace « ${ws.label} »`) }, ...entries.filter(e => !project || e !== 'workspace.rename').map(e => item[e])]
}

// Full menu of a plan pane: rename, split, move, close.
export function paneItems(p: Pane): MenuItem[] {
  return [
    notificationMenuItem(p),
    { label: t('Rename pane'), icon: 'i-lucide-pencil', run: () => { renameTarget.value = p.id } },
    ...paneSpaceItems(p),
    { kind: 'separator' },
    closePaneItem(p),
  ]
}
// Menu of a tab's plan: the tab, then its space.
export function tabPlanItems(tabId: string): MenuItem[] {
  const e = tabOf(tabId)
  if (!e) return []
  const ws = herdrState.value.workspaces.find(w => w.id === e.tab.workspace)
  return [
    { kind: 'group', label: t('Tab') },
    ...tabItems(tabId),
    { kind: 'group', label: ws ? tl(`Space “${ws.label}”`, `Espace « ${ws.label} »`) : t('Space') },
    ...workspaceItems(e.tab.workspace).filter(x => x.label !== t('New tab')),
  ]
}

// Reorder spaces (drag and drop in the list): placed before `before`
// (null: at the end), on the space's machine. New order shown right
// away; Herdr's next state confirms it (or undoes it if the call fails).
export async function moveWorkspace(id: string, before: string | null) {
  const prev = herdrState.value.workspaces
  const next = reorderWorkspaces(prev, id, before)
  herdrState.value = { ...herdrState.value, workspaces: next }
  const r = await spaceApi({ op: 'workspace.move', workspace_id: id, before_workspace_id: before })
  // Failure, and no newer state in the meantime: we restore the previous order.
  if (!r && herdrState.value.workspaces === next) herdrState.value = { ...herdrState.value, workspaces: prev }
}
