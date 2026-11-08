import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { nextTick, type ComponentPublicInstance } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import type { Pane } from '#shared/types'

registerEndpoint('/api/quotas', () => ({ claude: null, codex: null }))
const pane: Pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: 'Sample agent', cwd: '/tmp/demo', agentSession: null }
const pass = { template: '<div><slot /></div>' }

async function freshApp() {
  vi.resetModules()
  const state = await import('~/composables/useHerdr')
  state.herdrState.value = { ok: true, panes: [pane], workspaces: [{ id: 'w1', number: 1, label: 'Sample', status: null, worktree: false }] }
  state.eventsOpen.value = true
  const Home = (await import('~/components/HomeView.vue')).default
  const Settings = (await import('~/components/SettingsView.vue')).default
  return { state, Home, Settings }
}

// Observe the list's density at mount and on every update: a compact list
// shown for an instant before the normal one would be caught here.
async function mountHome(Home: Awaited<ReturnType<typeof freshApp>>['Home']) {
  const seen: boolean[] = []
  function record(this: ComponentPublicInstance) {
    if (this.$el instanceof Element && this.$el.matches('#home')) seen.push(this.$el.classList.contains('list-compact'))
  }
  const w = await mountSuspended(Home, { global: {
    stubs: { UContextMenu: pass, UTooltip: pass },
    mixins: [{ mounted: record, updated: record }],
  } })
  try {
    expect(w.findAll('.card').length).toBeGreaterThan(0)
    expect(seen.length).toBeGreaterThan(0)
    return { w, seen }
  } catch (error) {
    w.unmount()
    throw error
  }
}
const compactToggle = (settings: VueWrapper) =>
  settings.findAll('.settings-toggle').find(w => w.text().includes('Compact list'))!.find('[role="switch"]')
afterEach(() => { localStorage.removeItem('compactList'); localStorage.removeItem('compactListV2') })

// A 1.x compact list (key `compactList`) goes back to normal: the list is
// normal from its first card, the old value is removed and nothing is saved.
it('the list is normal from its first card, and a 1.x compact value is removed', async () => {
  localStorage.setItem('compactList', '1')
  const { state, Home } = await freshApp()
  const { w, seen } = await mountHome(Home)
  try {
    expect(seen.every(c => !c)).toBe(true)
    expect(w.classes()).not.toContain('list-compact')
    expect(localStorage.getItem('compactList')).toBeNull()
    expect(localStorage.getItem('compactListV2')).toBeNull()
  } finally { w.unmount(); state.eventsOpen.value = false }
})

it('turning Compact list on persists across a fresh app and settings mount', async () => {
  const first = await freshApp()
  first.state.desk.value = true
  const settings = await mountSuspended(first.Settings, { route: '/settings?section=appearance' })
  const toggle = compactToggle(settings)
  try {
    expect(toggle.attributes('aria-checked')).toBe('false')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-checked')).toBe('true')
    await nextTick()
    expect(localStorage.getItem('compactListV2')).toBe('1')
  } finally { settings.unmount(); first.state.eventsOpen.value = false }
  const second = await freshApp()
  const { w: home, seen } = await mountHome(second.Home)
  try {
    expect(seen.every(Boolean)).toBe(true)
    expect(home.classes()).toContain('list-compact')
  } finally { home.unmount(); second.state.eventsOpen.value = false }
  second.state.desk.value = true
  const restored = await mountSuspended(second.Settings, { route: '/settings?section=appearance' })
  try {
    expect(compactToggle(restored).attributes('aria-checked')).toBe('true')
  } finally { restored.unmount() }
})
