import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import ChatView from '~/components/ChatView.vue'
import { herdrState } from '~/composables/useHerdr'
import type { ChatItem, Pane } from '#shared/types'

const pane: Pane = { id: 'w1:p9', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'omp', name: null, label: null, status: 'working', title: null, cwd: '/tmp/demo', agentSession: null }
const items: ChatItem[] = [
  { role: 'user', text: 'Explain the build.', ts: '2026-01-01T00:00:00Z' },
  { role: 'assistant', text: 'It runs in three steps.', ts: '2026-01-01T00:00:01Z' },
]
registerEndpoint('/api/chat', () => ({ available: true, token: 'follow', file: '/tmp/demo/follow.jsonl', items }))

// happy-dom lays nothing out: the scroll box gets a fake geometry, and the
// ResizeObserver that reports a growing message is fired by hand.
let observers: (() => void)[] = []
class FakeResizeObserver {
  constructor(private cb: () => void) {}
  observe() { observers.push(this.cb) }
  disconnect() {}
  unobserve() {}
}
function fakeBox(el: HTMLElement) {
  const g = { height: 1000, client: 400, top: 0 }
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => g.height })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => g.client })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => g.top,
    set: (v: number) => { g.top = Math.max(0, Math.min(v, g.height - g.client)) },
  })
  return g
}
const bottom = (g: { height: number, client: number }) => g.height - g.client

