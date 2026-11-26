import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, ref } from 'vue'
import SessionSwitcher from '~/components/SessionSwitcher.vue'
import { allSessionsState, pickSessionTab } from '~/composables/useHerdr'
import type { HerdrState, Pane } from '#shared/types'

type Item = {
  label?: string
  type?: string
  slot?: string
  checked?: boolean
  sessionKey?: string
  status?: string
  terminals?: number
  waiting?: number
  to?: string
  onSelect?: (e?: Event) => void
}

// The menu's rows render inline once its trigger is pressed. Scoped slots keep
// the same status, count and checkmark content the real dropdown receives.
const Dropdown = defineComponent({
  props: { items: { type: Array, default: () => [] } },
  setup: (props, { slots }) => {
    const open = ref(false)
    const scoped = (name: string, item: Item, index: number) =>
      (slots as Record<string, ((props: object) => unknown) | undefined>)[name]?.({ item, active: false, index, ui: {} })
    const row = (item: Item, index: number) => {
      if (item.type === 'separator') return h('div', { class: 'dd-separator' })
      const custom = item.slot ? scoped(item.slot, item, index) : undefined
      return h('button', {
        class: ['dd-item', { on: item.checked }],
        'data-key': item.sessionKey,
        'data-to': item.to,
        onClick: () => { item.onSelect?.(); open.value = false },
      }, custom ?? [
        scoped('item-leading', item, index),
        scoped('item-label', item, index) ?? item.label,
        scoped('item-trailing', item, index),
        item.checked ? '✓' : '',
      ])
    }
    return () => h('div', {
      class: 'dd',
      onClick: (event: Event) => {
        if ((event.target as HTMLElement).closest('.dd-item')) return
        open.value = !open.value
      },
    }, [slots.default?.({ open: open.value }),
      ...(open.value ? (props.items as Item[][]).flat().map(row) : [])])
  },
})

const pane = (id: string, session: string, status: Pane['status']): Pane => ({
  id, workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null,
  status, title: 'Agent', cwd: '/tmp/demo', agentSession: null, interaction: null, session,
})

const state = (): HerdrState => ({
  ok: true,
  ready: true,
  workspaces: [{ id: 'w1', label: 'Project', order: 0, tabs: ['w1:t1'], active: 'w1:t1' }],
  tabs: [{ id: 'w1:t1', label: 'Tab', order: 0, panes: ['w1:p1', 'w1:p2', 'w1:p3', 'w1:p4'] }],
  panes: [
    pane('w1:p1', 'default', 'idle'),
    pane('w1:p2', 'alpha', 'blocked'),
    pane('w1:p3', 'backlot', 'blocked'),
    pane('w1:p4', 'backlot', 'done'),
  ],
  sessions: [
    { key: '', name: 'default', primary: true, status: 'online' },
    { key: 'saaaaaaaaaaaaaaaa', name: 'alpha', primary: false, status: 'connecting' },
    { key: 'sbbbbbbbbbbbbbbbb', name: 'backlot', primary: false, status: 'online' },
    { key: 'scccccccccccccccc', name: 'empty', primary: false, status: 'offline' },
  ],
})

const mountSwitcher = () => mountSuspended(SessionSwitcher, {
  global: { stubs: { UDropdownMenu: Dropdown } },
})

afterEach(() => {
  allSessionsState.value = { ok: false, ready: false, workspaces: [], panes: [] }
  pickSessionTab('')
  localStorage.removeItem('sessionTab')
})

describe('SessionSwitcher', () => {
  it('is absent while only one session has terminals', async () => {
    allSessionsState.value = { ok: true, ready: true, workspaces: [], panes: [], sessions: [{ key: '', name: 'default', primary: true, status: 'online' }] }
    const wrapper = await mountSwitcher()
    expect(wrapper.find('.session-switch').exists()).toBe(false)
  })

  it('shows the current session and the count waiting in the other sessions', async () => {
    allSessionsState.value = state()
    const wrapper = await mountSwitcher()
    expect(wrapper.find('.session-switch-name').text()).toBe('default')
    expect(wrapper.find('.session-switch-waiting').text()).toBe('3')
  })

  it('lists primary first then alphabetical, marks the current session and hides empty ones', async () => {
    allSessionsState.value = state()
    const wrapper = await mountSwitcher()
    await wrapper.find('.session-switch').trigger('click')
    const rows = wrapper.findAll('.dd-item[data-key]')
    expect(rows.map(row => row.attributes('data-key'))).toEqual(['', 'saaaaaaaaaaaaaaaa', 'sbbbbbbbbbbbbbbbb'])
    expect(rows[0]!.classes()).toContain('on')
    expect(rows[0]!.text()).toContain('✓')
    expect(rows[0]!.text()).toContain('1')
    expect(rows[1]!.find('.session-menu-state.connecting').exists()).toBe(true)
    expect(rows[1]!.find('.session-menu-waiting').text()).toBe('1')
    expect(rows[2]!.find('.session-menu-count').text()).toBe('2')
    expect(rows[2]!.find('.session-menu-waiting').text()).toBe('2')
    const footer = wrapper.find('.dd-item:not([data-key])')
    expect(footer.attributes('data-to')).toBe('/settings?section=about')
    expect(footer.text()).toContain('wherdr')
    expect(footer.text()).toContain('About')
  })

  it('choosing a session switches and remembers it on this device', async () => {
    allSessionsState.value = state()
    const wrapper = await mountSwitcher()
    await wrapper.find('.session-switch').trigger('click')
    await wrapper.find('[data-key="sbbbbbbbbbbbbbbbb"]').trigger('click')
    expect(localStorage.getItem('sessionTab')).toBe('sbbbbbbbbbbbbbbbb')
    expect(wrapper.find('.session-switch-name').text()).toBe('backlot')
    await wrapper.find('.session-switch').trigger('click')
    expect(wrapper.find('[data-key="sbbbbbbbbbbbbbbbb"]').classes()).toContain('on')
  })
})
