// The home list's header on a narrow list (WHR-332): Search folds into the
// "…" menu first, Settings always stays a button. A session switcher in the
// eyebrow follows the same fold: its name truncates before pushing actions away.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import HomeView from '~/components/HomeView.vue'
import SpaceMenu from '~/components/SpaceMenu.vue'
import { allSessionsState, pickSessionTab } from '~/composables/useHerdr'
import type { MenuItem } from '~/composables/useUi'
import type { HerdrState, Pane } from '#shared/types'

registerEndpoint('/api/pm/overview', () => ({ enabled: false, projects: [], templates: [] }))
const pass = { template: '<div><slot /></div>' }
const Dropdown = { template: '<div class="dd"><slot /></div>' }

const pane = (id: string, session: string, status: Pane['status'] = 'idle'): Pane => ({
  id, workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null,
  status, title: 'Agent', cwd: '/tmp/demo', agentSession: null, interaction: null, session,
})

const sessions = (name = 'studio'): HerdrState => ({
  ok: true,
  ready: true,
  workspaces: [{ id: 'w1', label: 'Project', order: 0, tabs: ['w1:t1'], active: 'w1:t1' }],
  tabs: [{ id: 'w1:t1', label: 'Tab', order: 0, panes: ['w1:p1', 'w1:p2'] }],
  panes: [pane('w1:p1', 'default'), pane('w1:p2', name, 'blocked')],
  sessions: [
    { key: '', name: 'default', primary: true, status: 'online' },
    { key: 'saaaaaaaaaaaaaaaa', name, primary: false, status: 'online' },
  ],
})

async function mountAt(width: number) {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: ResizeObserverCallback) {}
    observe() { this.cb([{ contentRect: { width } }] as never, this as never) }
    disconnect() {}
  })
  const w = await mountSuspended(HomeView, { global: { stubs: { UContextMenu: pass, UTooltip: pass, UDropdownMenu: Dropdown } } })
  await nextTick()
  return w
}

describe('home header fold', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    allSessionsState.value = { ok: false, ready: false, workspaces: [], panes: [] }
    pickSessionTab('')
    localStorage.removeItem('sessionTab')
  })

  it('narrow: Settings stays a button, Search moves into the … menu', async () => {
    const w = await mountAt(200)
    expect(w.find('[aria-label="Settings"]').exists()).toBe(true)
    expect(w.find('[aria-label="Search conversations, tasks, settings and actions"]').exists()).toBe(false)
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
    expect(w.find('[aria-label="Search conversations, tasks, settings and actions"]').exists()).toBe(true)
    expect(w.findComponent(SpaceMenu).exists()).toBe(false)
    expect(w.find('[aria-label="Notes"]').exists()).toBe(false)
    w.unmount()
  })

  it('puts the session switcher in the eyebrow and leaves no pill row', async () => {
    allSessionsState.value = sessions()
    const w = await mountAt(328)
    expect(w.find('.session-switch').exists()).toBe(true)
    expect(w.find('.home-version').exists()).toBe(false)
    expect(w.find('[data-testid="session-tabs"]').exists()).toBe(false)
    w.unmount()
  })

  it('folds the header actions before a long session name pushes them away', async () => {
    const name = 'averylongstudioseasonnamefortheheader'
    allSessionsState.value = sessions(name)
    pickSessionTab('saaaaaaaaaaaaaaaa')
    const w = await mountAt(328)
    expect(w.find('.session-switch-name').text()).toBe(name)
    expect(w.find('[aria-label="Search conversations, tasks, settings and actions"]').exists()).toBe(false)
    expect(w.find('[data-testid="home-board"]').exists()).toBe(false)
    expect(w.findComponent(SpaceMenu).exists()).toBe(true)
    expect(w.find('[aria-label="Settings"]').exists()).toBe(true)
    w.unmount()
  })
})
