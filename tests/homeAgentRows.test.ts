import { describe, expect, it } from 'vitest'
import { individualAgentRows, individualAgentTitle } from '../app/utils/homeAgentRows'
import { spaceRows, sortReady } from '../shared/spaces'
import { boardSections } from '../shared/boardLinks'
import { reduceSnapshot } from '../server/utils/snapshot'

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

  it('leaves Board task rows together by expanding only the standalone section', () => {
    const sections = boardSections(spaceRows(state), state.workspaces, [{ machine: '', coordinators: [], tasks: [{
      id: 'demo/1', repo: 'demo', n: 1, key: 'DEMO-1', title: 'Example task', workspace: 'w1', stage: 'working', progress: null, msg: '', since: null, panes: [{ id: 'w1:p1', role: 'worker' }, { id: 'w1:p2', role: 'reviewer' }],
    }], repos: [] }], new Set(state.panes.map(p => p.id)))
    const task = sections.projects[0]!.members[0]!.row
    expect(task.kind).toBe('space')
    expect(individualAgentRows(sections.others).map(r => r.key)).toEqual(['w2:p1'])
    expect(sections.projects[0]!.members).toHaveLength(1)
  })
})
