import { afterEach, describe, expect, it } from 'vitest'
import { cleanDoc, placementLabels, rootTerminals, type CoreDocs } from '../shared/coreLayout'
import { coreState } from '../shared/coreState'
import { clearCoreDocs, readCoreDocs } from '../server/utils/readCoreDocs'
import type { CoreTerminal } from '../shared/coreInventory'

const term = (address: string, extra: Partial<CoreTerminal> = {}): CoreTerminal => ({ address, cwd: '/w/app', state: 'live', ...extra })
const docs: CoreDocs = {
  '': cleanDoc({ spaces: [
    { id: 'sp1', name: 'App', folder: '/w/app', tabs: [{ id: 'tbA', name: 'Main' }, { id: 'tbB', name: 'Logs' }] },
    { id: 'sp2', name: 'Docs', folder: '/w/docs', tabs: [{ id: 'tbC', name: 'Edit', root: { kind: 'block', content: { terminal: 't9' } } }] },
  ] }),
  vps: cleanDoc({ spaces: [{ id: 'sp1', name: 'Remote', folder: '/srv', tabs: [{ id: 'tbA', name: 'Shell' }] }] }),
}

describe('herdr-app spaces and tabs on the home', () => {
  it('groups by herdr.space / herdr.tab, names them from the document, orders tabs like the document', () => {
    const s = coreState([
      term('t1', { labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tbB' } }),
      term('t2', { labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tbA' } }),
      term('t3', { labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tbA' } }),
    ], [], docs)
    expect(s.workspaces).toHaveLength(1)
    expect(s.workspaces[0]).toMatchObject({ label: 'App', path: '/w/app' })
    expect(s.workspaces[0]!.coreSpace).toBe('sp1')
    expect(s.tabs!.map(t => [t.label, t.number])).toEqual([['Main', 1], ['Logs', 2]])
    expect(s.panes.filter(p => p.tab === s.tabs![0]!.id).map(p => p.coreAddress)).toEqual(['t2', 't3'])
  })
  it('puts a tab missing from the document after the known ones', () => {
    const s = coreState([term('t1', { labels: { 'herdr.space': 'sp1', 'herdr.tab': 'new' } }),
      term('t2', { labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tbB' } })], [], docs)
    expect(s.tabs!.map(t => t.label)).toEqual(['Logs', 'app'])
    // Named by the document (Rename tab is not offered there), or by its terminal.
    expect(s.tabs!.map(t => t.docName ?? false)).toEqual([true, false])
  })
  it('keeps the same ids for a machine whose space ids equal the local ones', () => {
    const s = coreState([term('t1', { labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tbA' } }),
      term('vps/t1', { labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tbA' } })], [{ name: 'vps', state: 'connected' }], docs)
    expect(s.workspaces.map(w => [w.label, w.machine === ''])).toEqual([['App', true], ['Remote', false]])
  })
  it('places a terminal through the layout of a document tab, with no label', () => {
    const s = coreState([term('t9', { cwd: '/x' })], [], docs)
    expect(s.workspaces[0]).toMatchObject({ label: 'Docs', coreSpace: 'sp2' })
    expect(s.tabs![0]!.label).toBe('Edit')
  })
  it('falls back to the folder for unlabelled terminals, unknown spaces and a missing document', () => {
    const s = coreState([term('t1'), term('t2', { labels: { 'herdr.space': 'zzz', 'herdr.tab': 'tb1' } })], [], {})
    expect(s.workspaces.map(w => [w.label, w.coreSpace])).toEqual([['app', undefined], ['app', 'zzz']])
    expect(s.tabs).toHaveLength(2)
  })
  it('drops what a document should not contain and reads layout trees', () => {
    expect(cleanDoc(null)).toBeNull()
    expect(cleanDoc({ spaces: [{ id: 3 }, { id: 'a', tabs: [{ name: 'x' }] }] })).toEqual({ spaces: [{ id: 'a', name: undefined, folder: undefined, tabs: [] }] })
    expect(rootTerminals({ a: [{ terminal: 't1' }], b: { c: { terminal: 'm/t2' } } })).toEqual(['t1', 'm/t2'])
  })
  it('builds placement labels: deepest folder, else a new space', () => {
    const spaces = [{ id: 'a', folder: '/w' }, { id: 'b', folder: '/w/app/' }]
    let n = 0
    const id = (p: string) => `${p}${++n}`
    expect(placementLabels(spaces, '/w/app/src', id)).toEqual({ 'herdr.space': 'b', 'herdr.tab': 'tb1', 'herdr.seen': '0' })
    expect(placementLabels(spaces, '/other', id)['herdr.space']).toBe('sp2')
    expect(placementLabels(spaces, '/w', id, 'zz')['herdr.space']).toBe('zz')
  })
})

describe('reading the herdr-app documents', () => {
  afterEach(clearCoreDocs)
  it('reads the local one and each connected machine, caches, and tolerates failures', async () => {
    const calls: object[] = []
    const call = async (_m: string, p: object) => {
      calls.push(p)
      if ((p as { on?: string }).on === 'bad') throw new Error('x')
      return { value: { spaces: [{ id: 's', tabs: [] }] } } as never
    }
    const machines = [{ name: 'vps', state: 'connected' }, { name: 'bad', state: 'connected' }, { name: 'off', state: 'unreachable' }]
    const d = await readCoreDocs(call, machines, 1000)
    expect(Object.keys(d)).toEqual(['', 'vps', 'bad'])
    expect(d.bad).toBeNull()
    expect(d.vps?.spaces).toHaveLength(1)
    expect(calls).toHaveLength(3)
    await readCoreDocs(call, machines, 2000)
    expect(calls).toHaveLength(3)
    await readCoreDocs(call, machines, 7000)
    expect(calls).toHaveLength(6)
  })
})
