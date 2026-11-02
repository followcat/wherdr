import type { BoardSections, CoordinatorLevel, Member } from '#shared/boardLinks'
import type { Row } from '#shared/spaces'

export type HomeGrouping = 'machine' | 'state' | 'flat'

export function readHomeGrouping(value: unknown): HomeGrouping {
  return value === 'state' || value === 'flat' ? value : 'machine'
}

export interface StateEntry {
  row: Row
  repo?: string
  level?: CoordinatorLevel
  member?: Member
}

// Flatten each machine separately: repositories with the same name on two
// machines must retain their own coordinator, task metadata and board links.
export function stateEntries(sections: BoardSections, showShells: boolean): StateEntry[] {
  const entries: StateEntry[] = sections.coordinators.map(c => ({ row: c.row, level: c.level }))
  for (const p of sections.projects) {
    if (p.coordinator) entries.push({ row: p.coordinator, repo: p.repo, level: 'project' })
    if (p.space && (p.space.lead.agent || showShells)) entries.push({ row: p.space, repo: p.repo })
    for (const member of p.members) {
      if (member.row.lead.agent || showShells) entries.push({ row: member.row, repo: p.repo, member })
    }
  }
  entries.push(...sections.others.filter(r => r.lead.agent || showShells).map(row => ({ row })))
  return entries
}

interface MachineLike { key: string, baseKey?: string, status: 'online' | 'connecting' | 'offline' }

// Machines of State mode, filtered by the machine bar (its keys are base keys,
// so a named session follows its machine) and in the bar's selected order.
// Online machines feed the merged groups and the machine row at the top;
// offline or reconnecting ones only get the compact line at the bottom.
export function stateMachines<M extends MachineLike>(list: readonly M[], selected: readonly string[] | null) {
  const base = (m: M) => m.baseKey ?? m.key
  const shown = list.filter(m => selected === null || selected.includes(base(m)))
  if (selected) shown.sort((a, b) => selected.indexOf(base(a)) - selected.indexOf(base(b)))
  return { online: shown.filter(m => m.status === 'online'), away: shown.filter(m => m.status !== 'online') }
}
