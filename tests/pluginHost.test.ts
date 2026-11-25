import { describe, expect, it, vi } from 'vitest'
import { createPluginHost, type HostDeps, type PublicAgent, type PublicMachine } from '../app/utils/pluginHost'
import { readPrefs, type ClientPluginInfo, type PluginPrefs } from '../shared/clientPlugins'

const info = (id: string): ClientPluginInfo => ({ id, name: id, version: '1', description: '', main: 'index.js' })

function setup(plugins: Record<string, unknown>, prefs: PluginPrefs = { off: [], failed: {} }, enabled = true) {
  let saved = prefs
  let draftText: string | null = 'initial'
  const navs = new Set<(p: string) => void>()
  const agentSubs = new Set<(list: PublicAgent[]) => void>()
  const headerMounts = new Set<(el: unknown) => unknown>()
  const agentsData: PublicAgent[] = [
    { id: 'w1:p1', machine: null, name: 'demo', title: 'Working', agent: 'claude', status: 'idle', labels: { 'wherdr.task': 'WHR-1' } },
  ]
  const machinesData: PublicMachine[] = [
    { id: '', groupKey: '', label: 'local', local: true, status: 'online' },
  ]
  const insert = vi.fn((t: string) => {
    if (draftText !== null) draftText = draftText && !/\s$/.test(draftText) ? `${draftText} ${t}` : draftText + t
  })
  const focus = vi.fn()
  const deps: HostDeps = {
    list: async () => ({ plugins: Object.keys(plugins).map(info), enabled }),
    load: async i => ({ default: plugins[i.id] }),
    getDraft: () => draftText,
    setDraft: (t) => { if (draftText !== null) draftText = t },
    insertDraft: insert,
    focusDraft: focus,
    currentAgent: () => ({ id: 'w1:p1', agent: 'claude', name: 'demo', machine: null }),
    agents: () => agentsData,
    machines: () => machinesData,
    subscribeNavigate: (cb) => { navs.add(cb); return () => navs.delete(cb) },
    subscribeAgents: (cb) => { agentSubs.add(cb); return () => agentSubs.delete(cb) },
    mountHeaderAction: (render) => { headerMounts.add(render); return () => headerMounts.delete(render) },
    prefs: () => saved,
    savePrefs: (p) => { saved = p },
    changed: () => {},
    timeoutMs: 50,
  }
  const host = createPluginHost(deps)
  return {
    host, deps, insert, focus, navs, agentSubs, headerMounts, agentsData, machinesData,
    getDraft: () => draftText,
    setDraftRaw: (v: string | null) => { draftText = v },
    saved: () => saved,
    status: (id: string) => host.rows().find(r => r.id === id)?.status,
  }
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

  it('gives a plugin that failed a new try once an update changed its commit', async () => {
    let commit = 'a'
    const s = setup({ p: () => { if (commit === 'a') throw new Error('boom') } })
    const h = createPluginHost({ ...s.deps, list: async () => ({ plugins: [{ ...info('p'), source: { repo: 'me/p', ref: '', commit } }], enabled: true }) })
    await h.init()
    expect(h.rows()[0]).toMatchObject({ status: 'failed', error: 'boom' })
    await h.refresh()
    expect(h.rows()[0]!.status).toBe('failed')
    commit = 'b'
    await h.refresh()
    expect(h.rows()[0]).toMatchObject({ status: 'running', error: '' })
  })

  it('survives a failing manifest list', async () => {
    const s = setup({})
    const h = createPluginHost({ ...s.deps, list: async () => { throw new Error('offline') } })
    await h.init()
    expect(h.rows()).toEqual([])
    expect(h.listError()).toBe('offline')
  })

  it('exposes draft.get, draft.set and draft.focus with and without a conversation', async () => {
    let api!: Parameters<Exclude<Parameters<typeof setup>[0][string], undefined>>[0] & {
      draft: { get: () => string | null, set: (t: string) => void, insert: (t: string) => void, focus: () => void }
    }
    const s = setup({ p: (w: typeof api) => { api = w } })
    await s.host.init()
    expect(api.draft.get()).toBe('initial')
    api.draft.set('replaced')
    expect(api.draft.get()).toBe('replaced')
    api.draft.set('')
    expect(api.draft.get()).toBe('')
    api.draft.focus()
    expect(s.focus).toHaveBeenCalledTimes(1)
    s.setDraftRaw(null)
    expect(api.draft.get()).toBeNull()
    api.draft.set('ignored')
    expect(s.getDraft()).toBeNull()
  })

  it('disposes every registration when deactivate is missing, throws, or rejects, and disposers are idempotent', async () => {
    const rawOff = vi.fn()
    let navOff!: () => void
    let actionOff!: () => void
    let agentsOff!: () => void
    const customHost = (plugin: unknown) => {
      let saved: PluginPrefs = { off: [], failed: {} }
      const navs = new Set<() => void>()
      const mounts = new Set<() => void>()
      const agentSubs = new Set<() => void>()
      const host = createPluginHost({
        list: async () => ({ plugins: [info('p')], enabled: true }),
        load: async () => ({ default: plugin }),
        getDraft: () => null,
        setDraft() {},
        insertDraft() {},
        focusDraft() {},
        currentAgent: () => null,
        agents: () => [],
        machines: () => [],
        subscribeNavigate: (cb) => {
          const fn = () => { cb('/') }
          navs.add(fn)
          return () => { rawOff(); navs.delete(fn) }
        },
        subscribeAgents: (cb) => {
          const fn = () => { cb([]) }
          agentSubs.add(fn)
          return () => { rawOff(); agentSubs.delete(fn) }
        },
        mountHeaderAction: () => {
          const fn = () => {}
          mounts.add(fn)
          return () => mounts.delete(fn)
        },
        prefs: () => saved,
        savePrefs: (p) => { saved = p },
        changed: () => {},
        timeoutMs: 50,
      })
      return { host, navs, mounts, agentSubs }
    }

    // Function plugin (deactivate missing)
    const missing = customHost((w: { onNavigate: (c: () => void) => () => void, mountHeaderAction: (r: () => void) => () => void, onAgents: (c: () => void) => () => void }) => {
      navOff = w.onNavigate(() => {})
      actionOff = w.mountHeaderAction(() => {})
      agentsOff = w.onAgents(() => {})
    })
    await missing.host.init()
    expect(missing.navs.size).toBe(1)
    expect(missing.mounts.size).toBe(1)
    expect(missing.agentSubs.size).toBe(1)
    navOff()
    navOff()
    agentsOff()
    agentsOff()
    expect(rawOff).toHaveBeenCalledTimes(2)
    await missing.host.setEnabled('p', false)
    expect(missing.navs.size).toBe(0)
    expect(missing.mounts.size).toBe(0)
    expect(missing.agentSubs.size).toBe(0)
    actionOff()
    expect(missing.mounts.size).toBe(0)

    // Throwing deactivate
    const throwing = customHost({
      activate: (w: { onNavigate: (c: () => void) => () => void, mountHeaderAction: (r: () => void) => () => void }) => {
        w.onNavigate(() => {})
        w.mountHeaderAction(() => {})
      },
      deactivate: () => { throw new Error('teardown failed') },
    })
    await throwing.host.init()
    await throwing.host.setEnabled('p', false)
    expect(throwing.navs.size).toBe(0)
    expect(throwing.mounts.size).toBe(0)

    // Rejecting deactivate
    const rejecting = customHost({
      activate: (w: { onNavigate: (c: () => void) => () => void, mountHeaderAction: (r: () => void) => () => void }) => {
        w.onNavigate(() => {})
        w.mountHeaderAction(() => {})
      },
      deactivate: () => Promise.reject(new Error('async teardown failed')),
    })
    await rejecting.host.init()
    await rejecting.host.setEnabled('p', false)
    expect(rejecting.navs.size).toBe(0)
    expect(rejecting.mounts.size).toBe(0)
  })

  it('disables only a plugin whose callback rejects and disposes all its registrations while others keep running', async () => {
    const s = setup({
      bad: (w: { onNavigate: (c: () => Promise<void>) => void, mountHeaderAction: (r: () => void) => void }) => {
        w.onNavigate(async () => { throw new Error('async boom') })
        w.mountHeaderAction(() => {})
      },
      good: (w: { onNavigate: (c: (p: string) => void) => void, mountHeaderAction: (r: () => void) => void }) => {
        w.onNavigate(p => s.insert(`good:${p}`))
        w.mountHeaderAction(() => {})
      },
    })
    await s.host.init()
    expect(s.navs.size).toBe(2)
    expect(s.headerMounts.size).toBe(2)
    s.navs.forEach(cb => cb('/a'))
    await vi.waitFor(() => expect(s.status('bad')).toBe('failed'))
    expect(s.status('good')).toBe('running')
    expect(s.navs.size).toBe(1)
    expect(s.headerMounts.size).toBe(1)
    s.navs.forEach(cb => cb('/b'))
    expect(s.insert).toHaveBeenCalledWith('good:/b')
  })

  it('disposes all registrations across plugins when Community plugins is turned off', async () => {
    const s = setup({
      a: (w: { onNavigate: (c: () => void) => void, mountHeaderAction: (r: () => void) => void }) => {
        w.onNavigate(() => {})
        w.mountHeaderAction(() => {})
      },
      b: (w: { onNavigate: (c: () => void) => void, mountHeaderAction: (r: () => void) => void }) => {
        w.onNavigate(() => {})
        w.mountHeaderAction(() => {})
      },
    })
    await s.host.init()
    expect(s.navs.size).toBe(2)
    expect(s.headerMounts.size).toBe(2)
    await s.host.setCommunity(false)
    expect(s.navs.size).toBe(0)
    expect(s.headerMounts.size).toBe(0)
  })

  it('gives plugins copied PublicAgent and PublicMachine snapshots and isolates onAgents failures', async () => {
    const seenByB: PublicAgent[][] = []
    const s = setup({
      a: (w: { agents: () => PublicAgent[], machines: () => PublicMachine[], onAgents: (cb: (l: PublicAgent[]) => void) => void }) => {
        const list = w.agents()
        list[0]!.name = 'hacked'
        list[0]!.labels['wherdr.task'] = 'HACKED'
        const ms = w.machines()
        ms[0]!.label = 'hacked-machine'
        w.onAgents((next) => {
          next[0]!.labels['wherdr.task'] = 'MUTATED_IN_CB'
          throw new Error('agents cb failed')
        })
      },
      b: (w: { agents: () => PublicAgent[], machines: () => PublicMachine[], onAgents: (cb: (l: PublicAgent[]) => void) => void }) => {
        expect(w.agents()[0]!.name).toBe('demo')
        expect(w.agents()[0]!.labels['wherdr.task']).toBe('WHR-1')
        expect(w.machines()[0]!.label).toBe('local')
        w.onAgents(next => seenByB.push(next))
      },
    })
    await s.host.init()
    expect(s.agentSubs.size).toBe(2)

    const pushed: PublicAgent[] = [
      { id: 'w1:p1', machine: null, name: 'demo', title: 'Done', agent: 'claude', status: 'idle', labels: { 'wherdr.task': 'WHR-2' } },
    ]
    for (const cb of [...s.agentSubs]) cb(pushed)
    expect(s.status('a')).toBe('failed')
    expect(s.status('b')).toBe('running')
    expect(s.agentSubs.size).toBe(1)
    expect(seenByB).toHaveLength(1)
    expect(seenByB[0]![0]!.labels['wherdr.task']).toBe('WHR-2')

    await s.host.setCommunity(false)
    expect(s.agentSubs.size).toBe(0)
  })

  it('disables a plugin whose onAgents callback rejects asynchronously', async () => {
    const s = setup({
      bad: (w: { onAgents: (c: () => Promise<void>) => void, mountHeaderAction: (r: () => void) => void }) => {
        w.onAgents(async () => { throw new Error('async agents boom') })
        w.mountHeaderAction(() => {})
      },
      good: (w: { onAgents: (c: (l: PublicAgent[]) => void) => void }) => {
        w.onAgents(() => {})
      },
    })
    await s.host.init()
    expect(s.agentSubs.size).toBe(2)
    expect(s.headerMounts.size).toBe(1)
    for (const cb of [...s.agentSubs]) cb([])
    await vi.waitFor(() => expect(s.status('bad')).toBe('failed'))
    expect(s.status('good')).toBe('running')
    expect(s.agentSubs.size).toBe(1)
    expect(s.headerMounts.size).toBe(0)
  })
})

describe('plugin prefs', () => {
  it('reads defensively', () => {
    expect(readPrefs(null)).toEqual({ off: [], failed: {} })
    expect(readPrefs('{oops')).toEqual({ off: [], failed: {} })
    expect(readPrefs('{"off":["a",1],"failed":{"b":"x","c":2}}')).toEqual({ off: ['a'], failed: { b: 'x' } })
  })
})
