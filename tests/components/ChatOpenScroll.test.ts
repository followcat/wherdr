// Opening a conversation places it once the blocks are really in the DOM: while
// the skeleton still hides them (it has a minimum display time) nothing can be
// measured — a saved reading position would land on the skeleton's height and
// open at the top, and a pin to the bottom would aim at the wrong content.
// ChatView also stays mounted across pane changes: leaving a conversation for
// another pane saves its reading position, and the new one opens at its own
// place or at the bottom — never held mid-scroll by the previous one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import ChatView from '~/components/ChatView.vue'
import { cachedAt, eventsOpen, herdrState, locked, netDown } from '~/composables/useHerdr'
import { setOfflineAccess } from '~/utils/offlineAccess'
import { restoredScrollTop, saveReadingPosition } from '~/utils/readingPosition'
import type { SavedChat } from '~/utils/offlineCache'
import type { ChatItem, Pane } from '#shared/types'

// The copy kept on this device answers when the test lets it go (`hold`), to
// keep it pending past the moment the skeleton appears.
const kept = vi.hoisted(() => ({ chat: null as SavedChat | null, hold: false, waiters: [] as ((c: SavedChat | null) => void)[] }))
vi.mock('~/utils/offlineCache', async (importOriginal) => {
  const mod = await importOriginal<typeof import('~/utils/offlineCache')>()
  return {
    ...mod,
    readChat: () => (kept.hold ? new Promise<SavedChat | null>(r => kept.waiters.push(r)) : Promise.resolve(kept.chat)),
    saveChat: () => {},
    touchChat: () => {},
  }
})

const FILE = '/tmp/demo/transcript.jsonl'
const items = (tag: string, n = 16): ChatItem[] => Array.from({ length: n }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user', text: `${tag} message ${i}`, ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
}))
const pane = (id: string): Pane => ({
  id, workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '/tmp/demo', agentSession: null,
})
const answer = (file = FILE, list = items('demo')) => ({ available: true, file, token: 't1', start: 0, items: structuredClone(list) })

// Reads of /api/chat hang until released for their pane.
const reads: { pane: string, resolve: (r: Response) => void }[] = []
const readsOf = (p: string) => reads.filter(r => r.pane === p).length
async function waitRead(p: string) {
  await expect.poll(() => readsOf(p), { timeout: 3000 }).toBeGreaterThan(0)
}
function release(p: string, body: object) {
  const i = reads.findIndex(r => r.pane === p)
  if (i < 0) throw new Error(`no pending read for ${p}`)
  reads.splice(i, 1)[0]!.resolve(Response.json(body))
}
const releaseKept = () => kept.waiters.splice(0).forEach(r => r(kept.chat))

// Layout for the scroll box: 200 px per rendered child of the list, a 500 px
// box. Every scrollTop write is recorded as its distance from the bottom then.
const tops = new WeakMap<Element, number>()
const height = (el: Element) => (el.querySelector('.chat-list')?.children.length || 0) * 200 + 500
let fromBottomWrites: number[] = []
const raf: FrameRequestCallback[] = []
async function flushFrames() {
  while (raf.length) {
    for (const cb of raf.splice(0)) cb(0)
    await nextTick()
  }
}
const observers: (() => void)[] = []
const fireResize = async () => { observers.forEach(cb => cb()); await nextTick() }

const box = (w: VueWrapper) => w.find('.chat').element as HTMLElement
const fromBottom = (w: VueWrapper) => height(box(w)) - box(w).scrollTop
const skeletonOn = (w: VueWrapper) => w.find('.chat-list.skeleton').exists()

async function mount(p: Pane, panes = [p]) {
  herdrState.value = { ok: true, workspaces: [], panes }
  return mountSuspended(ChatView, { props: { pane: p, localQueued: [] }, global: { stubs: { UTooltip: { template: '<slot />' } } } })
}
const clearPosition = (p: string) => saveReadingPosition(p, null, { scrollTop: 0, scrollHeight: 0, clientHeight: 0 })

