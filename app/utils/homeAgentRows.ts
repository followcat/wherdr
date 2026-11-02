import type { HerdrState, Pane } from '../../shared/types'
import { spaceRows, type PaneRow, type Row } from '../../shared/spaces'
import { paneTitle } from '../../shared/paneTitle'

type ListState = Pick<HerdrState, 'workspaces' | 'panes'> & Partial<Pick<HerdrState, 'tabs'>>
export type IndividualAgentRow = PaneRow & { individual: true }

// The count is agents, so the agent view must render each agent exactly once.
// Follow Herdr's workspace / tab / pane order, including namespaced machines.
export function individualAgentRows(state: ListState, machine?: string): IndividualAgentRow[] {
  return spaceRows(state).flatMap(row => row.kind === 'space' ? row.panes : [row.pane])
    .filter(p => p.agent && (machine === undefined || (p.machine || '') === machine))
    .map(p => ({ kind: 'pane', key: p.id, pane: p, lead: p, individual: true }))
}

// Flat mode (Home screen › Group by › Agents): one list across all machines,
// no space or machine sections, still in Herdr's workspace / tab / pane order.
// The machine bar keeps filtering, on the same base keys as the counters.
export function flatAgentRows(state: ListState, selectedBaseKeys: readonly string[] | null, baseKeyOf: (pane: Pane) => string): IndividualAgentRow[] {
  const rows = individualAgentRows(state)
  return selectedBaseKeys === null ? rows : rows.filter(r => selectedBaseKeys.includes(baseKeyOf(r.pane)))
}

export function isIndividualAgentRow(row: Row | null | undefined): row is IndividualAgentRow {
  return row?.kind === 'pane' && 'individual' in row && row.individual === true
}

export function individualAgentTitle(pane: Pane): string {
  // Existing Herdr agent names are usually tab labels, not workspace labels.
  return pane.label?.trim() || pane.tabLabel?.trim() || pane.name?.trim() || paneTitle(pane)
}
