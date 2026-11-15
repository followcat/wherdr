// The home list's header on a narrow list (WHR-332): Search folds into the
// "…" menu first, Settings always stays a button.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import HomeView from '~/components/HomeView.vue'
import SpaceMenu from '~/components/SpaceMenu.vue'
import type { MenuItem } from '~/composables/useUi'

registerEndpoint('/api/pm/overview', () => ({ enabled: false, projects: [], templates: [] }))
const pass = { template: '<div><slot /></div>' }

async function mountAt(width: number) {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: ResizeObserverCallback) {}
    observe() { this.cb([{ contentRect: { width } }] as never, this as never) }
    disconnect() {}
  })
  const w = await mountSuspended(HomeView, { global: { stubs: { UContextMenu: pass, UTooltip: pass } } })
  await nextTick()
  return w
}

describe('home header fold', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('narrow: Settings stays a button, Search moves into the … menu', async () => {
    const w = await mountAt(200)
    expect(w.find('[aria-label="Settings"]').exists()).toBe(true)
    expect(w.find('[aria-label="Search agents and conversations"]').exists()).toBe(false)
    const items = (w.getComponent(SpaceMenu).props('items') as () => MenuItem[])()
    expect(items.map(i => i.label)).toContain('Search')
    expect(items.map(i => i.label)).not.toContain('Settings')
    // WHR-345: Notes moved to the conversation header.
    expect(items.map(i => i.label)).not.toContain('Notes')
    w.unmount()
  })

  it('wide: Search and Settings are buttons, no … menu', async () => {
    const w = await mountAt(600)
    expect(w.find('[aria-label="Settings"]').exists()).toBe(true)
    expect(w.find('[aria-label="Search agents and conversations"]').exists()).toBe(true)
    expect(w.findComponent(SpaceMenu).exists()).toBe(false)
    expect(w.find('[aria-label="Notes"]').exists()).toBe(false)
    w.unmount()
  })
})