describe('opening a conversation', () => {
  beforeEach(() => {
    const proto = HTMLElement.prototype
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return this.classList.contains('chat') ? height(this) : 0 } })
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return this.classList.contains('chat') ? 500 : 0 } })
    Object.defineProperty(proto, 'scrollTop', {
      configurable: true,
      get() { return tops.get(this) || 0 },
      set(v: number) {
        // The box clamps a write the way the DOM would.
        const top = this.classList.contains('chat') ? Math.max(0, Math.min(v, height(this) - 500)) : v
        tops.set(this, top)
        if (this.classList.contains('chat')) fromBottomWrites.push(height(this) - top)
      },
    })
    fromBottomWrites = []
    raf.length = 0
    observers.length = 0
    reads.length = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { raf.push(cb); return raf.length })
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: () => void) {}
      observe() { observers.push(this.cb) }
      unobserve() {}
      disconnect() {}
    })
    vi.stubGlobal('fetch', vi.fn((path: string) => {
      if (!String(path).startsWith('/api/chat?')) return Promise.resolve(Response.json({}))
      const paneId = new URLSearchParams(String(path).split('?')[1]).get('pane') || ''
      return new Promise<Response>((resolve) => { reads.push({ pane: paneId, resolve }) })
    }))
    locked.value = false; netDown.value = false; cachedAt.value = null; eventsOpen.value = true
    setOfflineAccess({ enabled: false, expiresAt: 0 })
  })
  afterEach(() => {
    kept.hold = false
    kept.chat = null
    releaseKept()
    for (const r of reads.splice(0)) r.resolve(Response.json({ available: false, reason: 'not_found' }))
    eventsOpen.value = false
    herdrState.value = { ok: false, workspaces: [], panes: [] }
    setOfflineAccess(null)
    for (const k of ['scrollHeight', 'clientHeight', 'scrollTop']) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k]
    vi.unstubAllGlobals()
  })

  it('opens at the bottom once the skeleton clears and the blocks are in', async () => {
    const p = pane('w1:p1')
    const w = await mount(p)
    try {
      await expect.poll(() => skeletonOn(w), { timeout: 3000 }).toBe(true)
      await waitRead(p.id)
      release(p.id, answer())
      await expect.poll(() => skeletonOn(w), { timeout: 3000 }).toBe(false)
      await expect.poll(() => w.find('.chat').text()).toContain('demo message 15')
      await fireResize()
      await flushFrames()
      expect(fromBottom(w)).toBe(500)
    } finally { w.unmount() }
  })

  it('restores the saved position, measured on the real blocks, not the skeleton', async () => {
    const p = pane('w1:p2')
    // Position kept 1700 px from the bottom of a taller conversation.
    saveReadingPosition(p.id, FILE, { scrollTop: 8300, scrollHeight: 10000, clientHeight: 500 })
    const w = await mount(p)
    try {
      await expect.poll(() => skeletonOn(w), { timeout: 3000 }).toBe(true)
      await waitRead(p.id)
      release(p.id, answer())
      await expect.poll(() => skeletonOn(w), { timeout: 3000 }).toBe(false)
      await expect.poll(() => w.find('.chat').text()).toContain('demo message 15')
      await fireResize()
      await flushFrames()
      expect(fromBottom(w)).toBe(1700)
    } finally { w.unmount(); clearPosition(p.id) }
  })

  it('restores the position on the kept copy, and the network answer keeps it', async () => {
    const p = pane('w1:p3')
    kept.chat = { id: p.id, items: items('kept'), at: Date.now() - 60_000, file: FILE }
    kept.hold = true // readChat resolves only when released, past the skeleton's appearance
    saveReadingPosition(p.id, FILE, { scrollTop: 8300, scrollHeight: 10000, clientHeight: 500 })
    const w = await mount(p)
    try {
      await expect.poll(() => skeletonOn(w), { timeout: 3000 }).toBe(true)
      releaseKept()
      await expect.poll(() => w.find('.chat').text()).toContain('kept message 15')
      await expect.poll(() => skeletonOn(w), { timeout: 3000 }).toBe(false)
      await fireResize()
      await flushFrames()
      expect(fromBottom(w)).toBe(1700)
      // The network's answer lands (longer): the place from the bottom stays.
      await waitRead(p.id)
      const writes = fromBottomWrites.length
      release(p.id, answer(FILE, items('live', 22)))
      // The last reply types in; the blocks are all there from the first paint.
      await expect.poll(() => w.find('.chat').text()).toContain('live message 20')
      await fireResize()
      await flushFrames()
      expect(fromBottom(w)).toBe(1700)
      expect(fromBottomWrites.slice(writes).every(d => d === 1700)).toBe(true)
    } finally { w.unmount(); clearPosition(p.id) }
  })

  it('saves the place of the conversation left and opens the next one at the bottom', async () => {
    const a = pane('w1:p4')
    const b = pane('w1:p5')
    const w = await mount(a, [a, b])
    try {
      await waitRead(a.id)
      release(a.id, answer())
      await expect.poll(() => w.find('.chat').text()).toContain('demo message 15')
      await nextTick()
      // The reader scrolls 1700 px up from the bottom.
      tops.set(box(w), height(box(w)) - 1700)
      await w.find('.chat').trigger('scroll')
      // The pane changes under the mounted view (phone swipe, pane selector).
      await w.setProps({ pane: b })
      await waitRead(b.id)
      release(b.id, answer(FILE, items('next')))
      await expect.poll(() => w.find('.chat').text()).toContain('next message 15')
      await fireResize()
      await flushFrames()
      // The conversation left keeps its place for the next open.
      expect(restoredScrollTop(a.id, FILE, height(box(w)))).toBe(height(box(w)) - 1700)
      // The new conversation is at its end, not where the previous one was.
      expect(fromBottom(w)).toBe(500)
    } finally { w.unmount(); clearPosition(a.id) }
  })

  it('opens a pane switched to at its own saved place', async () => {
    const a = pane('w1:p6')
    const b = pane('w1:p7')
    saveReadingPosition(b.id, FILE, { scrollTop: 8300, scrollHeight: 10000, clientHeight: 500 })
    const w = await mount(a, [a, b])
    try {
      await waitRead(a.id)
      release(a.id, answer())
      await expect.poll(() => w.find('.chat').text()).toContain('demo message 15')
      await w.setProps({ pane: b })
      await waitRead(b.id)
      release(b.id, answer())
      await expect.poll(() => w.find('.chat').text()).toContain('demo message 15')
      await fireResize()
      await flushFrames()
      expect(fromBottom(w)).toBe(1700)
    } finally { w.unmount(); clearPosition(b.id) }
  })
})
