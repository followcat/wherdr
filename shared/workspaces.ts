// Workspaces for the app: workspaces → tabs → panes (reading
// order), with the layout to show. Pure (tested).
import type { HerdrState, Pane, Tab, Workspace } from './types'
import { type TabLayout, readingOrder, tabLayout } from './layout'
import { type SplitNode, type TabSplits, fitTree, treeLayout } from './splitTree'

// `tree`: wherdr's split tree the layout was drawn from (its dividers can be dragged).
export interface TabEntry { tab: Tab, layout: TabLayout, panes: Pane[], tree?: SplitNode }
export interface WorkspaceEntry { workspace: Workspace, tabs: TabEntry[] }
// `splits`: wherdr's own split trees (setting tabSplits), drawn for tabs without herdr's layout.
type State = Pick<HerdrState, 'workspaces' | 'panes'> & Partial<Pick<HerdrState, 'tabs'>> & { splits?: TabSplits }

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
// (a pane just created or closed between two reads); without one, wherdr's own
// split tree fitted to the panes (gone leaves pruned, new panes at the bottom);
// otherwise, stacked.
function entryOf(tab: Tab, all: Pane[], splits?: TabSplits): TabEntry {
  const mine = all.filter(p => p.tab === tab.id)
  const ids = new Set(mine.map(p => p.id))
  const l = tab.layout
  const exact = l && l.panes.length === ids.size && l.panes.every(p => ids.has(p.pane))
  const saved = !l && splits?.[tab.id]
  const tree = saved && mine.every(p => p.coreAddress) ? fitTree(saved, mine.map(p => p.coreAddress!)) : null
  const paneOf = new Map(mine.map(p => [p.coreAddress, p.id]))
  const layout = tree && typeof tree !== 'string'
    ? treeLayout(tab, tree, leaf => paneOf.get(leaf)!)
    : tabLayout({ ...tab, layout: exact ? l : null }, mine.map(p => p.id))
  const byId = new Map(mine.map(p => [p.id, p]))
  return { tab, layout, panes: readingOrder(layout).map(p => byId.get(p.pane)!), ...(tree && typeof tree !== 'string' ? { tree } : {}) }
}

// `machine`: only this machine ('' = local); missing = all.
export function workspaceTree(s: State, machine?: string): WorkspaceEntry[] {
  const mineM = (x: { machine?: string }) => machine === undefined || (x.machine || '') === machine
  const tabs = tabsOf(s).filter(mineM)
  return s.workspaces.filter(mineM).sort(byNumber).map(workspace => ({
    workspace,
    tabs: tabs.filter(t => t.workspace === workspace.id).sort(byNumber).map(t => entryOf(t, s.panes, s.splits)),
  })).filter(w => w.tabs.some(t => t.panes.length))
}

export function tabEntry(s: State, tabId: string): TabEntry | null {
  const tab = tabsOf(s).find(t => t.id === tabId)
  return tab ? entryOf(tab, s.panes, s.splits) : null
}
