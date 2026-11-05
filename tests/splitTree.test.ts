import { describe, expect, it } from 'vitest'
import { reduceLayout, splitPath } from '../shared/layout'
import snap from './fixtures/snapshot-layouts.json'

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })
// Layout captured in a test session (Herdr 0.9.1): p1 on the left
// (65 %), p2 top right, p3 | p4 bottom right (30 %).
const raw = {
  tab_id: 'w1:t1', workspace_id: 'w1', zoomed: false, focused_pane_id: 'w1:p1', area: rect(0, 0, 120, 40),
  panes: [
    { pane_id: 'w1:p1', rect: rect(0, 0, 78, 40) }, { pane_id: 'w1:p2', rect: rect(78, 0, 42, 20) },
    { pane_id: 'w1:p3', rect: rect(78, 20, 13, 20) }, { pane_id: 'w1:p4', rect: rect(91, 20, 29, 20) },
  ],
  splits: [
    { id: 'split_0_root', direction: 'right', ratio: 0.65, rect: rect(0, 0, 120, 40) },
    { id: 'split_1_1', direction: 'down', ratio: 0.5, rect: rect(78, 0, 42, 40) },
    { id: 'split_2_11', direction: 'right', ratio: 0.3, rect: rect(78, 20, 42, 20) },
  ],
}
const L = reduceLayout(raw)!

describe('arbre des splits', () => {
  it('path taken from the Herdr id', () => {
    expect(splitPath('split_0_root')).toBe('')
    expect(splitPath('split_1_0')).toBe('0')
    expect(splitPath('split_2_11')).toBe('11')
    // The number is the split's rank (tree walk), not its depth.
    expect(splitPath('split_2_1')).toBe('1')
    expect(splitPath('split_2_')).toBeNull()
    expect(splitPath('nope')).toBeNull()
  })

  it('reads the splits of the snapshot (and of the fixture)', () => {
    expect(L.splits!.map(s => [s.path, s.direction, s.ratio])).toEqual([['', 'right', 0.65], ['1', 'down', 0.5], ['11', 'right', 0.3]])
    expect(reduceLayout(snap.layouts[0])!.splits).toHaveLength(2)
    expect(reduceLayout({ ...raw, splits: undefined })!.splits).toBeUndefined()
  })
})
