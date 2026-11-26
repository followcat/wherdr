// A reload (a `/clear`, a compaction, a bottom read from another byte) drops
// the requests of the old generation, and nothing else: a reader scrolled up
// mid-conversation keeps its place, its search and the replies it knows — the
// "New" divider is not raised for a reply already on screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, defineComponent, h, shallowRef } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import ChatView from '~/components/ChatView.vue'
import { herdrState } from '~/composables/useHerdr'
import type { ChatItem, ChatResponse, Pane } from '#shared/types'

vi.mock('~/utils/readingPosition', () => ({
  saveReadingPosition: vi.fn(),
  restoredScrollTop: vi.fn(() => null),
}))
vi.mock('~/utils/offlineCache', () => ({
  readChat: vi.fn(async () => null),
  saveChat: vi.fn(),
  touchChat: vi.fn(),
}))

const pane: Pane = {
  id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null,
  agent: 'claude', name: null, label: null, status: 'idle', title: null,
  cwd: '/home/user/acme-shop', agentSession: 'sess-1', coreAddress: 'addr-1', bornAt: 1,
}
const FILE = '/home/user/acme-shop/session-1.jsonl'
const items: ChatItem[] = [
  { role: 'user', text: 'Explain the build.', ts: '2026-01-01T00:00:00Z' },
  { role: 'assistant', text: 'The build runs in three steps.', ts: '2026-01-01T00:00:01Z' },
]
const tail = (start = 0): ChatResponse => ({ available: true, file: FILE, token: `t-${start}`, start, items })

let reloadNext = false
let olderReply: ChatResponse | null = null
let olderRelease: (() => void) | null = null
let asks: Record<string, string>[] = []

function server() {
  vi.stubGlobal('fetch', vi.fn((path: string) => {
    if (!path.startsWith('/api/chat?')) return Promise.resolve(Response.json({}))
    const q = Object.fromEntries(new URLSearchParams(path.split('?')[1]))
    asks.push(q)
    if (q.before) {
      return new Promise<Response>((ok) => { olderRelease = () => ok(Response.json(olderReply || tail())) })
    }
    if (reloadNext) {
      reloadNext = false
      return Promise.resolve(Response.json({ available: true, file: FILE, reload: true }))
    }
    return Promise.resolve(Response.json(tail()))
  }))
}

// happy-dom lays nothing out: the scroll box gets a fake geometry.
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

interface Vm {
  search: { q: string, hits: Range[], loading: boolean, cur: number }
  runSearch: () => Promise<void>
}
const current = shallowRef<Pane>(pane)
async function mount() {
  herdrState.value = { ok: true, session: 'herdr-a', workspaces: [], panes: [pane] }
  const Host = defineComponent({
    render: () => h(UApp, null, () => h(ChatView, { pane: current.value, localQueued: [], search: true, 'onUpdate:search': () => {} })),
  })
  const w = await mountSuspended(Host)
  const box = w.find('.chat')
  ;(box.element as HTMLElement & { scrollTo: (o: unknown) => void }).scrollTo = () => {}
  const g = fakeBox(box.element as HTMLElement)
  const vm = w.findComponent(ChatView).vm as unknown as Vm
  const push = async (next: Pane) => { current.value = next; await nextTick() }
  return { w, box, g, vm, push }
}

beforeEach(() => {
  reloadNext = false
  olderReply = null
  olderRelease = null
  asks = []
  current.value = pane
  server()
})
afterEach(() => {
  vi.unstubAllGlobals()
  herdrState.value = { ok: false, workspaces: [], panes: [] }
})

describe('a reload keeps the reader where it was', () => {
  it('keeps the scroll position, the search and the known replies', async () => {
    const { w, box, g, vm, push } = await mount()
    try {
      await expect.poll(() => w.find('.chat').text()).toContain('three steps')
      // Scrolled up mid-conversation, the reader searched the conversation.
      await box.trigger('wheel', { deltaY: -40 })
      g.top = 200
      await box.trigger('scroll')
      vm.search.q = 'build'
      await vm.runSearch()
      const hits = vm.search.hits.length
      expect(hits).toBeGreaterThan(0)
      const cur = vm.search.cur
      // A poll brings a reload answer (a /clear, a compaction, another byte).
      reloadNext = true
      await push({ ...pane, status: 'working' })
      await expect.poll(() => asks.filter(q => !q.before).length).toBeGreaterThanOrEqual(3)
      // The reloaded conversation is shown without moving the reader: the
      // scroll position and the search marks stay.
      expect(g.top).toBe(200)
      expect(vm.search.hits.length).toBe(hits)
      expect(vm.search.cur).toBe(cur)
      // A reply already known raises no "New" divider.
      expect(w.find('[data-testid="new-sep"]').exists()).toBe(false)
    } finally { w.unmount() }
  })

  it('drops an older page whose answer lands after the reload', async () => {
    let start = 10
    vi.stubGlobal('fetch', vi.fn((path: string) => {
      if (!path.startsWith('/api/chat?')) return Promise.resolve(Response.json({}))
      const q = Object.fromEntries(new URLSearchParams(path.split('?')[1]))
      asks.push(q)
      if (q.before) return new Promise<Response>((ok) => { olderRelease = () => ok(Response.json(olderReply!)) })
      if (reloadNext) { reloadNext = false; return Promise.resolve(Response.json({ available: true, file: FILE, reload: true })) }
      return Promise.resolve(Response.json(tail(start)))
    }))
    olderReply = { available: true, file: FILE, older: true, start: 0, items: [{ role: 'user', text: 'The earlier question.', ts: null }] }
    const { w, box, g, vm, push } = await mount()
    try {
      await expect.poll(() => w.find('.chat').text()).toContain('three steps')
      await box.trigger('wheel', { deltaY: -40 })
      g.top = 200
      await box.trigger('scroll')
      const older = w.findAll('button').find(b => b.text().includes('Load earlier messages'))
      expect(older).toBeDefined()
      await older!.trigger('click')
      await expect.poll(() => olderRelease !== null).toBe(true)
      // The reload lands while the older page is still in flight.
      reloadNext = true
      start = 0
      await push({ ...pane, status: 'working' })
      await expect.poll(() => asks.filter(q => !q.before).length).toBeGreaterThanOrEqual(3)
      // Its answer arrives late: it belongs to the old generation and is dropped.
      olderRelease!()
      await nextTick()
      expect(w.find('.chat').text()).not.toContain('The earlier question.')
      expect(g.top).toBe(200)
    } finally { w.unmount() }
  })
})
