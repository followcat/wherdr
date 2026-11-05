// List by state, one row per Herdr space (workspace): a space with a single
// tab and a single pane stays its agent's card; otherwise a space
// card, sorted by its most urgent pane. Tab remembered per space.
// Pure (tested).
import type { HerdrState, Pane, Workspace } from './types'
import { type TabEntry, tabEntry, workspaceTree } from './workspaces'

type State = Pick<HerdrState, 'workspaces' | 'panes'> & Partial<Pick<HerdrState, 'tabs'>>

// Urgency of a pane (smaller = more urgent): your turn, working,
// finished unread, ready, unknown; a terminal without an agent comes after.
// Core status is authoritative even when no agent identity is known.
const RANK: Record<string, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 }
export const urgency = (p: Pick<Pane, 'agent' | 'status' | 'coreAddress'>) => ((p.coreAddress || p.agent) ? RANK[p.status || 'unknown'] ?? 4 : 9)

// Pane representing the space: the most urgent, the first in reading
// order on a tie (tabs in order, then panes of each tab).
export function leadPane<P extends Pick<Pane, 'agent' | 'status' | 'coreAddress'>>(panes: P[]): P | null {
  let best: P | null = null
  for (const p of panes) if (!best || urgency(p) < urgency(best)) best = p
  return best
}

export interface PaneRow { kind: 'pane', key: string, pane: Pane, lead: Pane }
export interface SpaceRow {
  kind: 'space'
  key: string
  workspace: Workspace
  tabs: TabEntry[]
  panes: Pane[]
  lead: Pane
  // Tab of the representative pane (its mini-map).
  leadTab: TabEntry
  sum: { blocked: number, working: number, done: number, agents: number }
}
export type Row = PaneRow | SpaceRow

// One row per open space (`machine`: only that one, '' = local).
export function spaceRows(s: State, machine?: string): Row[] {
  return workspaceTree(s, machine).map((w) => {
    const tabs = w.tabs.filter(e => e.panes.length)
    const panes = tabs.flatMap(e => e.panes)
    const lead = leadPane(panes)!
    if (tabs.length === 1 && panes.length === 1) return { kind: 'pane', key: lead.id, pane: lead, lead }
    const n = (st: string) => panes.filter(p => (p.coreAddress || p.agent) && p.status === st).length
    return {
      kind: 'space',
      key: w.workspace.id,
      workspace: w.workspace,
      tabs,
      panes,
      lead,
      leadTab: tabs.find(e => e.panes.includes(lead))!,
      sum: { blocked: n('blocked'), working: n('working'), done: n('done'), agents: panes.filter(p => p.agent).length },
    }
  })
}

// Rows rebuilt on each push: a row equal to the one of the same key handed
// earlier is handed again, so a card whose row did not change does not
// re-render. Panes are compared by identity (kept across pushes when
// unchanged), the workspace and tabs by content.
export function createRowReuse() {
  const seen = new Map<string, { sig: string, row: Row }>()
  const sigOf = (r: Row) => r.kind === 'pane'
    ? ('individual' in r ? 'pi' : 'p')
    : JSON.stringify([r.workspace, r.tabs.map(e => [e.tab, e.layout]), r.sum])
  const same = (a: Row, b: Row) => {
    if (a.kind !== b.kind || a.lead !== b.lead) return false
    if (a.kind === 'pane' || b.kind === 'pane') return a.kind === 'pane' && b.kind === 'pane' && a.pane === b.pane
    return a.panes.length === b.panes.length && a.panes.every((p, i) => p === b.panes[i])
      && a.tabs.length === b.tabs.length && a.tabs.every((e, i) => e.panes.length === b.tabs[i]!.panes.length && e.panes.every((p, j) => p === b.tabs[i]!.panes[j]))
  }
  return (rows: Row[]): Row[] => rows.map((r) => {
    const prev = seen.get(r.key)
    const sig = sigOf(r)
    if (prev && prev.sig === sig && same(prev.row, r)) return prev.row
    if (seen.size > 500) seen.clear()
    seen.set(r.key, { sig, row: r })
    return r
  })
}

// Group in the list: that of its representative pane. A shell space
// (no agent) is sorted as an idle space, in Ready, as in Herdr's
// first list.
export type RowGroup = 'blocked' | 'working' | 'ready' | 'unknown'
export function paneGroup(p: Pick<Pane, 'agent' | 'status' | 'coreAddress'>): RowGroup {
  if (p.coreAddress && (!p.status || p.status === 'unknown')) return 'unknown'
  if ((p.coreAddress || p.agent) && p.status === 'blocked') return 'blocked'
  if ((p.coreAddress || p.agent) && p.status === 'working') return 'working'
  return 'ready'
}
export const rowGroup = (r: Row): RowGroup => paneGroup(r.lead)

// The Ready group can be split into independent repository lists. Herdr's
// order is kept in each list; a space is unread if a pane has finished.
export function readyLists(rows: Row[], automatic: boolean): Row[][] {
  if (!automatic) return [rows]
  const unread = rows.filter(r => (r.kind === 'space' ? r.panes : [r.pane]).some(p => p.agent && p.status === 'done'))
  const read = rows.filter(r => !unread.includes(r))
  return [unread, read].filter(list => list.length)
}

