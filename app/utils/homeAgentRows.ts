import type { Pane } from '../../shared/types'
import type { PaneRow, Row } from '../../shared/spaces'
import { paneTitle } from '../../shared/paneTitle'

export type IndividualAgentRow = PaneRow & { individual: true }

// One row per agent pane; a space without agents (shells only) stays one row.
// Panes whose herdr-core address is in `hidden` (the coordinators, shown in
// their own rows) are left out.
export function individualAgentRows(rows: Row[], hidden?: ReadonlySet<string>): Row[] {
  return rows.flatMap(row => {
    const all = row.kind === 'space' ? row.panes : [row.pane]
    const panes = hidden?.size ? all.filter(p => !p.coreAddress || !hidden.has(p.coreAddress)) : all
    if (!panes.length) return []
    if (panes.length === all.length && !panes.some(p => p.agent)) return [row]
    return panes.map(p => ({ kind: 'pane', key: p.id, pane: p, lead: p, individual: true } satisfies IndividualAgentRow))
  })
}

export function isIndividualAgentRow(row: Row | null | undefined): row is IndividualAgentRow {
  return row?.kind === 'pane' && 'individual' in row && row.individual === true
}

export function individualAgentTitle(pane: Pane): string {
  return pane.label?.trim() || pane.tabLabel?.trim() || pane.name?.trim() || paneTitle(pane)
}
