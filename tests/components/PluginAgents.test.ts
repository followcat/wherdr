import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { curPane, herdrState } from '~/composables/useHerdr'
import { createAppPluginDeps } from '~/composables/useClientPlugins'
import { createPluginHost, type PublicAgent, type WherdrApi } from '~/utils/pluginHost'
import { coreState } from '#shared/coreState'
import type { HerdrState, Pane } from '#shared/types'

registerEndpoint('/api/client-plugins', () => ({ plugins: [], enabled: false }))

const pane = (id: string, extra: Partial<Pane> = {}): Pane => ({
  id,
  coreAddress: `hc:${id}`,
  workspace: 'w1',
  tab: 'w1:t1',
  tabLabel: null,
  agent: 'claude',
  name: 'alpha',
  label: null,
  status: 'idle',
  title: 'Ready',
  cwd: '/home/user/demo',
  agentSession: 'secret-session',
  labels: { 'wherdr.task': 'WHR-1' },
  ...extra,
})

describe('plugin agents, machines and onAgents wiring', () => {
  beforeEach(() => {
    herdrState.value = coreState([
      { address: 't1', cwd: '/home/user/demo', state: 'live', name: 'local-claude', title: 'Initial', template: 'claude', status: { state: 'idle' }, labels: { env: 'dev' } },
      { address: 'box/t2', cwd: '/srv/app', state: 'live', title: 'Remote build', template: 'codex', status: { state: 'working' }, labels: { 'wherdr.task': 'WHR-9' } },
    ], [{ name: 'box', state: 'connected' }])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    curPane.value = null
    herdrState.value = { ok: false, workspaces: [], panes: [] }
  })

  it('projects agents() and machines() from herdrState with zero network requests and no private fields', async () => {
    let api!: WherdrApi
    const host = createPluginHost(createAppPluginDeps(() => {}, {
      list: async () => ({ plugins: [{ id: 'reader', name: 'Reader', version: '1', description: '', main: 'index.js' }], enabled: true }),
      load: async () => ({ default: (w: WherdrApi) => { api = w } }),
      prefs: () => ({ off: [], failed: {} }),
      savePrefs: () => {},
    }))
    await host.init()

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const agents = api.agents()
    const machines = api.machines()
    expect(fetchSpy).not.toHaveBeenCalled()

    expect(agents).toHaveLength(2)
    expect(machines.length).toBeGreaterThanOrEqual(2)
    const remote = machines.find(m => !m.local)!
    expect(remote).toMatchObject({ label: 'box', local: false, status: 'online' })
    expect(agents[0]).toMatchObject({ machine: null, name: 'local-claude', title: 'Initial', agent: 'claude', status: 'idle', labels: { env: 'dev' } })
    expect(agents[1]).toMatchObject({ machine: remote.id, title: 'Remote build', agent: 'codex', status: 'working', labels: { 'wherdr.task': 'WHR-9' } })
    expect(machines.find(m => m.local)).toMatchObject({ id: '', groupKey: '', local: true, status: 'online' })

    for (const a of agents) expect('coreAddress' in a || 'session' in a).toBe(false)
    for (const m of machines) expect('session' in m || 'error' in m).toBe(false)

    // Mutating returned objects and labels leaves wherdr state intact.
    agents[0]!.labels.env = 'mutated'
    agents[0]!.title = 'Mutated'
    machines[0]!.label = 'Mutated machine'
    expect(api.agents()[0]!.labels.env).toBe('dev')
    expect(api.agents()[0]!.title).toBe('Initial')
    expect(api.machines()[0]!.label).not.toBe('Mutated machine')

    await host.setCommunity(false)
  })

  it('calls onAgents on projected changes, ignores unrelated state pushes, isolates mutations, and stops on disable', async () => {
    const events: PublicAgent[][] = []
    let tampererCalls = 0
    let observerApi!: WherdrApi
    let prefs = { off: [] as string[], failed: {} as Record<string, string> }
    const plugins: Record<string, (w: WherdrApi) => void> = {
      tamperer: (w) => {
        w.onAgents((list) => {
          tampererCalls++
          if (list[0]) list[0].labels['wherdr.task'] = 'TAMPERED'
        })
      },
      observer: (w) => {
        observerApi = w
        w.onAgents(list => events.push(list))
      },
    }
    const host = createPluginHost(createAppPluginDeps(() => {}, {
      list: async () => ({ plugins: Object.keys(plugins).map(id => ({ id, name: id, version: '1', description: '', main: 'index.js' })), enabled: true }),
      load: async i => ({ default: plugins[i.id] }),
      prefs: () => prefs,
      savePrefs: (p) => { prefs = p },
    }))
    await host.init()

    const base: HerdrState = {
      ok: true,
      workspaces: [{ id: 'w1', number: 1, label: 'Demo', focused: false }],
      machines: [{ key: '', label: 'Host', local: true, status: 'online', error: null }],
      panes: [pane('w1:p1')],
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    herdrState.value = base
    expect(tampererCalls).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0]![0]!.labels['wherdr.task']).toBe('WHR-1')
    expect(herdrState.value.panes[0]!.labels?.['wherdr.task']).toBe('WHR-1')
    expect(observerApi.agents()[0]!.labels['wherdr.task']).toBe('WHR-1')

    // Unrelated pushes (workspace rename, preview, coreAddress, claudeScreen, usageLimit) must not fire onAgents.
    herdrState.value = {
      ...base,
      workspaces: [{ id: 'w1', number: 1, label: 'Renamed', focused: true }],
      claudeScreen: 'screen text',
      usageLimit: { agent: 'claude', until: 123, text: 'limit' },
      panes: [pane('w1:p1', { coreAddress: 'hc:changed', preview: 'preview', cwd: '/other' })],
    }
    expect(events).toHaveLength(1)

    // Projected change (status / label) fires onAgents cleanly.
    herdrState.value = {
      ...base,
      panes: [pane('w1:p1', { status: 'working', labels: { 'wherdr.task': 'WHR-2' } })],
    }
    expect(tampererCalls).toBe(2)
    expect(events).toHaveLength(2)
    expect(events[1]![0]).toMatchObject({ id: 'w1:p1', status: 'working', labels: { 'wherdr.task': 'WHR-2' } })
    expect(observerApi.agents()[0]!.labels['wherdr.task']).toBe('WHR-2')
    expect(fetchSpy).not.toHaveBeenCalled()

    await host.setEnabled('observer', false)
    herdrState.value = {
      ...base,
      panes: [pane('w1:p1', { status: 'blocked' })],
    }
    expect(events).toHaveLength(2)
    expect(tampererCalls).toBe(3)
    await host.setCommunity(false)
  })
})
