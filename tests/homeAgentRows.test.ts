import { describe, expect, it } from 'vitest'
import { individualAgentRows, individualAgentTitle } from '../app/utils/homeAgentRows'
import type { Pane } from '../shared/types'

describe('individual agent list', () => {
  const pane = (id: string, machine: string, tab: string, label: string, agent: string | null = 'codex') =>
    ({ id, machine, workspace: machine ? `${machine}~w1` : 'w1', tab, tabLabel: label, agent, status: 'idle' }) as Pane
  const panes = [pane('w1:p1', '', 't1', 'core-X'), pane('w1:p2', '', 't2', 'core-alpha-X'), pane('t14~w1:p1', 't14', 't14t1', 'cheshire-X'), pane('w2:p1', '', 't3', 'shell', null)]
  const state = {
    panes,
    workspaces: [{ id: 'w1', machine: '', label: 'core' }, { id: 't14~w1', machine: 't14', label: 'core' }],
    tabs: [{ id: 't1', workspace: 'w1', number: 1 }, { id: 't2', workspace: 'w1', number: 2 }, { id: 't14t1', workspace: 't14~w1', number: 1 }],
  } as unknown as Parameters<typeof individualAgentRows>[0]

  it('shows every agent in a multi-tab space separately and excludes shells', () => {
    const rows = individualAgentRows(state)
    expect(rows.map(r => r.pane.id)).toEqual(['w1:p1', 'w1:p2', 't14~w1:p1'])
    expect(new Set(rows.map(r => r.key)).size).toBe(3)
  })
  it('uses the same machine scope as the machine count, with original names', () => {
    expect(individualAgentRows(state, '').map(r => individualAgentTitle(r.pane))).toEqual(['core-X', 'core-alpha-X'])
    expect(individualAgentRows(state, 't14').map(r => individualAgentTitle(r.pane))).toEqual(['cheshire-X'])
  })
})
