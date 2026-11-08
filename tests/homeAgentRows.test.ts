import { describe, expect, it } from 'vitest'
import { individualAgentRows, individualAgentTitle } from '../app/utils/homeAgentRows'
import { spaceRows, sortReady } from '../shared/spaces'
import { reduceSnapshot } from './helpers/snapshot'

const state = reduceSnapshot({
  workspaces: [{ workspace_id: 'w1', label: 'Shared space', number: 1 }, { workspace_id: 'w2', label: 'Shells', number: 2 }],
  tabs: [{ tab_id: 't1', workspace_id: 'w1', label: 'Zulu', number: 1 }, { tab_id: 't2', workspace_id: 'w1', label: 'Alpha', number: 2 }, { tab_id: 't3', workspace_id: 'w2', number: 1 }],
  panes: [
    { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 't1', agent: 'codex', agent_status: 'idle' },
    { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 't2', agent: 'claude', agent_status: 'idle' },
    { pane_id: 'w1:p3', workspace_id: 'w1', tab_id: 't2', agent: null },
    { pane_id: 'w2:p1', workspace_id: 'w2', tab_id: 't3', agent: null },
  ],
})

describe('individual standalone-agent rows', () => {
  it('expands agent spaces in tab order without dropping terminal panes', () => {
    const rows = individualAgentRows(spaceRows(state))
    expect(rows.map(r => r.key)).toEqual(['w1:p1', 'w1:p2', 'w1:p3', 'w2:p1'])
    expect(rows.filter(r => r.lead.agent).map(r => individualAgentTitle(r.lead))).toEqual(['Zulu', 'Alpha'])
    expect(new Set(rows.map(r => r.key)).size).toBe(rows.length)
  })

  it('sorts names by the displayed agent label', () => {
    const rows = individualAgentRows(spaceRows(state)).filter(r => r.lead.agent)
    expect(sortReady(rows, 'name', r => individualAgentTitle(r.lead)).map(r => r.key)).toEqual(['w1:p2', 'w1:p1'])
  })

  it('respects machine filtering before expansion', () => {
    const remote = { ...state, workspaces: state.workspaces.map(w => ({ ...w, machine: 'remote' })), tabs: state.tabs?.map(t => ({ ...t, machine: 'remote' })), panes: state.panes.map(p => ({ ...p, machine: 'remote' })) }
    expect(individualAgentRows(spaceRows(remote, ''))).toEqual([])
    expect(individualAgentRows(spaceRows(remote, 'remote'))).toHaveLength(4)
  })
})

describe('coordinator panes', () => {
  const addressed = { ...state, panes: state.panes.map(p => ({ ...p, coreAddress: `core:${p.id}` })) }

  it('leaves coordinator panes out and keeps every other row', () => {
    const rows = individualAgentRows(spaceRows(addressed), new Set(['core:w1:p2']))
    expect(rows.map(r => r.key)).toEqual(['w1:p1', 'w1:p3', 'w2:p1'])
  })

  it('drops a space whose only pane is a coordinator', () => {
    expect(individualAgentRows(spaceRows(addressed), new Set(['core:w2:p1'])).map(r => r.key)).toEqual(['w1:p1', 'w1:p2', 'w1:p3'])
  })
})
