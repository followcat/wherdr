import { describe, expect, it } from 'vitest'
import { fitTree, insertSplit, readTabSplits, removeLeaf, setRatio, treeDividers, treeLayout, writeTabSplits } from '../shared/splitTree'
import { paneBoxes } from '../shared/layout'
import { tabEntry } from '../shared/workspaces'
import type { Pane } from '../shared/types'

const tab = { id: 'w:b1', workspace: 'w' }
const boxes = (t: Parameters<typeof treeLayout>[1]) => paneBoxes(treeLayout(tab, t, l => l))

describe('split tree', () => {
  it('split right then split down in the right cell gives the right geometry', () => {
    const t = insertSplit(insertSplit(null, 't1', 't2', 'right'), 't2', 't3', 'down')
    expect(boxes(t)).toEqual([
      { pane: 't1', left: 0, top: 0, width: 50, height: 100 },
      { pane: 't2', left: 50, top: 0, width: 50, height: 50 },
      { pane: 't3', left: 50, top: 50, width: 50, height: 50 },
    ])
    expect(treeLayout(tab, t, l => l).splits!.map(s => [s.path, s.direction])).toEqual([['', 'right'], ['1', 'down']])
  })

  it('sets a nested ratio, bounded to 0.15–0.85, and places its divider', () => {
    const t = { dir: 'right' as const, ratio: 0.5, a: 'x', b: { dir: 'down' as const, ratio: 0.5, a: 'y', b: 'z' } }
    expect(setRatio(t, '1', 0.99)).toEqual({ ...t, b: { ...t.b, ratio: 0.85 } })
    expect(setRatio(t, '', 0.01).ratio).toBe(0.15)
    const d = treeDividers(treeLayout(tab, setRatio(t, '', 0.3), l => l))
    expect(d.map(x => [x.path, x.at, x.from, x.span])).toEqual([['', 30, 0, 100], ['1', 50, 30, 70]])
  })
  it('removing a leaf gives its room to its sibling', () => {
    const t = insertSplit(insertSplit(null, 't1', 't2', 'right'), 't2', 't3', 'down')
    expect(removeLeaf(t, 't2')).toEqual({ dir: 'right', ratio: 0.5, a: 't1', b: 't3' })
    expect(removeLeaf('t1', 't1')).toBeNull()
  })

  it('fits the panes: gone leaves pruned, new ones stacked at the bottom', () => {
    const t = fitTree(insertSplit(null, 't1', 't2', 'right'), ['t1', 't3', 't4'])!
    expect(boxes(t).map(b => [b.pane, b.top, b.height])).toEqual([['t1', 0, 33.33], ['t3', 33.33, 33.33], ['t4', 66.67, 33.33]])
  })

  it('reads and writes the setting, dropping gone tabs and malformed trees', () => {
    const splits = { 'w:b1': insertSplit(null, 't1', 't2', 'down'), 'w:b2': insertSplit(null, 't5', 't6', 'right') }
    const text = writeTabSplits(splits, t => t === 'w:b1')
    expect(readTabSplits(text)).toEqual({ 'w:b1': splits['w:b1'] })
    expect(readTabSplits('{"x":{"dir":"up","ratio":2,"a":"t1","b":"t2"},"y":"t1"}')).toEqual({})
  })
})

describe('tab entry with a split tree', () => {
  const pane = (n: number): Pane => ({ id: `w:p${n}`, coreAddress: `t${n}`, workspace: 'w', tab: 'w:b1' } as Pane)
  const state = (panes: Pane[]) => ({ workspaces: [], tabs: [{ ...tab, label: '', number: 1, layout: null }], panes, splits: { 'w:b1': insertSplit(insertSplit(null, 't1', 't2', 'right'), 't2', 't3', 'down') } })

  it('draws the tree with pane ids', () => {
    expect(tabEntry(state([pane(1), pane(2), pane(3)]), 'w:b1')!.panes.map(p => p.id)).toEqual(['w:p1', 'w:p2', 'w:p3'])
  })

  it('prunes a closed terminal: its sibling takes the room', () => {
    const e = tabEntry(state([pane(1), pane(3)]), 'w:b1')!
    expect(paneBoxes(e.layout).map(b => [b.pane, b.left, b.width, b.height])).toEqual([['w:p1', 0, 50, 100], ['w:p3', 50, 50, 100]])
  })
})
