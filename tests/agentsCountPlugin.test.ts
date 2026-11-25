// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createPluginHost, type HostDeps, type PublicAgent } from '../app/utils/pluginHost'
import { createHeaderActionsMount } from '../app/utils/headerActions'

const dir = resolve(__dirname, '../docs/examples/plugins/agents-count')

const hosts: ReturnType<typeof createPluginHost>[] = []

function setup(load: HostDeps['load'], initial: PublicAgent[]) {
  let current = initial
  const subs = new Set<(list: PublicAgent[]) => void>()
  let prefs = { off: [] as string[], failed: {} as Record<string, string> }
  const host = createPluginHost({
    list: async () => ({ plugins: [{ id: 'agents-count', name: 'Agents count', version: '1.0.0', description: '', main: 'index.js' }], enabled: true }),
    load,
    getDraft: () => null,
    setDraft: () => {},
    insertDraft: () => {},
    focusDraft: () => {},
    currentAgent: () => null,
    agents: () => current,
    machines: () => [],
    subscribeNavigate: () => () => {},
    subscribeAgents: (cb) => { subs.add(cb); return () => subs.delete(cb) },
    mountHeaderAction: createHeaderActionsMount(),
    prefs: () => prefs,
    savePrefs: (p) => { prefs = p },
    changed: () => {},
    timeoutMs: 1000,
  })
  hosts.push(host)
  return {
    host,
    subs,
    push: (next: PublicAgent[]) => {
      current = next
      for (const cb of [...subs]) cb(next)
    },
  }
}

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.setEnabled('agents-count', false)
  document.body.innerHTML = ''
  document.head.innerHTML = ''
})

describe('agents-count example plugin', () => {
  it('mounts the live agent count and one label in header-actions and updates reactively', async () => {
    document.body.innerHTML = '<div class="home-actions"><span data-wherdr="header-actions" class="header-actions"></span></div>'
    const s = setup(
      () => import(/* @vite-ignore */ pathToFileURL(resolve(dir, 'index.js')).href),
      [{ id: 'w1:p1', machine: null, name: 'a', title: null, agent: 'claude', status: 'idle', labels: { role: 'worker', 'wherdr.task': 'WHR-1' } }],
    )
    await s.host.init()
    expect(s.host.rows()[0]!.status).toBe('running')

    const badge = document.querySelector<HTMLElement>('[data-wherdr="header-actions"] .agents-count')!
    expect(badge).not.toBeNull()
    expect(badge.textContent).toBe('1 agent · role=worker')

    s.push([
      { id: 'w1:p1', machine: null, name: 'a', title: null, agent: 'claude', status: 'working', labels: { role: 'reviewer' } },
      { id: 'w1:p2', machine: 'box', name: 'b', title: null, agent: 'codex', status: 'idle', labels: {} },
    ])
    expect(badge.textContent).toBe('2 agents · role=reviewer')

    await s.host.setEnabled('agents-count', false)
    expect(document.querySelector('[data-wherdr="header-actions"] .agents-count')).toBeNull()
    expect(document.getElementById('agents-count-style')).toBeNull()
    expect(s.subs.size).toBe(0)
  })
})
