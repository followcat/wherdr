// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHeaderActionsMount, hasHeaderActions } from '../app/utils/headerActions'
import { createPluginHost } from '../app/utils/pluginHost'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('header-actions mount helper', () => {
  it('mounts into existing and dynamically added header-actions slots and cleans up on dispose', async () => {
    document.body.innerHTML = '<header><span data-wherdr="header-actions" class="header-actions"></span></header>'
    const slot = document.querySelector('[data-wherdr="header-actions"]')!
    expect(hasHeaderActions(slot)).toBe(false)

    const mount = createHeaderActionsMount()
    const cleanups: number[] = []
    const dispose = mount((el) => {
      const btn = document.createElement('button')
      btn.className = 'plugin-pill'
      btn.textContent = 'Run'
      el.append(btn)
      return () => { cleanups.push(1) }
    })

    expect(hasHeaderActions(slot)).toBe(true)
    expect(document.querySelectorAll('[data-wherdr="header-actions"] .plugin-pill')).toHaveLength(1)

    // Agent header mounts later on navigation
    const agentHeader = document.createElement('header')
    agentHeader.innerHTML = '<span data-wherdr="header-actions" class="header-actions"></span>'
    document.body.append(agentHeader)
    await vi.waitFor(() => expect(document.querySelectorAll('[data-wherdr="header-actions"] .plugin-pill')).toHaveLength(2))

    // Leaving the agent view runs its slot cleanup
    agentHeader.remove()
    await vi.waitFor(() => expect(cleanups).toHaveLength(1))

    // Disposing removes remaining elements and is idempotent
    dispose()
    dispose()
    expect(cleanups).toHaveLength(2)
    expect(hasHeaderActions(slot)).toBe(false)
    expect(document.querySelectorAll('.plugin-pill')).toHaveLength(0)
    expect(slot.children).toHaveLength(0)
  })

  it('isolates throwing or rejecting mountHeaderAction renderers while other plugins stay mounted', async () => {
    document.body.innerHTML = '<header><span data-wherdr="header-actions" class="header-actions"></span></header>'
    const mount = createHeaderActionsMount()
    let prefs = { off: [] as string[], failed: {} as Record<string, string> }
    const plugins: Record<string, unknown> = {
      syncBad: (w: { mountHeaderAction: (fn: (el: HTMLElement) => void) => void }) => {
        w.mountHeaderAction((el) => {
          el.append(document.createElement('span'))
          throw new Error('sync mount boom')
        })
      },
      asyncBad: (w: { mountHeaderAction: (fn: (el: HTMLElement) => Promise<void>) => void }) => {
        w.mountHeaderAction(async (el) => {
          el.append(document.createElement('span'))
          throw new Error('async mount boom')
        })
      },
      good: (w: { mountHeaderAction: (fn: (el: HTMLElement) => void) => void }) => {
        w.mountHeaderAction((el) => {
          const btn = document.createElement('button')
          btn.className = 'good-btn'
          btn.textContent = 'OK'
          el.append(btn)
        })
      },
    }
    const host = createPluginHost({
      list: async () => ({ plugins: Object.keys(plugins).map(id => ({ id, name: id, version: '1', description: '', main: 'index.js' })), enabled: true }),
      load: async i => ({ default: plugins[i.id] }),
      getDraft: () => null,
      setDraft() {},
      insertDraft() {},
      focusDraft() {},
      currentAgent: () => null,
      agents: () => [],
      machines: () => [],
      subscribeNavigate: () => () => {},
      subscribeAgents: () => () => {},
      mountHeaderAction: mount,
      prefs: () => prefs,
      savePrefs: (p) => { prefs = p },
      changed: () => {},
      timeoutMs: 100,
    })

    await host.init()
    await vi.waitFor(() => expect(host.rows().find(r => r.id === 'asyncBad')?.status).toBe('failed'))
    expect(host.rows().find(r => r.id === 'syncBad')?.status).toBe('failed')
    expect(host.rows().find(r => r.id === 'good')?.status).toBe('running')
    expect(document.querySelectorAll('[data-wherdr="header-actions"] .good-btn')).toHaveLength(1)
    expect(document.querySelectorAll('[data-wherdr="header-actions"] > .header-action')).toHaveLength(1)
    await host.setCommunity(false)
  })
})
