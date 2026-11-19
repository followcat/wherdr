import { describe, expect, it, vi } from 'vitest'
import { createPluginHost, type HostDeps } from '../app/utils/pluginHost'
import { readPrefs, type ClientPluginInfo, type PluginPrefs } from '../shared/clientPlugins'

const info = (id: string): ClientPluginInfo => ({ id, name: id, version: '1', description: '', main: 'index.js' })

function setup(plugins: Record<string, unknown>, prefs: PluginPrefs = { off: [], failed: {} }, enabled = true) {
  let saved = prefs
  const navs = new Set<(p: string) => void>()
  const insert = vi.fn()
  const deps: HostDeps = {
    list: async () => ({ plugins: Object.keys(plugins).map(info), enabled }),
    load: async i => ({ default: plugins[i.id] }),
    insertDraft: insert,
    currentAgent: () => ({ id: 'w1:p1', agent: 'claude', name: 'demo', machine: null }),
    subscribeNavigate: (cb) => { navs.add(cb); return () => navs.delete(cb) },
    prefs: () => saved,
    savePrefs: (p) => { saved = p },
    changed: () => {},
    timeoutMs: 50,
  }
  const host = createPluginHost(deps)
  return { host, deps, insert, navs, saved: () => saved, status: (id: string) => host.rows().find(r => r.id === id)?.status }
}

describe('plugin host', () => {
  it('does nothing without plugins', async () => {
    const s = setup({})
    await s.host.init()
    expect(s.host.rows()).toEqual([])
  })

  it('gives the plugin the wherdr API', async () => {
    let seen: ReturnType<typeof Object> | null = null
    const s = setup({ ok: (w: { draft: { insert: (t: string) => void }, currentAgent: () => unknown, onNavigate: (cb: (p: string) => void) => void }) => {
      w.draft.insert('hello')
      seen = w.currentAgent() as object
      w.onNavigate(p => s.insert(`nav:${p}`))
    } })
    await s.host.init()
    expect(s.status('ok')).toBe('running')
    expect(s.insert).toHaveBeenCalledWith('hello')
    expect(seen).toMatchObject({ id: 'w1:p1', agent: 'claude' })
    s.navs.forEach(cb => cb('/settings'))
    expect(s.insert).toHaveBeenCalledWith('nav:/settings')
  })

  it('disables a plugin that throws, keeps the others', async () => {
    const s = setup({ bad: () => { throw new Error('boom') }, good: () => {} })
    await s.host.init()
    expect(s.status('bad')).toBe('failed')
    expect(s.status('good')).toBe('running')
    expect(s.host.rows().find(r => r.id === 'bad')?.error).toBe('boom')
    expect(s.saved().failed.bad).toBe('boom')
  })

  it('disables a plugin whose callback throws, and stops calling it', async () => {
    const cb = vi.fn(() => { throw new Error('late') })
    const s = setup({ p: (w: { onNavigate: (c: () => void) => void }) => w.onNavigate(cb) })
    await s.host.init()
    s.navs.forEach(f => f('/a'))
    s.navs.forEach(f => f('/b'))
    expect(cb).toHaveBeenCalledTimes(1)
    expect(s.status('p')).toBe('failed')
    expect(s.navs.size).toBe(0)
  })

  it('fails a bundle without a default export, a rejected load and a hang', async () => {
    const s = setup({ none: undefined, slow: () => new Promise(() => {}) })
    await s.host.init()
    expect(s.status('none')).toBe('failed')
    expect(s.status('slow')).toBe('failed')
    expect(s.host.rows().find(r => r.id === 'slow')?.error).toMatch(/timed out/)
  })

  it('does not start a plugin that is off or failed; enabling retries', async () => {
    const run = vi.fn()
    const s = setup({ a: run, b: run }, { off: ['a'], failed: { b: 'earlier' } })
    await s.host.init()
    expect(run).not.toHaveBeenCalled()
    expect([s.status('a'), s.status('b')]).toEqual(['off', 'failed'])
    await s.host.setEnabled('b', true)
    expect(run).toHaveBeenCalledTimes(1)
    expect(s.status('b')).toBe('running')
    expect(s.saved().failed.b).toBeUndefined()
    await s.host.setEnabled('b', false)
    expect(s.status('b')).toBe('off')
    expect(s.saved().off).toContain('b')
  })

  it('disabling unsubscribes and calls deactivate', async () => {
    const deactivate = vi.fn()
    const s = setup({ p: { activate: (w: { onNavigate: (c: () => void) => void }) => w.onNavigate(() => {}), deactivate } })
    await s.host.init()
    expect(s.navs.size).toBe(1)
    await s.host.setEnabled('p', false)
    expect(s.navs.size).toBe(0)
    expect(deactivate).toHaveBeenCalled()
  })

  it('loads nothing while Community plugins is off, then starts the wanted ones', async () => {
    const run = vi.fn()
    const s = setup({ a: run, b: run }, { off: ['b'], failed: {} }, false)
    await s.host.init()
    expect(run).not.toHaveBeenCalled()
    expect(s.host.rows().map(r => [r.status, r.wanted])).toEqual([['off', true], ['off', false]])
    await s.host.setEnabled('b', true)
    expect(run).not.toHaveBeenCalled()
    await s.host.setCommunity(true)
    expect(run).toHaveBeenCalledTimes(1)
    expect(s.status('a')).toBe('running')
    await s.host.setCommunity(false)
    expect(s.status('a')).toBe('off')
    expect(s.host.rows()[0]!.wanted).toBe(true)
  })

  it('drops a load still pending when Community plugins is turned off', async () => {
    let resolve!: (m: { default: unknown }) => void
    const activate = vi.fn()
    const s = setup({ p: activate })
    const h = createPluginHost({ ...s.deps, load: () => new Promise(r => { resolve = r }) })
    const init = h.init()
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    await h.setCommunity(false)
    resolve({ default: activate })
    await init
    expect(activate).not.toHaveBeenCalled()
    expect(h.rows()[0]!.status).toBe('off')
  })

  it('survives a failing manifest list', async () => {
    const s = setup({})
    const h = createPluginHost({ ...({ list: async () => { throw new Error('offline') } } as Partial<HostDeps>), insertDraft() {}, currentAgent: () => null, subscribeNavigate: () => () => {}, prefs: s.saved, savePrefs() {}, changed() {}, load: async () => ({}) } as HostDeps)
    await h.init()
    expect(h.rows()).toEqual([])
    expect(h.listError()).toBe('offline')
  })
})

describe('plugin prefs', () => {
  it('reads defensively', () => {
    expect(readPrefs(null)).toEqual({ off: [], failed: {} })
    expect(readPrefs('{oops')).toEqual({ off: [], failed: {} })
    expect(readPrefs('{"off":["a",1],"failed":{"b":"x","c":2}}')).toEqual({ off: ['a'], failed: { b: 'x' } })
  })
})
