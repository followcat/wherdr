import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, nextTick, ref, watch } from 'vue'
import AgentView from '~/components/AgentView.vue'
import InteractiveTerminal from '~/components/InteractiveTerminal.vue'
import { desk, eventsOpen, herdrState } from '~/composables/useHerdr'
import type { Pane, Workspace } from '#shared/types'

// Each owner of a terminal tracks the copy surface's state: its input gate
// closes while copying (data, keys, paste, mouse), and the surrounding
// controls — key bar, composer, pane swipes — become inert.
const hoisted = vi.hoisted(() => ({
  opts: null as null | { input?: () => boolean, setBanner?: unknown, hasBanner?: unknown },
  composerAddFiles: vi.fn(async (files: File[]) => files.length),
  composerFocus: vi.fn(),
}))
vi.mock('~/composables/useTerminal', async () => {
  const { ref } = await import('vue')
  const ctl = () => ({
    loading: ref(false), kbdOn: ref(false),
    mount: vi.fn(async () => true), connect: vi.fn(), disconnect: vi.fn(), dispose: vi.fn(),
    takeControl: vi.fn(), isConnected: () => true, sendTerm: vi.fn(() => true), sendKeys: vi.fn(),
    fitNow: vi.fn(), setFontSize: vi.fn(), reset: vi.fn(), scroll: vi.fn(() => true),
    focus: vi.fn(), blur: vi.fn(), tapLink: vi.fn(() => false), tapMouse: vi.fn(), tapOnCursor: vi.fn(() => false),
    hasFocus: () => false, imeBusy: () => false, rowHeight: () => 16, pageRows: () => 24, setVisible: vi.fn(),
    captureScreen: vi.fn(() => null),
    hasBanner: () => false, selectionHint: { visible: ref(false), dismiss: vi.fn() },
    scrollInputVersion: ref(0), scrollGeometryVersion: ref(0), frameTick: ref(0),
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
const ComposerStub = defineComponent({
  name: 'Composer',
  props: ['escStops'],
  methods: {
    addFiles: (files: File[]) => hoisted.composerAddFiles(files),
    focus: () => hoisted.composerFocus(),
  },
  template: '<div class="composer-stub" />',
})
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

  // The computer layout's terminal drop target shares the input gate: a drop
  // during copy never uploads or sends, and an upload already in flight when
  // the freeze starts keeps its result until Done — the same "retain for a
  // later send" the Composer gives in-flight attachments — instead of sending
  // into the frozen surface.
  describe('file drops share the copy input gate', () => {
    const calls: { url: string, body?: string, open?: boolean }[] = []
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data })
    const fileCalls = () => calls.filter(c => c.url.startsWith('/api/file'))
    const inputCalls = () => calls.filter(c => c.url.startsWith('/api/input'))
    const dropOnTerm = (w: Awaited<ReturnType<typeof mounted>>, files: File[]) => {
      const e = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(e, 'dataTransfer', { value: { files, types: ['Files'] } })
      w.get('.tv-stub').element.dispatchEvent(e)
      return e
    }
    const dropFile = (name = 'demo.txt') => new File(['demo'], name, { type: 'text/plain' })
    // fetch answers: /api/file and /api/input take their next queued
    // response (defaults: the demo path / an empty ok), everything else ok.
    const stubFetch = (fileAnswers: unknown[] = [], inputAnswers: unknown[] = []) => vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { body?: string }) => {
      const u = String(url)
      // `open` snapshots the shared input predicate at invocation: a call made
      // while the gate was closed is a live bug, no matter when the await chain
      // happened to resume.
      calls.push({ url: u, body: init?.body, open: hoisted.opts?.input?.() })
      if (u.startsWith('/api/file')) return fileAnswers.length ? fileAnswers.shift() : json({ path: '/home/user/demo.txt', name: 'demo.txt' })
      if (u.startsWith('/api/input')) return inputAnswers.length ? inputAnswers.shift() : json({})
      return json({})
    }))
    const deferred = <T>() => {
      let resolve!: (v: T) => void
      return { promise: new Promise<T>(r => { resolve = r }), resolve }
    }

    beforeEach(() => {
      desk.value = true
      stubFetch()
      hoisted.composerAddFiles.mockClear()
      hoisted.composerFocus.mockClear()
    })
    afterEach(() => {
      desk.value = false
      calls.length = 0
      vi.unstubAllGlobals()
    })

    it('refuses a file dropped on the frozen surface — no upload, no send, default suppressed', async () => {
      const w = await mounted()
      const tv = w.findComponent(TerminalViewStub)
      tv.vm.$emit('copying', true)
      await nextTick()
      const e = dropOnTerm(w, [dropFile()])
      await flushPromises()
      expect(fileCalls()).toEqual([])
      expect(inputCalls()).toEqual([])
      expect(e.defaultPrevented).toBe(true)
    })

    it('holds an upload that finishes during copy until Done, then sends its path once', async () => {
      const w = await mounted()
      const upload = deferred<unknown>()
      stubFetch([upload.promise])
      const tv = w.findComponent(TerminalViewStub)
      dropOnTerm(w, [dropFile()])
      await vi.waitFor(() => expect(fileCalls()).toHaveLength(1))
      tv.vm.$emit('copying', true)
      await nextTick()
      upload.resolve(json({ path: '/home/user/demo.txt', name: 'demo.txt' }))
      await flushPromises()
      expect(inputCalls()).toEqual([])
      tv.vm.$emit('copying', false)
      await nextTick()
      await vi.waitFor(() => expect(inputCalls()).toHaveLength(1))
      expect(JSON.parse(inputCalls()[0]!.body!)).toMatchObject({ pane_id: 'w1:p1', text: '/home/user/demo.txt', keys: ['enter'] })
      await flushPromises()
      expect(inputCalls()).toHaveLength(1)
    })

    it('delivers every retained upload once after Done, in drop order', async () => {
      const w = await mounted()
      const first = deferred<unknown>()
      stubFetch([first.promise, json({ path: '/home/user/b.txt', name: 'b.txt' })])
      const tv = w.findComponent(TerminalViewStub)
      dropOnTerm(w, [dropFile('a.txt'), dropFile('b.txt')])
      await vi.waitFor(() => expect(fileCalls()).toHaveLength(1))
      tv.vm.$emit('copying', true)
      await nextTick()
      first.resolve(json({ path: '/home/user/a.txt', name: 'a.txt' }))
      await flushPromises()
      // a finished mid-freeze: retained, never sent — and b never started.
      expect(inputCalls()).toEqual([])
      expect(fileCalls()).toHaveLength(1)
      tv.vm.$emit('copying', false)
      await nextTick()
      await vi.waitFor(() => expect(inputCalls()).toHaveLength(2))
      expect(inputCalls().map(c => JSON.parse(c.body!).text)).toEqual(['/home/user/a.txt', '/home/user/b.txt'])
      expect(fileCalls()).toHaveLength(2)
    })

    it('invokes the send in the same continuation that re-checked the gate', async () => {
      const w = await mounted()
      const upload = deferred<unknown>()
      stubFetch([upload.promise])
      const tv = w.findComponent(TerminalViewStub)
      dropOnTerm(w, [dropFile()])
      await vi.waitFor(() => expect(fileCalls()).toHaveLength(1))
      tv.vm.$emit('copying', true)
      await nextTick()
      upload.resolve(json({ path: '/home/user/demo.txt', name: 'demo.txt' }))
      await flushPromises()
      expect(inputCalls()).toEqual([])
      // Re-opening queues a re-close one microtask later — inside the gap
      // between a resolved gate-wait and the caller's next continuation. If a
      // `await` sits between the last gate check and sendMessage, this send
      // fires with the predicate already closed (open === false).
      const closeNext = watch(hoisted.opts!.input!, (v) => {
        if (v) queueMicrotask(() => tv.vm.$emit('copying', true))
      }, { flush: 'post' })
      tv.vm.$emit('copying', false)
      await flushPromises()
      closeNext()
      expect(inputCalls().map(c => c.open)).toEqual([true])
      expect(JSON.parse(inputCalls()[0]!.body!)).toMatchObject({ pane_id: 'w1:p1', text: '/home/user/demo.txt', keys: ['enter'] })
    })

    it('keeps the retained upload parked when the gate closes again after its wait resolved', async () => {
      const w = await mounted()
      const upload = deferred<unknown>()
      stubFetch([upload.promise])
      const tv = w.findComponent(TerminalViewStub)
      dropOnTerm(w, [dropFile()])
      await vi.waitFor(() => expect(fileCalls()).toHaveLength(1))
      tv.vm.$emit('copying', true)
      await nextTick()
      upload.resolve(json({ path: '/home/user/demo.txt', name: 'demo.txt' }))
      await flushPromises()
      expect(inputCalls()).toEqual([])
      // A post-flush watcher on the shared predicate re-closes the gate inside
      // the same flush that re-opens it — the send continuation then sees a
      // closed gate and must park for the next Done, not drop the path.
      const reclose = watch(hoisted.opts!.input!, (v) => { if (v) tv.vm.$emit('copying', true) }, { flush: 'post' })
      tv.vm.$emit('copying', false)
      await flushPromises()
      reclose()
      expect(inputCalls()).toEqual([])
      tv.vm.$emit('copying', false)
      await vi.waitFor(() => expect(inputCalls()).toHaveLength(1))
      expect(JSON.parse(inputCalls()[0]!.body!)).toMatchObject({ pane_id: 'w1:p1', text: '/home/user/demo.txt', keys: ['enter'] })
    })

    it('drops the retained send when the pane leaves the state before Done', async () => {
      const w = await mounted()
      const upload = deferred<unknown>()
      stubFetch([upload.promise])
      const tv = w.findComponent(TerminalViewStub)
      dropOnTerm(w, [dropFile()])
      await vi.waitFor(() => expect(fileCalls()).toHaveLength(1))
      tv.vm.$emit('copying', true)
      await nextTick()
      upload.resolve(json({ path: '/home/user/demo.txt', name: 'demo.txt' }))
      await flushPromises()
      // The pane left the state while the upload's send was parked: nothing
      // may be delivered after Done.
      herdrState.value = { ...herdrState.value, panes: [] }
      tv.vm.$emit('copying', false)
      await nextTick()
      await flushPromises()
      expect(inputCalls()).toEqual([])
    })

    it('drops the retained send when the view unmounts before Done', async () => {
      const w = await mounted()
      const upload = deferred<unknown>()
      stubFetch([upload.promise])
      const tv = w.findComponent(TerminalViewStub)
      dropOnTerm(w, [dropFile()])
      await vi.waitFor(() => expect(fileCalls()).toHaveLength(1))
      tv.vm.$emit('copying', true)
      await nextTick()
      upload.resolve(json({ path: '/home/user/demo.txt', name: 'demo.txt' }))
      await flushPromises()
      w.unmount()
      unmount = undefined
      await flushPromises()
      expect(inputCalls()).toEqual([])
    })

    it('drops an upload still in flight when the view unmounts', async () => {
      const w = await mounted()
      const upload = deferred<unknown>()
      stubFetch([upload.promise])
      dropOnTerm(w, [dropFile()])
      await vi.waitFor(() => expect(fileCalls()).toHaveLength(1))
      // The response lands after the view is gone: no gate state remains to
      // wait on, and no send may happen. The pane stays in the state.
      w.unmount()
      unmount = undefined
      upload.resolve(json({ path: '/home/user/demo.txt', name: 'demo.txt' }))
      await flushPromises()
      expect(inputCalls()).toEqual([])
    })

    it('drops the retained send when the view switches to another existing pane before Done', async () => {
      const w = await mounted()
      const upload = deferred<unknown>()
      stubFetch([upload.promise])
      const tv = w.findComponent(TerminalViewStub)
      dropOnTerm(w, [dropFile()])
      await vi.waitFor(() => expect(fileCalls()).toHaveLength(1))
      tv.vm.$emit('copying', true)
      await nextTick()
      upload.resolve(json({ path: '/home/user/demo.txt', name: 'demo.txt' }))
      await flushPromises()
      // The parked send belongs to w1:p1: a switch to the sibling pane ends
      // the wait without a send to either pane.
      await w.setProps({ paneId: 'w1:p2' })
      tv.vm.$emit('copying', false)
      await nextTick()
      await flushPromises()
      expect(inputCalls()).toEqual([])
    })

    it('re-waits on the gate for each file when copy opens while a send is in flight', async () => {
      const w = await mounted()
      const send = deferred<unknown>()
      stubFetch([json({ path: '/home/user/a.txt', name: 'a.txt' }), json({ path: '/home/user/b.txt', name: 'b.txt' })], [send.promise])
      const tv = w.findComponent(TerminalViewStub)
      dropOnTerm(w, [dropFile('a.txt'), dropFile('b.txt')])
      // a's send is in flight when the surface freezes: b's upload must not
      // even start until Done re-opens the gate.
      await vi.waitFor(() => expect(inputCalls()).toHaveLength(1))
      tv.vm.$emit('copying', true)
      await nextTick()
      send.resolve(json({}))
      await flushPromises()
      expect(fileCalls()).toHaveLength(1)
      tv.vm.$emit('copying', false)
      await nextTick()
      await vi.waitFor(() => expect(inputCalls()).toHaveLength(2))
      expect(inputCalls().map(c => JSON.parse(c.body!).text)).toEqual(['/home/user/a.txt', '/home/user/b.txt'])
      expect(fileCalls()).toHaveLength(2)
    })

    it('refuses the composer drop route while copying, still suppressing the default', async () => {
      desk.value = false
      const w = await mounted()
      const tv = w.findComponent(TerminalViewStub)
      // A normal chat drop still reaches the composer — non-copy drops stay.
      dropOnTerm(w, [dropFile()])
      await flushPromises()
      expect(hoisted.composerAddFiles).toHaveBeenCalledTimes(1)
      tv.vm.$emit('copying', true)
      await nextTick()
      const e = dropOnTerm(w, [dropFile()])
      await flushPromises()
      expect(hoisted.composerAddFiles).toHaveBeenCalledTimes(1)
      expect(e.defaultPrevented).toBe(true)
    })
  })
})
