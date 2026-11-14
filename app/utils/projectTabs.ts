// The project sheet's tabs (shared/pm/places.ts), and the one a URL asks for (`?tab=`): General by default.
import { PROJECT_TABS, type ProjectTab } from '../../shared/pm/places'
import { BAR_ALL, type MachineGroup } from './machineBar'

export { PROJECT_TABS, PROJECT_TAB_LABEL, type ProjectTab } from '../../shared/pm/places'
export const projectTab = (q: unknown): ProjectTab => (PROJECT_TABS as readonly unknown[]).includes(q) ? q as ProjectTab : 'general'

// Which home tab (machine bar) shows a project: its coordinator and its tasks
// to handle. A project has tab machines: those of the group it is pinned to,
// every machine (null) when pinned to all tabs, or by default (no pin, or the
// group was deleted) its allowed machines but those paused for it, unless one
// of its tasks still runs there. A tab shows it when they meet.
// project: its allowed machines, paused ones and paused ones still at work
// (CoordinatorView); override: its entry in the projectTabs setting
// (readProjectTabs), undefined = automatic.
export function projectTabMachines(project: { machines: readonly string[], paused?: readonly string[], busy?: readonly string[] }, override: string | undefined, groups: readonly MachineGroup[]): string[] | null {
  if (override === BAR_ALL) return null
  const group = override ? groups.find(g => g.id === override) : undefined
  return group ? [...group.machines] : project.machines.filter(m => !project.paused?.includes(m) || !!project.busy?.includes(m))
}

// selection: the tab's machines (barMachineSelection), null = the All tab.
export const projectOnTab = (tabMachines: readonly string[] | null, selection: readonly string[] | null) =>
  !selection || !tabMachines || tabMachines.some(m => selection.includes(m))

// What a home tab counts, for its counters and its badge alike: the agent rows
// it lists (by their machine's base key) and the coordinators it shows.
// Alfred shows on every tab (tabMachines null); a coordinator waiting for the
// user (a proposal to answer) counts in Your turn.
export type CountGroup = 'blocked' | 'working' | 'ready'
export interface TabCounted { group: CountGroup }
export function tabCounts(rows: readonly (TabCounted & { base: string })[], coordinators: readonly (TabCounted & { tabMachines: readonly string[] | null })[], selection: readonly string[] | null) {
  const counts: Record<CountGroup, number> = { blocked: 0, working: 0, ready: 0 }
  for (const r of rows) if (!selection || selection.includes(r.base)) counts[r.group]++
  for (const c of coordinators) if (projectOnTab(c.tabMachines, selection)) counts[c.group]++
  return counts
}
export const countsTotal = (c: Record<CountGroup, number>) => c.blocked + c.working + c.ready
