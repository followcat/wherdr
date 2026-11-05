import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, nextTick, ref } from 'vue'
import AgentView from '~/components/AgentView.vue'
import InteractiveTerminal from '~/components/InteractiveTerminal.vue'
import { eventsOpen, herdrState } from '~/composables/useHerdr'
import type { Pane, Workspace } from '#shared/types'

// Each owner of a terminal tracks the copy surface's state: its input gate
// closes while copying (data, keys, paste, mouse), and the surrounding
// controls — key bar, composer, pane swipes — become inert.
const hoisted = vi.hoisted(() => ({
  opts: null as null | { input?: () => boolean, setBanner?: unknown, hasBanner?: unknown },
}))
vi.mock('~/composables/useTerminal', async () => {
  const { ref } = await import('vue')
  const ctl = () => ({
    loading: ref(false), kbdOn: ref(false),
    mount: vi.fn(async () => true), connect: vi.fn(), disconnect: vi.fn(), dispose: vi.fn(),
    takeControl: vi.fn(), isConnected: () => true, sendTerm: vi.fn(() => true), sendKeys: vi.fn(),
    fitNow: vi.fn(), setFontSize: vi.fn(), reset: vi.fn(), scroll: vi.fn(() => true),
    focus: vi.fn(), blur: vi.fn(), tapLink: vi.fn(() => false), tapMouse: vi.fn(),
    hasFocus: () => false, rowHeight: () => 16, pageRows: () => 24, setVisible: vi.fn(),
    captureScreen: vi.fn(() => null),
    hasBanner: () => false, selectionHint: { visible: ref(false), dismiss: vi.fn() },
    cancelTouchScroll: vi.fn(), scrollInputVersion: ref(0), frameTick: ref(0), scrollAck: ref(0),
    virtualModifiers: ref([]), lastVirtualChord: ref(''), toggleModifier: vi.fn(),
    toggleVirtualModifier: vi.fn(), clearVirtualModifiers: vi.fn(), sendVirtualKey: vi.fn(),
  })
  return {
    createTerminal: (_id: string, opts: { input?: () => boolean }) => {
      hoisted.opts = opts
      return ctl()
    },
  }
})

const TerminalViewStub = defineComponent({
  name: 'TerminalView',
  props: ['ctl'],
  emits: ['copying'],
  template: '<div id="termWrap" class="tv-stub" />',
})
const KeybarStub = defineComponent({ name: 'Keybar', props: ['ctl', 'terminal', 'allDigits', 'compact', 'id'], template: '<div class="keybar-stub" />' })
const ComposerStub = defineComponent({ name: 'Composer', props: ['escStops'], template: '<div class="composer-stub" />' })
const UModalStub = defineComponent({ name: 'UModal', template: '<div><slot name="content" /></div>' })
const passthrough = (name: string) => defineComponent({ name, template: '<div><slot /></div>' })

beforeAll(async () => {
  const app = await mountSuspended({ template: '<div />' })
  app.unmount()
}, 60_000)

let unmount: (() => void) | undefined
afterEach(() => {
  unmount?.()
  unmount = undefined
  hoisted.opts = null
  eventsOpen.value = false
  herdrState.value = { ok: false, workspaces: [], panes: [] }
  vi.restoreAllMocks()
})

describe('InteractiveTerminal owns its copy state', () => {
  it('gates the terminal input and turns the key bar inert while copying', async () => {
    const w = await mountSuspended(InteractiveTerminal, {
      props: { paneId: 'w1:p1', active: true, title: 'agent' },
      global: { stubs: { TerminalView: TerminalViewStub, Keybar: KeybarStub, UModal: UModalStub, UButton: true, UIcon: true } },
    })
    unmount = () => w.unmount()
    expect(hoisted.opts?.input?.()).toBe(true)
    const tv = w.findComponent(TerminalViewStub)
    tv.vm.$emit('copying', true)
    await nextTick()
    expect(hoisted.opts?.input?.()).toBe(false)
    expect(w.get('.keybar-stub').attributes('inert')).toBeDefined()
    tv.vm.$emit('copying', false)
    await nextTick()
    expect(hoisted.opts?.input?.()).toBe(true)
    expect(w.get('.keybar-stub').attributes('inert')).toBeUndefined()
  })
})

