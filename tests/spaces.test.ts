import { describe, expect, it } from 'vitest'
import { reduceSnapshot } from './helpers/snapshot'
import { leadPane, rememberTab, rowGroup, spaceRows, spaceTab, tabStates } from '../shared/spaces'
import type { Pane } from '../shared/types'
import layouts from './fixtures/snapshot-layouts.json'

// Fixture: w1 = "herdr-web", tabs dev (3 panes) + server (1 pane);
// w2 = "api", 1 tab with 2 panes; w3 = "notes", 1 tab with one pane.
const pane = (id: string, tab: string, agent: string | null = null, status = 'idle') => ({
  pane_id: id, workspace_id: tab.split(':')[0], tab_id: tab, agent, agent_status: agent ? status : 'unknown',
})
const snap = (list: ReturnType<typeof pane>[]) => reduceSnapshot({ ...layouts, panes: list })
const base = [
  pane('w1:p1', 'w1:t1', 'claude', 'working'), pane('w1:p2', 'w1:t1', 'codex', 'done'), pane('w1:p3', 'w1:t1'),
  pane('w1:p4', 'w1:t2', 'claude', 'blocked'),
  pane('w2:p1', 'w2:t1'), pane('w2:p2', 'w2:t1'),
  pane('w3:p1', 'w3:t1', 'claude', 'idle'),
]

describe('state of a space = its most urgent pane', () => {
  it('your turn > working > unread > ready > terminal', () => {
    const st = (agent: string | null, status: Pane['status']) => ({ agent, status })
    expect(leadPane([st('claude', 'idle'), st('codex', 'working'), st('claude', 'blocked')])).toEqual(st('claude', 'blocked'))
    expect(leadPane([st(null, null), st('claude', 'done'), st('codex', 'idle')])).toEqual(st('claude', 'done'))
    expect(leadPane([st(null, null), st('claude', 'unknown')])).toEqual(st('claude', 'unknown'))
    expect(leadPane([])).toBeNull()
  })

  it('one row per space; 1 tab + 1 pane = the agent card', () => {
    const rows = spaceRows(snap(base))
    expect(rows.map(r => [r.kind, r.key])).toEqual([['space', 'w1'], ['space', 'w2'], ['pane', 'w3:p1']])
    const w1 = rows[0]!
    if (w1.kind !== 'space') throw new Error('space attendu')
    // The "your turn" pane of the server tab wins over the dev tab.
    expect(w1.lead.id).toBe('w1:p4')
    expect(w1.leadTab.tab.id).toBe('w1:t2')
    expect(w1.tabs).toHaveLength(2)
    expect(w1.panes).toHaveLength(4)
    expect(w1.sum).toEqual({ blocked: 1, working: 1, done: 1, agents: 3 })
    // The shell space (w2) is sorted as an idle space.
    expect(rows.map(rowGroup)).toEqual(['blocked', 'ready', 'ready'])
  })

  it('on a tie, the first in reading order', () => {
    const rows = spaceRows(snap([pane('w1:p1', 'w1:t1', 'claude', 'working'), pane('w1:p2', 'w1:t1', 'codex', 'working'), pane('w1:p4', 'w1:t2', 'claude', 'working')]))
    expect(rows[0]!.lead.id).toBe('w1:p1')
    expect(rowGroup(rows[0]!)).toBe('working')
  })

  it('filtre par machine', () => {
    const remote = reduceSnapshot({ ...layouts, panes: base }, 'abcd1234')
    const local = snap(base)
    const both = { workspaces: [...local.workspaces, ...remote.workspaces], tabs: [...local.tabs!, ...remote.tabs!], panes: [...local.panes, ...remote.panes] }
    expect(spaceRows(both, 'abcd1234').map(r => r.key)).toEqual(['abcd1234~w1', 'abcd1234~w2', 'abcd1234~w3:p1'])
    expect(spaceRows(both, '')).toHaveLength(3)
  })
})

describe('tab remembered per space', () => {
  const rows = spaceRows(snap(base))
  const w1 = rows[0]!
  if (w1.kind !== 'space') throw new Error('space attendu')

  it('reopens the last tab, otherwise that of the most urgent pane', () => {
    expect(spaceTab(w1.tabs, {}, 'w1')).toBe('w1:t2')
    expect(spaceTab(w1.tabs, { w1: 'w1:t1' }, 'w1')).toBe('w1:t1')
    // Tab closed since: back to the most urgent.
    expect(spaceTab(w1.tabs, { w1: 'w1:t9' }, 'w1')).toBe('w1:t2')
    expect(spaceTab([], {}, 'w1')).toBeNull()
  })

  it('remembers and forgets closed spaces', () => {
    expect(rememberTab({ w1: 'w1:t1' }, 'w2', 'w2:t1')).toEqual({ w1: 'w1:t1', w2: 'w2:t1' })
    expect(rememberTab({ w1: 'w1:t1', w9: 'w9:t1' }, 'w1', 'w1:t2', ['w1', 'w2'])).toEqual({ w1: 'w1:t2' })
  })
})

describe('tab states of a space', () => {
  it('one state per tab, its most urgent pane; a tab without an agent is a shell', () => {
    const rows = spaceRows(snap([...base.slice(0, 3), pane('w1:p4', 'w1:t2'), ...base.slice(4)]))
    const w1 = rows.find(r => r.kind === 'space' && r.workspace.id === 'w1')!
    expect(tabStates(w1)).toEqual(['working', 'shell'])
    expect(tabStates(rows.find(r => r.kind === 'pane')!)).toEqual([])
  })
})
