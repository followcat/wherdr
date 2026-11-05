import { describe, expect, it } from 'vitest'
import { reduceSnapshot } from './helpers/snapshot'
import { tabEntry, workspaceTree } from '../shared/workspaces'
import type { Pane } from '../shared/types'
import layouts from './fixtures/snapshot-layouts.json'

const pane = (id: string, tab: string, agent: string | null = null, status = 'idle') => ({
  pane_id: id, workspace_id: tab.split(':')[0], tab_id: tab, agent, agent_status: agent ? status : 'unknown',
})
const panes = [pane('w1:p1', 'w1:t1', 'claude', 'blocked'), pane('w1:p2', 'w1:t1', 'codex', 'working'), pane('w1:p3', 'w1:t1'), pane('w1:p4', 'w1:t2'), pane('w2:p1', 'w2:t1'), pane('w2:p2', 'w2:t1'), pane('w3:p1', 'w3:t1')]
const state = reduceSnapshot({ ...layouts, panes })

describe('workspaceTree', () => {
  it('workspaces → tabs → panes in reading order', () => {
    const tree = workspaceTree(state)
    expect(tree.map(w => [w.workspace.label, w.tabs.map(t => t.tab.label)])).toEqual([
      ['herdr-web', ['dev', 'serveur']], ['api', ['1']], ['notes', ['1']],
    ])
    const dev = tree[0]!.tabs[0]!
    expect(dev.panes.map(p => p.id)).toEqual(['w1:p1', 'w1:p2', 'w1:p3'])
    expect(dev.layout.panes).toHaveLength(3)
    expect(dev.layout.area.width).toBe(120)
  })

  it('filtre par machine', () => {
    const remote = reduceSnapshot({ ...layouts, panes }, 'abcd1234')
    const both = { workspaces: [...state.workspaces, ...remote.workspaces], tabs: [...state.tabs!, ...remote.tabs!], panes: [...state.panes, ...remote.panes] }
    expect(workspaceTree(both, 'abcd1234').map(w => w.workspace.id)).toEqual(['abcd1234~w1', 'abcd1234~w2', 'abcd1234~w3'])
    expect(workspaceTree(both, '')).toHaveLength(3)
    expect(workspaceTree(both)).toHaveLength(6)
  })

  it('stale layout (pane not yet among the panes): stacked panes', () => {
    const s = { ...state, panes: state.panes.filter(p => p.id !== 'w1:p3') }
    const dev = tabEntry(s, 'w1:t1')!
    expect(dev.panes.map(p => p.id)).toEqual(['w1:p1', 'w1:p2'])
    expect(dev.layout.panes.map(p => p.rect.y)).toEqual([0, 40])
  })

  it('state without tabs (old offline cache): tabs taken from the panes', () => {
    const { tabs: _tabs, ...old } = state
    const tree = workspaceTree(old)
    expect(tree[0]!.tabs.map(t => [t.tab.id, t.tab.label, t.panes.length])).toEqual([['w1:t1', 'dev', 3], ['w1:t2', 'serveur', 1]])
    expect(tabEntry(old, 'w9:t9')).toBeNull()
  })

})
