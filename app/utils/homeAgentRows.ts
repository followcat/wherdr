import type { Pane } from '../../shared/types'
import type { PaneRow, Row } from '../../shared/spaces'
import { paneTitle } from '../../shared/paneTitle'

export type IndividualAgentRow = PaneRow & { individual: true }

// Apply after Board grouping: task helpers and checkout rows keep their
// existing meaning. Shell siblings are retained for Show terminals.
export function individualAgentRows(rows: Row[]): Row[] {
  return rows.flatMap(row => {
    const panes = row.kind === 'space' ? row.panes : [row.pane]
    if (!panes.some(p => p.agent)) return [row]
    return panes.map(p => ({ kind: 'pane', key: p.id, pane: p, lead: p, individual: true } satisfies IndividualAgentRow))
  })
}

export function isIndividualAgentRow(row: Row | null | undefined): row is IndividualAgentRow {
  return row?.kind === 'pane' && 'individual' in row && row.individual === true
}

export function individualAgentTitle(pane: Pane): string {
  return pane.label?.trim() || pane.tabLabel?.trim() || pane.name?.trim() || paneTitle(pane)
}
