import { describe, expect, it } from 'vitest'
import { coreState } from '../shared/coreState'
import { splitLabels } from '../shared/coreLayout'
import type { CoreDocs } from '../shared/coreLayout'
import type { CoreTerminal } from '../shared/coreInventory'

const terminal = (address: string, labels?: Record<string, string>): CoreTerminal => ({ address, cwd: '~/project', state: 'live', ...(labels ? { labels } : {}) })
// Split t1 down: label the new t2 (and t1 when asked) as the server does, then place both again.
function split(terminals: CoreTerminal[], docs: CoreDocs = {}) {
  const before = coreState(terminals, [], docs)
  const pane = before.panes.find(p => p.coreAddress.endsWith('t1'))!
  const s = splitLabels(pane, before.workspaces.find(w => w.id === pane.workspace)?.coreSpace, () => 'wt1')!
  const relabelled = terminals.map(t => (t === terminals[0] && s.relabel ? { ...t, labels: { ...t.labels, ...s.relabel } } : t))
  const after = coreState([...relabelled, { ...terminal(terminals[0]!.address.replace('t1', 't2')), labels: s.labels }], [], docs)
  return { s, after, tabs: after.panes.map(p => p.tab) }
}

describe('Split down placement', () => {
  it('uses the herdr.space / herdr.tab labels of the terminal', () => {
    const { s, after, tabs } = split([terminal('t1', { 'herdr.space': 'sp1', 'herdr.tab': 'tb1' })])
    expect(s.relabel).toBeUndefined()
    expect(s.labels).toMatchObject({ 'herdr.space': 'sp1', 'herdr.tab': 'tb1' })
    expect(new Set(tabs).size).toBe(1)
    expect(after.tabs).toHaveLength(1)
  })
  it('uses the herdr-app document that holds the terminal', () => {
    const docs: CoreDocs = { '': { spaces: [{ id: 'sp1', tabs: [{ id: 'tb1', root: { kind: 'block', content: { terminal: 't1' } } }] }] } }
    const { s, tabs } = split([terminal('t1')], docs)
    expect(s.labels).toMatchObject({ 'herdr.space': 'sp1', 'herdr.tab': 'tb1' })
    expect(new Set(tabs).size).toBe(1)
  })
  it('labels both terminals of a folder tab with wherdr.tab, on another machine too', () => {
    const { s, after, tabs } = split([terminal('m1/t1')])
    expect(s.relabel).toEqual({ 'wherdr.tab': 'wt1' })
    expect(new Set(tabs).size).toBe(1)
    expect(after.workspaces).toHaveLength(1)
    // A second split of that tab reuses its label.
    const pane = after.panes[0]!
    expect(splitLabels(pane, undefined, () => 'other')).toEqual({ labels: { 'wherdr.tab': 'wt1' } })
  })
  it('gives a simple tab back once one of the two is closed', () => {
    const { after } = split([terminal('t1')])
    const left = coreState([{ ...terminal('t1'), labels: { 'wherdr.tab': 'wt1' } }], [])
    expect(after.tabs).toHaveLength(1)
    expect(left.tabs).toHaveLength(1)
    expect(left.panes.filter(p => p.tab === left.tabs![0]!.id)).toHaveLength(1)
  })
})
