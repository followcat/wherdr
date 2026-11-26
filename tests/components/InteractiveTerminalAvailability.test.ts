import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, nextTick } from 'vue'
import AgentView from '~/components/AgentView.vue'
import { desk, eventsOpen, herdrState, setPaneViewMode } from '~/composables/useHerdr'
import type { Pane, Workspace } from '#shared/types'

vi.mock('~/composables/useTerminal', async () => {
  const { ref } = await import('vue')
  const ctl = () => ({
    loading: ref(false), loadingEarlier: ref(false), kbdOn: ref(false), park: vi.fn(), isParked: () => false,
    mount: vi.fn(async () => true), connect: vi.fn(), disconnect: vi.fn(), dispose: vi.fn(),
    takeControl: vi.fn(), isConnected: () => true, sendTerm: vi.fn(() => true), sendKeys: vi.fn(),
    fitNow: vi.fn(), setFontSize: vi.fn(), reset: vi.fn(), scroll: vi.fn(() => true),
    focus: vi.fn(), blur: vi.fn(), tapLink: vi.fn(() => false), tapMouse: vi.fn(), tapOnCursor: vi.fn(() => false),
    hasFocus: () => false, imeBusy: () => false, rowHeight: () => 16, pageRows: () => 24, setVisible: vi.fn(),
    captureScreen: vi.fn(() => null), hasBanner: () => false, selectionHint: { visible: ref(false), dismiss: vi.fn() },
    scrollInputVersion: ref(0), scrollGeometryVersion: ref(0), frameTick: ref(0), scrollAck: ref(0),
    virtualModifiers: ref([]), lastVirtualChord: ref(''), toggleModifier: vi.fn(),
    toggleVirtualModifier: vi.fn(), clearVirtualModifiers: vi.fn(), sendVirtualKey: vi.fn(),
  })
  return { createTerminal: () => ctl() }
})

const InteractiveTerminalStub = defineComponent({ name: 'InteractiveTerminal', props: ['paneId', 'active', 'title'], template: '<div class="interactive-stub" />' })
const TerminalViewStub = defineComponent({ name: 'TerminalView', props: ['ctl'], template: '<div class="tv-stub" />' })
const KeybarStub = defineComponent({ name: 'Keybar', props: ['ctl', 'compact', 'terminal'], template: '<div class="keybar-stub" />' })
const ComposerStub = defineComponent({ name: 'Composer', props: ['pane', 'paneId'], template: '<div class="composer-stub" />' })
const passthrough = (name: string) => defineComponent({ name, template: '<div><slot /></div>' })

const pane: Pane = {
  id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null,
  agent: 'devin', name: 'devin-agent', label: null, status: 'blocked',
  interaction: 'terminal', title: 'devin-agent', cwd: '/home/alice/acme-shop', agentSession: null,
}
const stubs = {
  SpaceTabs: true, PhoneIdentity: true, ViewToggle: true, UButton: true, UIcon: true,
  StatusPill: true, TabMap: true, GridBackdrop: true, CoordinatorButton: true, ChatView: true,
  ChoicesPanel: true, FilesView: true, MachineLocalBadge: true,
  AlfredEmblem: true, ProjectBadge: true, OmpContext: true, UiOpenCard: true, UiShowCard: true,
  UModal: true,
  HeaderMenu: passthrough('HeaderMenu'), UTooltip: passthrough('UTooltip'),
  UDropdownMenu: passthrough('UDropdownMenu'), AppSheet: passthrough('AppSheet'),
  InteractiveTerminal: InteractiveTerminalStub, TerminalView: TerminalViewStub, Keybar: KeybarStub, Composer: ComposerStub,
}

let unmount: (() => void) | undefined
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  desk.value = false
  eventsOpen.value = true
  herdrState.value = {
    ok: true,
    machines: [{ key: '', label: 'host-a', local: true, status: 'online', error: null }],
    workspaces: [{ id: 'w1', name: 'acme-shop', cwd: '/home/alice/acme-shop' } as Workspace],
    panes: [{ ...pane }],
    tabs: [{ id: 'w1:t1', workspace: 'w1', label: 'one', number: 1, layout: null }],
  }
})
afterEach(() => {
  unmount?.()
  unmount = undefined
  vi.useRealTimers()
  herdrState.value = { ok: false, workspaces: [], panes: [] }
  eventsOpen.value = false
})

async function openOverlay() {
  setPaneViewMode('w1:p1', 'chat')
  const w = await mountSuspended(AgentView, { props: { paneId: 'w1:p1' }, global: { stubs } })
  unmount = () => w.unmount()
  await vi.advanceTimersByTimeAsync(500)
  await nextTick()
  expect(w.find('.interactive-stub').exists()).toBe(true)
  return w
}

describe('InteractiveTerminal overlay availability', () => {
  it('stays open on a brief unknown blip and closes at once when the pane goes away or stale', async () => {
    const w = await openOverlay()

    // A brief 'unknown' blip (< 900 ms) keeps the overlay mounted.
    herdrState.value = { ...herdrState.value, panes: [{ ...pane, interaction: 'unknown' }] }
    await vi.advanceTimersByTimeAsync(300)
    await nextTick()
    expect(w.find('.interactive-stub').exists()).toBe(true)
    herdrState.value = { ...herdrState.value, panes: [{ ...pane, interaction: 'terminal' }] }
    await nextTick()
    expect(w.find('.interactive-stub').exists()).toBe(true)

    // Going stale closes the overlay at once via interactionAvailable / paneStale.
    herdrState.value = {
      ...herdrState.value,
      machines: [{ key: '', label: 'host-a', local: true, status: 'offline', error: 'down' }],
      panes: [{ ...pane, interaction: 'unknown' }],
    }
    await nextTick()
    expect(w.find('.interactive-stub').exists()).toBe(false)

    // Recovering online lets a steady terminal stay open; removing the pane closes it at once.
    herdrState.value = {
      ...herdrState.value,
      machines: [{ key: '', label: 'host-a', local: true, status: 'online', error: null }],
      panes: [{ ...pane, interaction: 'terminal' }],
    }
    await vi.advanceTimersByTimeAsync(500)
    await nextTick()
    expect(w.find('.interactive-stub').exists()).toBe(true)

    herdrState.value = { ...herdrState.value, panes: [] }
    await nextTick()
    expect(w.find('.interactive-stub').exists()).toBe(false)
  })
})
