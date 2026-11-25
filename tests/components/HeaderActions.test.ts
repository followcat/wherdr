import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import HomeView from '~/components/HomeView.vue'
import AgentView from '~/components/AgentView.vue'
import { curPane, desk, herdrState } from '~/composables/useHerdr'
import { homeListReady } from '~/composables/useHomeLoad'
import { useDraft } from '~/composables/useDraft'
import { createAppPluginDeps } from '~/composables/useClientPlugins'
import { createPluginHost, type WherdrApi } from '~/utils/pluginHost'
import type { Pane } from '#shared/types'

const pane: Pane = { id: 'w1:p7', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '/home/user/demo', agentSession: null }
const sentPrompts: unknown[] = []
registerEndpoint('/api/chat', () => ({ available: true, token: 't', file: '/home/user/demo/t.jsonl', start: 0, items: [] }))
registerEndpoint('/api/prompt', { method: 'POST', handler: (e) => { sentPrompts.push(e); return { ok: true } } })
registerEndpoint('/api/client-plugins', () => ({ plugins: [], enabled: false }))

const pass = { template: '<div><slot /></div>' }

describe('header-actions marker and draft host wiring', () => {
  beforeEach(() => {
    homeListReady.value = true
    herdrState.value = { ok: true, workspaces: [{ id: 'w1', number: 1, label: 'Demo', focused: false }], panes: [pane] } as never
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    curPane.value = null
    desk.value = false
    herdrState.value = { ok: false, workspaces: [], panes: [] }
    useDraft(pane.id).text = ''
  })

  it('places an empty header-actions marker before existing buttons in HomeView and AgentView', async () => {
    const hw = await mountSuspended(HomeView, { global: { stubs: { UContextMenu: pass, UTooltip: pass } } })
    const aw = await mountSuspended(defineComponent({ render: () => h(AgentView, { paneId: pane.id }) }), { route: `/a/${pane.id}`, global: { stubs: { UTooltip: pass } } })
    try {
      const homeSlot = hw.find('.home-actions > [data-wherdr="header-actions"]')
      expect(homeSlot.exists()).toBe(true)
      expect(homeSlot.element.children).toHaveLength(0)
      expect(hw.find('.home-actions').element.firstElementChild).toBe(homeSlot.element)

      const agentSlot = aw.find('.agent-actions > [data-wherdr="header-actions"]')
      expect(agentSlot.exists()).toBe(true)
      expect(agentSlot.element.children).toHaveLength(0)
      expect(aw.find('.agent-actions').element.firstElementChild).toBe(agentSlot.element)
    } finally {
      hw.unmount()
      aw.unmount()
    }
  })

  it('HomeView folds header buttons when header-actions holds a wide widget', async () => {
    const callbacks = new Map<Element, ResizeObserverCallback>()
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) { callbacks.set(el, this.cb) }
      unobserve(el: Element) { callbacks.delete(el) }
      disconnect() {}
    })

    const hw = await mountSuspended(HomeView, { global: { stubs: { UContextMenu: pass, UTooltip: pass } } })
    try {
      const row = hw.find('.home-title-row').element
      const slot = hw.find('[data-wherdr="header-actions"]').element
      callbacks.get(row)?.([{ target: row, contentRect: { width: 358 } }] as never, {} as never)
      await nextTick()
      expect(hw.find('.home-actions .space-menu').exists()).toBe(false)

      const pill = document.createElement('button')
      pill.textContent = 'Status'
      slot.append(pill)
      callbacks.get(slot)?.([{ target: slot, contentRect: { width: 130 } }] as never, {} as never)
      await nextTick()
      expect(hw.find('.home-actions .space-menu').exists()).toBe(true)
    } finally {
      hw.unmount()
    }
  })

  it('AgentView header folds Notes into Options when header-actions takes space', async () => {
    const callbacks = new Map<Element, ResizeObserverCallback>()
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) { callbacks.set(el, this.cb) }
      unobserve(el: Element) { callbacks.delete(el) }
      disconnect() {}
    })
    desk.value = true
    const aw = await mountSuspended(AgentView, { props: { paneId: pane.id }, route: `/a/${pane.id}`, global: { stubs: { UTooltip: pass } } })
    try {
      const header = aw.find('.agent-top').element
      const slot = aw.find('[data-wherdr="header-actions"]').element
      callbacks.get(header)?.([{ target: header, contentRect: { width: 600 } }] as never, {} as never)
      await nextTick()
      expect(aw.find('[data-testid="agent-notes"]').exists()).toBe(true)

      const pill = document.createElement('button')
      pill.textContent = 'Widget'
      slot.append(pill)
      callbacks.get(slot)?.([{ target: slot, contentRect: { width: 80 } }] as never, {} as never)
      await nextTick()
      expect(aw.find('[data-testid="agent-notes"]').exists()).toBe(false)
    } finally {
      aw.unmount()
    }
  })

  it('mounts into header-actions and draft.get/set/focus update and focus the open composer without sending', async () => {
    sentPrompts.length = 0
    let api!: WherdrApi
    let prefs = { off: [] as string[], failed: {} as Record<string, string> }
    const host = createPluginHost(createAppPluginDeps(() => {}, {
      list: async () => ({ plugins: [{ id: 'demo', name: 'Demo', version: '1', description: '', main: 'index.js' }], enabled: true }),
      load: async () => ({
        default: (w: WherdrApi) => {
          api = w
          w.mountHeaderAction((el) => {
            const btn = document.createElement('button')
            btn.className = 'demo-header-btn'
            btn.textContent = 'Template'
            btn.addEventListener('click', () => {
              w.draft.set('Check the build logs.')
              w.draft.focus()
            })
            el.append(btn)
          })
        },
      }),
      prefs: () => prefs,
      savePrefs: (p) => { prefs = p },
    }))
    await host.init()

    // No conversation open: draft.get is null, set/focus are no-ops.
    curPane.value = null
    expect(api.draft.get()).toBeNull()
    api.draft.set('ignored')
    api.draft.focus()

    const aw = await mountSuspended(AgentView, { props: { paneId: pane.id }, route: `/a/${pane.id}`, attachTo: document.body, global: { stubs: { UTooltip: pass } } })
    try {
      await nextTick()
      const btn = aw.find<HTMLButtonElement>('[data-wherdr="header-actions"] .demo-header-btn')
      expect(btn.exists()).toBe(true)
      const ta = aw.find<HTMLTextAreaElement>('.composer textarea').element
      expect(document.activeElement).not.toBe(ta)
      expect(api.draft.get()).toBe('')

      await btn.trigger('click')
      await nextTick()
      expect(api.draft.get()).toBe('Check the build logs.')
      expect(ta.value).toBe('Check the build logs.')
      expect(document.activeElement).toBe(ta)
      expect(sentPrompts).toHaveLength(0)

      await host.setEnabled('demo', false)
      expect(aw.find('[data-wherdr="header-actions"] .demo-header-btn').exists()).toBe(false)
    } finally {
      await host.setCommunity(false)
      aw.unmount()
    }
  })
})
