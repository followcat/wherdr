// Actions on spaces, tabs and panes ("…" menus of the list by space, of a
// tab's plan and of the agent view). herdr-core keeps spaces and tabs in
// herdr-app's layout document, which wherdr does not write: a new tab is a new
// terminal in the space, a tab is renamed through its terminal (/api/rename),
// and closing a tab or a space closes each of its terminals (/api/close).
import type { Pane } from '#shared/types'
import type { CloseKind } from '~/utils/closeFlow'
import { leadPane } from '#shared/spaces'
import { sameTabBody } from '#shared/coreTabMap'
import { HERDR_AGENT_KINDS } from '#shared/launchableAgents'
import { herdrPaneId, paneIdLine } from '~/utils/paneId'

// "New tab" in this space: the "New agent" sheet only creates it on "Launch".
export const newTabSpace = ref<string | null>(null)

// New tab: "+" starts a terminal like the space's current one, no sheet; the
// sheet opens when there is nothing to copy.
export function newTab(workspaceId: string) {
  haptic()
  const lead = leadPane(spaceTabs(workspaceId).flatMap(e => e.panes))
  const body = sameTabBody(lead || undefined, [...HERDR_AGENT_KINDS])
  if (body) return void quickTab(body)
  newTabChoose(workspaceId)
}
async function quickTab(body: Record<string, unknown>) {
  try {
    const r = await api<{ pane_id: string }>('/api/agents', body)
    toast(t('Tab created'))
    navigateTo(panePath(r.pane_id))
  }
  catch (err) { toast((err as Error).message, true) }
}
// New tab with a choice of kind and folder (the sheet).
export function newTabChoose(workspaceId: string) {
  haptic()
  newTabSpace.value = workspaceId
  newAgentOpen.value = true
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
// Tab menu: a new tab like this one (when its folder is known) or chosen in
// the sheet; rename (a tab of one terminal whose name is the tab's, not one
// named in herdr-app's document), close.
export function tabItems(tabId: string): MenuItem[] {
  const e = tabOf(tabId)
  if (!e) return []
  const ws = e.tab.workspace
  const like = sameTabBody(leadPane(e.panes) || undefined, [...HERDR_AGENT_KINDS])
  const only = e.panes.length === 1 && !e.tab.docName ? e.panes[0] : undefined
  return [
    ...(like ? [{ label: t('New tab like this one'), icon: 'i-lucide-copy-plus', run: () => { haptic(); quickTab(like) } }] : []),
    { label: t('New tab…'), icon: 'i-lucide-folder-plus', run: () => newTabChoose(ws) },
    { kind: 'separator' },
    ...(only ? [{ label: t('Rename tab'), icon: 'i-lucide-pencil', run: () => { renameAs.value = 'tab'; renameTarget.value = only.id } }] : []),
    { label: t('Close tab'), icon: 'i-lucide-trash-2', danger: true, run: () => closeTerminals('tab', tabId) },
  ]
}
// Close a tab or a space: one confirmation saying how many terminals and agents
// stop, then each terminal closes like "Close this terminal"; those that could
// not are named, the others are closed all the same.
const stopLine = (n: number) => (n === 1 ? t('Its terminal stops.') : tl(`Its ${n} terminals stop.`))
export async function closeTerminals(kind: Exclude<CloseKind, 'pane'>, id: string) {
  const plan = await confirmClose(kind, id, (plan) => {
    const tab = kind === 'tab' ? tabOf(id)?.tab : undefined
    const name = tab ? tab.label || String(tab.number) : herdrState.value.workspaces.find(w => w.id === id)?.label || ''
    return kind === 'tab'
      ? { message: tl(`Close tab “${name}”? ${stopLine(plan.panes.length)}`), action: t('Close tab') }
      : { message: tl(`Close space “${name}”? ${stopLine(plan.panes.length)}`), action: t('Close space') }
  })
  if (!plan) return
  const done = prepareClose(kind === 'tab' ? { tab: id } : { workspace: id })
  const failed: string[] = []
  for (const p of plan.panes) {
    try { await api('/api/close', { pane_id: p.id }) }
    catch (err) { failed.push(tl(`“${paneTitle(p)}” could not be closed: ${(err as Error).message}`)) }
  }
  done(!failed.length)
  if (failed.length) toast(failed.join('\n'), true)
  else toast(kind === 'tab' ? t('Tab closed') : t('Space closed'))
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
    copyPaneIdItem(p),
    // Conversation or its terminal view: the same pane, only this one.
    { ...closePaneItem(p), label: p.agent ? t('Close this conversation') : t('Close this terminal') },
  ]
}
// No "Close tab" here: a tab closes from its overview, where its panes show.
export function currentTabItems(tabId: string, overview?: MenuItem): MenuItem[] {
  const e = tabOf(tabId)
  if (!e) return []
  return [newTabItem(e.tab.workspace), ...(overview ? [overview] : [])]
}
// A project coordinator's or a task agent's space is not closed from here: its
// project manages it.
const managed = (p: Pane) => Boolean(p.task || p.coordinator || coordinatorOf(p) || (p.coreAddress && p.coreAddress === alfred.value?.terminal))
function closeSpaceItems(id: string): MenuItem[] {
  const panes = herdrState.value.panes.filter(p => p.workspace === id)
  if (!panes.length || panes.some(managed)) return []
  return [{ label: t('Close space'), icon: 'i-lucide-trash-2', danger: true, run: () => closeTerminals('workspace', id) }]
}
export function workspaceItems(id: string): MenuItem[] {
  const close = closeSpaceItems(id)
  return [newTabItem(id), ...(close.length ? [{ kind: 'separator' as const }, ...close] : [])]
}
// Space of a pane (agent view, long press on its card): "Space" group, new tab, close.
export function paneWorkspaceItems(p: Pane): MenuItem[] {
  const ws = herdrState.value.workspaces.find(w => w.id === p.workspace)
  if (!ws) return []
  return [{ kind: 'group', label: tl(`Space “${ws.label}”`, `Espace « ${ws.label} »`) }, newTabItem(ws.id), ...closeSpaceItems(ws.id)]
}

// Full menu of a plan pane: rename, close.
export function paneItems(p: Pane): MenuItem[] {
  return [
    notificationMenuItem(p),
    { label: t('Rename pane'), icon: 'i-lucide-pencil', run: () => { renameTarget.value = p.id } },
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
  ]
}
