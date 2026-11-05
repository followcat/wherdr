// Workspaces for the app: workspaces → tabs → panes (reading
// order), with the layout to show. Pure (tested).
import type { HerdrState, Pane, Tab, Workspace } from './types'
import { type TabLayout, readingOrder, tabLayout } from './layout'

export interface TabEntry { tab: Tab, layout: TabLayout, panes: Pane[] }
export interface WorkspaceEntry { workspace: Workspace, tabs: TabEntry[] }
type State = Pick<HerdrState, 'workspaces' | 'panes'> & Partial<Pick<HerdrState, 'tabs'>>

const byNumber = (a: { number: number }, b: { number: number }) => a.number - b.number

// Known tabs: those of the state, otherwise (old offline state) those of the panes.
function tabsOf(s: State): Tab[] {
  if (s.tabs) return s.tabs
  const out = new Map<string, Tab>()
  for (const p of s.panes) {
    if (!out.has(p.tab)) out.set(p.tab, { id: p.tab, ...(p.machine ? { machine: p.machine } : {}), workspace: p.workspace, label: p.tabLabel || '', number: out.size + 1, layout: null })
  }
  return [...out.values()]
}

// Herdr's layout only if it shows exactly the known panes
// (a pane just created or closed between two reads); otherwise, stacked.
function entryOf(tab: Tab, all: Pane[]): TabEntry {
  const mine = all.filter(p => p.tab === tab.id)
  const ids = new Set(mine.map(p => p.id))
  const l = tab.layout
  const exact = l && l.panes.length === ids.size && l.panes.every(p => ids.has(p.pane))
  const layout = tabLayout({ ...tab, layout: exact ? l : null }, mine.map(p => p.id))
  const byId = new Map(mine.map(p => [p.id, p]))
  return { tab, layout, panes: readingOrder(layout).map(p => byId.get(p.pane)!) }
}

// `machine`: only this machine ('' = local); missing = all.
export function workspaceTree(s: State, machine?: string): WorkspaceEntry[] {
  const mineM = (x: { machine?: string }) => machine === undefined || (x.machine || '') === machine
  const tabs = tabsOf(s).filter(mineM)
  return s.workspaces.filter(mineM).sort(byNumber).map(workspace => ({
    workspace,
    tabs: tabs.filter(t => t.workspace === workspace.id).sort(byNumber).map(t => entryOf(t, s.panes)),
  })).filter(w => w.tabs.some(t => t.panes.length))
}

export function tabEntry(s: State, tabId: string): TabEntry | null {
  const tab = tabsOf(s).find(t => t.id === tabId)
  return tab ? entryOf(tab, s.panes) : null
}