describe('AgentView owns its copy state', () => {
  const rect = { x: 0, y: 0, width: 100, height: 40 }
  const pane: Pane = {
    id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null,
    agent: null, name: 'shell-a', label: null, status: 'working',
    title: 'shell-a', cwd: '/home/user', agentSession: null,
  }
  const stubs = {
    SpaceTabs: true, PhoneIdentity: true, ViewToggle: true, UButton: true, UIcon: true,
    StatusPill: true, TabMap: true, GridBackdrop: true, CoordinatorBar: true, ChatView: true,
    InteractiveTerminal: true, ChoicesPanel: true, FilesView: true, MachineLocalBadge: true,
    UModal: true,
    HeaderMenu: passthrough('HeaderMenu'), UTooltip: passthrough('UTooltip'),
    UDropdownMenu: passthrough('UDropdownMenu'), AppSheet: passthrough('AppSheet'),
    TerminalView: TerminalViewStub, Keybar: KeybarStub, Composer: ComposerStub,
  }

  async function mounted() {
    eventsOpen.value = true
    herdrState.value = {
      ok: true,
      workspaces: [{ id: 'w1', name: 'acme-shop', cwd: '/home/user' } as Workspace],
      panes: [pane, { ...pane, id: 'w1:p2' }],
      tabs: [{
        id: 'w1:t1', workspace: 'w1', label: 'one', number: 1,
        layout: {
          tab: 'w1:t1', workspace: 'w1', zoomed: false, focused: null,
          area: rect,
          panes: [{ pane: 'w1:p1', rect }, { pane: 'w1:p2', rect: { ...rect, x: 100 } }],
        },
      }],
    }
    const w = await mountSuspended(AgentView, {
      props: { paneId: 'w1:p1' },
      global: { stubs },
    })
    unmount = () => w.unmount()
    return w
  }
  const touch = (el: Element, type: string, x: number, y: number) => {
    const e = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'touches', { value: [{ clientX: x, clientY: y }] })
    Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] })
    el.dispatchEvent(e)
    return e
  }

  it('closes the terminal input gate and inerts composer and key bar while copying', async () => {
    const w = await mounted()
    expect(w.find('.tv-stub').exists()).toBe(true)
    expect(hoisted.opts?.input?.()).toBe(true)
    const tv = w.findComponent(TerminalViewStub)
    tv.vm.$emit('copying', true)
    await nextTick()
    expect(hoisted.opts?.input?.()).toBe(false)
    expect(w.get('.phone-keybar-controls').attributes('inert')).toBeDefined()
    expect(w.get('.composer-stub').attributes('inert')).toBeDefined()
    expect(w.findComponent(ComposerStub).props('escStops')).toBe(false)
    tv.vm.$emit('copying', false)
    await nextTick()
    expect(hoisted.opts?.input?.()).toBe(true)
    expect(w.get('.composer-stub').attributes('inert')).toBeUndefined()
  })

  it('never swipes between panes while copying', async () => {
    const w = await mounted()
    const zone = w.get('.tv-stub').element
    const move = (x: number) => touch(zone, 'touchmove', x, 100)
    // Normal swipe (armed inside the terminal zone) consumes the gesture;
    // a small release keeps the fixture on this pane.
    touch(zone, 'touchstart', 40, 100)
    expect(move(140).defaultPrevented).toBe(true)
    touch(zone, 'touchend', 60, 100)
    const tv = w.findComponent(TerminalViewStub)
    tv.vm.$emit('copying', true)
    await nextTick()
    touch(zone, 'touchstart', 40, 100)
    expect(move(140).defaultPrevented).toBe(false)
    touch(zone, 'touchend', 140, 100)
  })
})
