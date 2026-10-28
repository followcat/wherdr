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

export function isIndividualAgentRow(row: Row | null | undefined): row is IndividualAgentRow {
  return row?.kind === 'pane' && 'individual' in row && row.individual === true
}

export function individualAgentTitle(pane: Pane): string {
  // Existing Herdr agent names are usually tab labels, not workspace labels.
  return pane.label?.trim() || pane.tabLabel?.trim() || pane.name?.trim() || paneTitle(pane)
}
