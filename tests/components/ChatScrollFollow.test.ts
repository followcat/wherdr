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
    const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] } })
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
      // A small scroll up (keyboard, scrollbar or touch: no wheel) during the run.
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
})