// Sorting of Ready, within each subgroup: Herdr's order (manually
// reorderable), most recent activity first (last state change of one of
// its panes), or name. `title`: the row's displayed title.
export const READY_SORTS = ['herdr', 'recent', 'name'] as const
export type ReadySort = typeof READY_SORTS[number]
export function sortReady(rows: Row[], sort: ReadySort, title: (r: Row) => string): Row[] {
  if (sort === 'herdr') return rows
  const seq = (r: Row) => Math.max(-1, ...(r.kind === 'space' ? r.panes : [r.pane]).map(p => p.stateSeq ?? -1))
  const key = new Map(rows.map(r => [r, sort === 'recent' ? seq(r) : title(r)]))
  // Stable sort: on a tie (shells without an agent…), Herdr's order stays.
  return [...rows].sort((a, b) => sort === 'recent'
    ? (key.get(b) as number) - (key.get(a) as number)
    : (key.get(a) as string).localeCompare(key.get(b) as string, undefined, { sensitivity: 'base', numeric: true }))
}

// ------------------------------------------------------------ remembered tab
// Last opened tab of each space (workspace -> tab).
export type TabMemory = Record<string, string>

// Tab to open for a space: the last opened one if it still exists, otherwise
// `preferred` (the card's representative tab), otherwise that of the most
// urgent pane, otherwise the first.
export function spaceTab(tabs: Pick<TabEntry, 'tab' | 'panes'>[], memory: TabMemory, workspace: string, preferred?: string): string | null {
  const live = tabs.filter(e => e.panes.length)
  const kept = memory[workspace]
  if (kept && live.some(e => e.tab.id === kept)) return kept
  if (preferred && live.some(e => e.tab.id === preferred)) return preferred
  const lead = leadPane(live.flatMap(e => e.panes))
  return (lead && live.find(e => e.panes.includes(lead))?.tab.id) || live[0]?.tab.id || null
}

// ------------------------------------------------------------ after a close
// Like Herdr: closing a tab shows its neighbour (the previous one, the next one
// if it was the first); closing a pane stays in its tab if any
// remain; the list only when the space has nothing left. Decided before
// the call, from the known state: no bounce to the list nor ghost
// tab while waiting for Herdr's next state.
export type Closing = { tab: string } | { pane: string } | { workspace: string }
// Open view: a tab (plan, side by side) or a pane.
export type Viewed = { tab: string } | { pane: string }
// Where to go: a tab, a pane (tab with a single pane), the list; null = stay.
export type Landing = { tab: string } | { pane: string } | 'home' | null

// Live tabs (with panes) of a space, in Herdr's order.
function liveTabs(s: State, workspace: string): TabEntry[] {
  const ws = s.workspaces.find(w => w.id === workspace)
  if (!ws) return []
  return workspaceTree(s, ws.machine || '').find(w => w.workspace.id === workspace)?.tabs.filter(e => e.panes.length) || []
}

// Neighbouring tab of `tab` in its space (previous, otherwise next), null if it is alone.
export function neighborTab(s: State, tab: string): string | null {
  const ws = s.panes.find(p => p.tab === tab)?.workspace ?? s.tabs?.find(t => t.id === tab)?.workspace
  if (!ws) return null
  const tabs = liveTabs(s, ws)
  const i = tabs.findIndex(e => e.tab.id === tab)
  if (i < 0) return null
  return (tabs[i - 1] ?? tabs[i + 1])?.tab.id ?? null
}

// View of a tab: the pane if it is alone, otherwise the tab (plan, side by side).
const landOn = (tab: string, panes: Pick<Pane, 'id'>[]): Landing => (panes.length === 1 ? { pane: panes[0]!.id } : { tab })

export function afterClose(s: State, closing: Closing, viewed: Viewed | null): Landing {
  if (!viewed) return null
  const vPane = 'pane' in viewed ? s.panes.find(p => p.id === viewed.pane) : undefined
  const vTab = 'tab' in viewed ? viewed.tab : vPane?.tab
  const vWs = vPane?.workspace ?? s.panes.find(p => p.tab === vTab)?.workspace
  if ('workspace' in closing) return vWs === closing.workspace ? 'home' : null
  const toNeighbor = (tab: string): Landing => {
    const n = neighborTab(s, tab)
    return n ? landOn(n, s.panes.filter(p => p.tab === n)) : 'home'
  }
  if ('tab' in closing) return vTab === closing.tab ? toNeighbor(closing.tab) : null
  const p = s.panes.find(x => x.id === closing.pane)
  if (!p || vTab !== p.tab) return null
  // Another pane of the tab is open: it stays.
  if (vPane && vPane.id !== p.id) return null
  const rest = (tabEntry(s, p.tab)?.panes || []).filter(x => x.id !== p.id)
  if (!rest.length) return toNeighbor(p.tab)
  // Plan or side by side of several panes: we stay there.
  if ('tab' in viewed && rest.length > 1) return null
  return landOn(p.tab, rest)
}

// Memory updated, limited to spaces still open (`open`) if they are known.
export function rememberTab(memory: TabMemory, workspace: string, tab: string, open?: string[]): TabMemory {
  const next: TabMemory = { ...memory, [workspace]: tab }
  if (!open) return next
  const keep = new Set(open)
  return Object.fromEntries(Object.entries(next).filter(([w]) => keep.has(w)))
}

// State key of each tab of a space, in order (its most urgent pane;
// 'shell' for a tab without an agent).
export function tabStates(row: Row): string[] {
  if (row.kind !== 'space') return []
  return row.tabs.map((e) => {
    const p = leadPane(e.panes)
    return (p?.coreAddress || p?.agent) ? p.status || 'unknown' : 'shell'
  })
}
