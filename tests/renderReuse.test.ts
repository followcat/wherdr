import { describe, expect, it } from 'vitest'
import { coreState } from '../shared/coreState'
import type { CoreTerminal } from '../shared/coreInventory'
import { createRowReuse, spaceRows } from '../shared/spaces'
import { keepIfSame, keyedMemo, weakMemo } from '../app/utils/keepIfSame'
import { onceEvery } from '../app/utils/onceEvery'

const terminal = (address: string, extra = {}): CoreTerminal => ({ address, cwd: '/workspace/demo', state: 'live', ...extra })

describe('values kept across live pushes', () => {
  it('keeps the previous value when the new one is equal, and hands the new one otherwise', () => {
    const a = { typing: true, text: 'Working…' }
    expect(keepIfSame(undefined, a)).toBe(a)
    expect(keepIfSame(a, { typing: true, text: 'Working…' })).toBe(a)
    const b = { typing: true, text: 'Reading…' }
    expect(keepIfSame(a, b)).toBe(b)
    expect(keepIfSame<unknown>(null, null)).toBe(null)
  })

  it('builds one props object per key or per block', () => {
    let built = 0
    const ui = keyedMemo((root: string) => { built++; return { root } })
    expect(ui('msg')).toBe(ui('msg'))
    expect(ui('msg q-picking')).not.toBe(ui('msg'))
    expect(built).toBe(2)
    const parts = weakMemo((b: { text: string }) => [{ type: 'text', text: b.text }])
    const block = { text: 'Hi' }
    expect(parts(block)).toBe(parts(block))
    expect(parts({ text: 'Hi' })).not.toBe(parts(block))
  })

  it('lets wake-up work through at most once per period', () => {
    let t = 0
    const gate = onceEvery(60000, () => t)
    expect(gate.take()).toBe(true)
    t = 30000
    expect(gate.take()).toBe(false)
    expect(gate.wait()).toBe(30000)
    t = 60000
    expect(gate.take()).toBe(true)
    t = 70000
    gate.mark()
    t = 100000
    expect(gate.take()).toBe(false)
  })
})

describe('home rows kept across live pushes', () => {
  const terminals = [
    terminal('t1', { cwd: '/workspace/alpha', template: 'codex', status: { state: 'idle' } }),
    terminal('t2', { cwd: '/workspace/beta', template: 'claude', status: { state: 'working' } }),
    terminal('t3', { cwd: '/workspace/beta', status: { state: 'idle' } }),
  ]
  it('hands the same row while its panes and space are the same, a new one when they change', () => {
    const reuse = createRowReuse()
    const s1 = coreState(terminals, [])
    const first = reuse(spaceRows(s1))
    expect(first.map(r => r.kind)).toEqual(['pane', 'space'])
    // Next push: rebuilt rows, same pane objects (kept by the pane reuse).
    const again = reuse(spaceRows({ ...s1, workspaces: s1.workspaces.map(w => ({ ...w })) }))
    expect(again[0]).toBe(first[0])
    expect(again[1]).toBe(first[1])
    // One pane changes: only its row is new.
    const changed = { ...s1, panes: s1.panes.map(p => (p.coreAddress === 't3' ? { ...p, status: 'working' as const } : p)) }
    const next = reuse(spaceRows(changed))
    expect(next[0]).toBe(first[0])
    expect(next[1]).not.toBe(first[1])
    // A renamed space is a new row too.
    const renamed = { ...changed, workspaces: changed.workspaces.map(w => ({ ...w, label: `${w.label} 2` })) }
    expect(reuse(spaceRows(renamed))[1]).not.toBe(next[1])
  })
})
