import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h } from 'vue'
import AgentView from '~/components/AgentView.vue'
import { desk, eventsOpen, herdrState, setPaneViewMode } from '~/composables/useHerdr'
import type { Pane, Workspace } from '#shared/types'

// The message field under a terminal: tapping it or pressing a key in it must
// not take the terminal's size while the terminal is what is shown — the pane
// belongs to whoever reads it at its own size until the user types in the
// terminal itself (see takeTerminalControl in AgentView).
const hoisted = vi.hoisted(() => ({ takeControl: vi.fn() }))
vi.mock('~/composables/useTerminal', async () => {
  const { ref } = await import('vue')
  const ctl = () => ({
    loading: ref(false), kbdOn: ref(false),
    mount: vi.fn(async () => true), connect: vi.fn(), disconnect: vi.fn(), dispose: vi.fn(),
    takeControl: hoisted.takeControl, isConnected: () => true, sendTerm: vi.fn(() => true), sendKeys: vi.fn(),
    fitNow: vi.fn(), setFontSize: vi.fn(), reset: vi.fn(), scroll: vi.fn(() => true),
    focus: vi.fn(), blur: vi.fn(), tapLink: vi.fn(() => false), tapMouse: vi.fn(),
    hasFocus: () => false, isParked: () => false, rebind: vi.fn(), rowHeight: () => 16, pageRows: () => 24, setVisible: vi.fn(),
    hasBanner: () => false, selectionHint: { visible: ref(false), dismiss: vi.fn() },
    cancelTouchScroll: vi.fn(), scrollInputVersion: ref(0), frameTick: ref(0), scrollAck: ref(0),
    virtualModifiers: ref([]), lastVirtualChord: ref(''), toggleModifier: vi.fn(),
    toggleVirtualModifier: vi.fn(), clearVirtualModifiers: vi.fn(), sendVirtualKey: vi.fn(),
  })
  return { createTerminal: () => ctl() }
})

// A native pointerdown/keydown lands on the Composer's root element, where
// AgentView's own listeners sit (it binds them on the component itself).
const ComposerStub = defineComponent({
  name: 'Composer',
  inheritAttrs: true,
  props: ['pane', 'paneId', 'sendKeys', 'conversation', 'termShown', 'escStops', 'takeBack', 'unanswered'],
  setup: (_props, { attrs }) => () => h('div', { ...attrs, class: 'composer-stub' }, 'composer'),
})
const TerminalViewStub = defineComponent({ name: 'TerminalView', props: ['ctl'], template: '<div class="tv-stub" />' })
const KeybarStub = defineComponent({ name: 'Keybar', props: ['ctl', 'compact', 'terminal'], template: '<div class="keybar-stub" />' })
const passthrough = (name: string) => defineComponent({ name, template: '<div><slot /></div>' })

const rect = { x: 0, y: 0, width: 100, height: 40 }
const pane: Pane = {
  id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null,
  agent: 'codex', name: 'review-agent', label: null, status: 'idle',
  title: 'review-agent', cwd: '/home/user', agentSession: null,
}
const stubs = {
  SpaceTabs: true, PhoneIdentity: true, ViewToggle: true, UButton: true, UIcon: true,
  StatusPill: true, TabMap: true, GridBackdrop: true, CoordinatorButton: true, ChatView: true,
  InteractiveTerminal: true, ChoicesPanel: true, FilesView: true, MachineLocalBadge: true,
  AlfredEmblem: true, ProjectBadge: true, OmpContext: true, UiOpenCard: true, UiShowCard: true,
  UModal: true,
  HeaderMenu: passthrough('HeaderMenu'), UTooltip: passthrough('UTooltip'),
  UDropdownMenu: passthrough('UDropdownMenu'), AppSheet: passthrough('AppSheet'),
  TerminalView: TerminalViewStub, Keybar: KeybarStub, Composer: ComposerStub,
}

let unmount: (() => void) | undefined
beforeEach(() => {
  desk.value = false
  eventsOpen.value = true
  herdrState.value = {
    ok: true,
    workspaces: [{ id: 'w1', name: 'acme-shop', cwd: '/home/user' } as Workspace],
    panes: [pane],
    tabs: [{
      id: 'w1:t1', workspace: 'w1', label: 'one', number: 1,
      layout: { tab: 'w1:t1', workspace: 'w1', zoomed: false, focused: null, area: rect, panes: [{ pane: 'w1:p1', rect }] },
    }],
  }
})
afterEach(() => {
  unmount?.()
  unmount = undefined
  hoisted.takeControl.mockClear()
  herdrState.value = { ok: false, workspaces: [], panes: [] }
  eventsOpen.value = false
})

async function mounted(mode: 'chat' | 'term') {
  setPaneViewMode('w1:p1', mode)
  const w = await mountSuspended(AgentView, { props: { paneId: 'w1:p1' }, global: { stubs } })
  unmount = () => w.unmount()
  return w
}

describe('the message field under a terminal', () => {
  it('never takes the terminal size in terminal mode, on a tap or a key', async () => {
    const w = await mounted('term')
    const field = w.findComponent(ComposerStub)
    expect(field.exists()).toBe(true)
    field.vm.$el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(hoisted.takeControl).not.toHaveBeenCalled()
    field.vm.$el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(hoisted.takeControl).not.toHaveBeenCalled()
  })

  it('still takes it from the conversation, where the field is what the user types in', async () => {
    const w = await mounted('chat')
    const field = w.findComponent(ComposerStub)
    expect(field.exists()).toBe(true)
    field.vm.$el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(hoisted.takeControl).toHaveBeenCalledTimes(1)
    field.vm.$el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(hoisted.takeControl).toHaveBeenCalledTimes(2)
  })
})