describe('conversation follows the end only from the bottom', () => {
  beforeEach(() => { observers = []; vi.stubGlobal('ResizeObserver', FakeResizeObserver) })
  afterEach(() => { vi.unstubAllGlobals(); herdrState.value = { ok: false, workspaces: [], panes: [] } })

  async function mount() {
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    const w = await mountSuspended(ChatView, {
      props: { pane, localQueued: [] },
      attachTo: document.body,
      // A finished turn shows its Copy reply button (UTooltip).
      global: { stubs: { UTooltip: { template: '<slot />' } } },
    })
    await expect.poll(() => w.find('.chat').text()).toContain('three steps')
    const box = w.find('.chat')
    const g = fakeBox(box.element as HTMLElement)
    // Opened at the end.
    g.top = bottom(g)
    await box.trigger('scroll')
    // The reply grows (typewriter): the list is resized.
    const grow = async (px = 60) => { g.height += px; observers.forEach(cb => cb()); await nextTick() }
    const scrollTo = async (top: number, wheel = false) => {
      if (wheel) await box.trigger('wheel', { deltaY: top < g.top ? -40 : 40 })
      g.top = top
      await box.trigger('scroll')
    }
    return { w, g, grow, scrollTo }
  }

  it('keeps the view at the bottom while a message grows there', async () => {
    const { w, g, grow } = await mount()
    try {
      await grow()
      await grow()
      expect(g.top).toBe(bottom(g))
    } finally { w.unmount() }
  })

  it('leaves a reader scrolled up where they are', async () => {
    const { w, g, grow, scrollTo } = await mount()
    try {
      await scrollTo(200, true)
      await grow()
      await grow()
      expect(g.top).toBe(200)
    } finally { w.unmount() }
  })

  it('stops following as soon as the reader scrolls up, even by a little, and resumes at the bottom', async () => {
    const { w, g, grow, scrollTo } = await mount()
    try {
      await grow()
      expect(g.top).toBe(bottom(g))
      // A small scroll up during the run, with a gesture behind it (a key on
      // the box here; a wheel or a touch drag goes through onUserScroll).
      await w.find('.chat').trigger('keydown', { key: 'ArrowUp' })
      await scrollTo(bottom(g) - 30)
      const reading = g.top
      for (let i = 0; i < 5; i++) await grow()
      expect(g.top).toBe(reading)
      // Back to the bottom by hand: following again.
      await scrollTo(bottom(g))
      await grow()
      expect(g.top).toBe(bottom(g))
    } finally { w.unmount() }
  })

  it('re-pins the scroll a collapsed composer truncates, with no gesture behind it', async () => {
    const { w, g, grow } = await mount()
    try {
      await grow()
      expect(g.top).toBe(bottom(g))
      // The composer's autoresize pass collapses the field to one row: .chat
      // grows taller and the browser truncates its scrollTop, then restores
      // the rows — no net resize (no ResizeObserver callback) and no wheel,
      // touch or key (no gesture). The scroll event of the truncation alone:
      g.top = bottom(g) - 69
      await w.find('.chat').trigger('scroll')
      // Undone before paint: the view is back at the end…
      expect(g.top).toBe(bottom(g))
      // …and still following the next growth.
      await grow()
      expect(g.top).toBe(bottom(g))
    } finally { w.unmount() }
  })

  it('lets a programmatic jump leave the bottom: the jump clears the following first', async () => {
    items.push({ role: 'user', text: '↳ Replying to your message from 00:00 ("It runs in three steps.")\nGo on.', ts: '2026-01-01T00:00:02Z' })
    try {
      const { w, g, grow } = await mount()
      try {
        await grow()
        expect(g.top).toBe(bottom(g))
        // Tapping the quote scrolls to the original message (smooth): its
        // scroll events carry no gesture of their own.
        await w.find('.msg-quote').trigger('click')
        // The animation's first frames still read atEnd — they must not re-arm
        // the following, or the next frame would be read as a scroll away to
        // undo and the jump would never leave the bottom.
        g.top = bottom(g) - 2
        await w.find('.chat').trigger('scroll')
        g.top = bottom(g) - 120
        await w.find('.chat').trigger('scroll')
        // Not undone: the jump left the bottom on purpose, so the following
        // stays off and the growth below does not pull the view back.
        const reading = g.top
        expect(reading).toBe(bottom(g) - 120)
        await grow()
        expect(g.top).toBe(reading)
      } finally { w.unmount() }
    } finally { items.pop() }
  })

  it('a new conversation follows its end at once, even right after a jump in the old one', async () => {
    items.push({ role: 'user', text: '↳ Replying to your message from 00:00 ("It runs in three steps.")\nGo on.', ts: '2026-01-01T00:00:02Z' })
    try {
      const { w, g, grow } = await mount()
      try {
        await grow()
        await w.find('.msg-quote').trigger('click')
        g.top = bottom(g) - 120
        await w.find('.chat').trigger('scroll')
        // Another session in the same pane, well within the jump's grace
        // period: the jump was the old conversation's.
        const next = { ...pane, agentSession: 'sess-2' }
        herdrState.value = { ok: true, workspaces: [], panes: [next] }
        await w.setProps({ pane: next })
        await expect.poll(() => w.find('.chat').text()).toContain('three steps')
        g.top = bottom(g)
        await w.find('.chat').trigger('scroll')
        await grow()
        expect(g.top).toBe(bottom(g))
        // A truncation with no gesture behind it is undone, as in any
        // conversation that follows its end.
        g.top = bottom(g) - 69
        await w.find('.chat').trigger('scroll')
        expect(g.top).toBe(bottom(g))
      } finally { w.unmount() }
    } finally { items.pop() }
  })

  it.each([
    { key: 'PageUp' },
    { key: 'ArrowUp' },
    { key: 'Home' },
    { key: ' ', shiftKey: true },
  ])('stops following when $key is pressed while focus is on document.body', async (keyInit) => {
    const { w, g, grow, scrollTo } = await mount()
    try {
      await grow()
      expect(g.top).toBe(bottom(g))
      document.body.focus()
      expect(document.activeElement).toBe(document.body)
      document.body.dispatchEvent(new KeyboardEvent('keydown', { ...keyInit, bubbles: true, cancelable: true }))
      await scrollTo(bottom(g) - 40)
      const reading = g.top
      expect(reading).toBe(bottom(g) - 40)
      await grow()
      expect(g.top).toBe(reading)
    } finally { w.unmount() }
  })

  it('ignores scroll keys from editable targets and the composer', async () => {
    const { w, g, grow } = await mount()
    const host = document.createElement('div')
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const composer = document.createElement('div')
    composer.className = 'composer'
    const composerBtn = document.createElement('button')
    composer.appendChild(composerBtn)
    host.append(input, textarea, editable, composer)
    document.body.appendChild(host)
    try {
      await grow()
      expect(g.top).toBe(bottom(g))
      for (const [target, key] of [
        [input, 'ArrowUp'],
        [textarea, 'PageUp'],
        [editable, 'Home'],
        [composerBtn, ' '],
      ] as const) {
        target.focus()
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
        g.top = bottom(g) - 69
        await w.find('.chat').trigger('scroll')
        expect(g.top).toBe(bottom(g))
      }
    } finally {
      host.remove()
      w.unmount()
    }
  })

  it('keeps a scrollbar drag as a live gesture while pointerdown stays held past GESTURE_MS', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { w, g, grow, scrollTo } = await mount()
      try {
        await grow()
        expect(g.top).toBe(bottom(g))
        await w.find('.chat').trigger('pointerdown')
        vi.setSystemTime(Date.now() + 1000)
        await scrollTo(bottom(g) - 80)
        const reading = g.top
        expect(reading).toBe(bottom(g) - 80)
        await grow()
        expect(g.top).toBe(reading)

        // Releasing outside .chat clears the held pointer state on pointerup, pointercancel, and blur.
        for (const [target, eventName] of [
          [window, 'pointerup'],
          [window, 'pointercancel'],
          [window, 'blur'],
        ] as const) {
          await scrollTo(bottom(g))
          await w.find('.chat').trigger('pointerdown')
          target.dispatchEvent(new Event(eventName))
          vi.setSystemTime(Date.now() + 1000)
          g.top = bottom(g) - 69
          await w.find('.chat').trigger('scroll')
          expect(g.top).toBe(bottom(g))
        }
      } finally { w.unmount() }
    } finally { vi.useRealTimers() }
  })

  it('re-pins on animation frame in scrollToEnd unless the user scrolled away first', async () => {
    const origRaf = globalThis.requestAnimationFrame
    let rafQueue: FrameRequestCallback[] = []
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb)
      return rafQueue.length
    }) as typeof requestAnimationFrame
    try {
      const { w, g, scrollTo } = await mount()
      try {
        const vm = w.vm as unknown as { scrollToEnd: (force: boolean) => void }
        rafQueue = []
        vm.scrollToEnd(true)
        expect(rafQueue.length).toBeGreaterThan(0)
        // Late layout settles before the frame fires.
        g.height += 40
        rafQueue.splice(0).forEach(cb => cb(0))
        expect(g.top).toBe(bottom(g))

        // If the user scrolls away before the frame fires, it must not yank them back.
        vm.scrollToEnd(true)
        await scrollTo(bottom(g) - 100, true)
        rafQueue.splice(0).forEach(cb => cb(0))
        expect(g.top).toBe(bottom(g) - 100)
      } finally { w.unmount() }
    } finally {
      globalThis.requestAnimationFrame = origRaf
    }
  })
})
