// The conversation shown belongs to one process identity: the same pane id
// showing another agent, session or process start is another conversation and
// the view resets and reloads it. A `cd` in the pane (cwd), a new title,
// status or preview is not a new conversation: nothing is reset or reloaded.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineComponent, h, nextTick, shallowRef } from 'vue'
import { UApp } from '#components'
import ChatView from '~/components/ChatView.vue'
import { herdrState } from '~/composables/useHerdr'
import { saveReadingPosition } from '~/utils/readingPosition'
import { saveChat } from '~/utils/offlineCache'
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
  cwd: '/home/alice/acme-shop', agentSession: 'sess-1', coreAddress: 'addr-1', bornAt: 1,
}
const FILE1 = '/home/alice/acme-shop/session-1.jsonl'
const FILE2 = '/home/alice/acme-shop/session-2.jsonl'
const first: ChatItem[] = [
  { role: 'user', text: 'Fix the flaky test.', ts: '2026-01-01T00:00:00Z' },
  { role: 'assistant', text: 'Fixed: it was a race.', ts: '2026-01-01T00:00:01Z' },
]
const second: ChatItem[] = [
  { role: 'user', text: 'Write the release notes.', ts: '2026-01-02T00:00:00Z' },
  { role: 'assistant', text: 'Drafted under Unreleased.', ts: '2026-01-02T00:00:01Z' },
]
const tail = (file: string, items: ChatItem[]): ChatResponse => ({ available: true, file, token: `t-${file}`, start: 0, items })

let reads = 0
let respond: () => ChatResponse | Promise<ChatResponse>
registerEndpoint('/api/chat', () => { reads++; return respond() })

// The pane as the live state hands it to the view: a new object on each push.
const current = shallowRef<Pane>()
interface Vm {
  rendered: boolean
  search: { q: string, hits: Range[], loading: boolean, cur: number }
  loadChat: () => Promise<void>
  runSearch: () => Promise<void>
}
async function mount(p: Pane, search = false) {
  current.value = p
  herdrState.value = { ok: true, session: 'herdr-a', workspaces: [], panes: [p] }
  const Host = defineComponent({
    render: () => h(UApp, null, () => h(ChatView, {
      pane: current.value!,
      localQueued: [],
      search,
      'onUpdate:search': () => {},
    })),
  })
  const w = await mountSuspended(Host)
  const vm = w.findComponent(ChatView).vm as unknown as Vm
  const push = async (next: Pane) => { current.value = next; await nextTick() }
  return { w, vm, push }
}
// The blocks on screen, to tell a repaint of the same list from a fresh one.
const blocksOf = (w: { element: Element }) => [...w.element.querySelectorAll('[data-hit-key]')]

describe('conversation identity', () => {
  beforeEach(() => {
    reads = 0
    vi.mocked(saveReadingPosition).mockClear()
    vi.mocked(saveChat).mockClear()
  })
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] } })

  it('keeps the conversation on a `cd` of the same pane: cwd, title, status and preview are not the identity', async () => {
    respond = () => tail(FILE1, first)
    const { w, vm, push } = await mount(pane)
    try {
      await expect.poll(() => w.find('.chat').text()).toContain('it was a race')
      const before = blocksOf(w)
      expect(before.length).toBeGreaterThan(0)
      // The agent changed directory: the state push brings a new cwd (and the
      // usual title, status and preview) for the same process identity.
      await push({ ...pane, cwd: '/home/alice/acme-shop/packages/web', title: 'web', status: 'working', preview: 'Fixed: it was a race.' })
      await flushPromises()
      // No reset: no reading position saved for the "leaving" conversation,
      // nothing emptied, the same blocks still on screen.
      expect(saveReadingPosition).not.toHaveBeenCalled()
      expect(vm.rendered).toBe(true)
      const after = blocksOf(w)
      expect(after.length).toBe(before.length)
      for (const [i, el] of after.entries()) expect(el).toBe(before[i])
      expect(w.find('.chat').text()).toContain('it was a race')
    } finally { w.unmount() }
  })

  it.each([
    ['agentSession', { agentSession: 'sess-2' }],
    ['agent', { agent: 'codex' }],
    ['bornAt', { bornAt: 2 }],
    ['coreAddress', { coreAddress: 'addr-2' }],
    ['machine', { machine: 'host-a' }],
  ])('resets and reloads when %s changes on the same pane id', async (_field, change) => {
    let step = 0
    respond = () => step++ === 0 ? tail(FILE1, first) : tail(FILE2, second)
    const { w, vm, push } = await mount(pane)
    try {
      await expect.poll(() => w.find('.chat').text()).toContain('it was a race')
      await expect.poll(() => vi.mocked(saveChat).mock.calls.length).toBeGreaterThan(0)
      vi.mocked(saveChat).mockClear()
      await push({ ...pane, ...change })
      // The outgoing conversation's reading position was saved under its own
      // pane id and transcript before the reset.
      expect(vi.mocked(saveReadingPosition).mock.calls).toEqual([['w1:p1', FILE1, expect.anything()]])
      // The old conversation was dropped and the new one loaded in its place.
      await expect.poll(() => w.find('.chat').text()).toContain('release notes')
      expect(w.find('.chat').text()).not.toContain('it was a race')
      expect(vm.rendered).toBe(true)
      // And what is kept on this device is the new conversation only.
      for (const call of vi.mocked(saveChat).mock.calls) expect(JSON.stringify(call[1])).not.toContain('it was a race')
    } finally { w.unmount() }
  })

  it('drops the old conversation’s late reply when the session changes while a read is in flight', async () => {
    let release!: (r: ChatResponse) => void
    let initial = true
    respond = () => {
      if (initial) {
        initial = false
        return new Promise<ChatResponse>((ok) => { release = ok })
      }
      return tail(FILE2, second)
    }
    const { w, vm, push } = await mount(pane)
    try {
      // The first read is still unanswered when the session changes.
      await expect.poll(() => reads).toBe(1)
      await push({ ...pane, agentSession: 'sess-2' })
      await expect.poll(() => w.find('.chat').text()).toContain('release notes')
      // Its answer lands only now: stale, it is ignored — it neither shows
      // nor is saved over the new conversation.
      release(tail(FILE1, first))
      await flushPromises()
      expect(w.find('.chat').text()).toContain('release notes')
      expect(w.find('.chat').text()).not.toContain('it was a race')
      expect(vm.rendered).toBe(true)
      for (const call of vi.mocked(saveChat).mock.calls) expect(JSON.stringify(call[1])).not.toContain('it was a race')
    } finally { w.unmount() }
  })

  it('clears the old conversation’s search marks on reset', async () => {
    let step = 0
    respond = () => step++ === 0 ? tail(FILE1, first) : tail(FILE2, second)
    const { w, vm, push } = await mount(pane, true)
    try {
      await expect.poll(() => w.find('.chat').text()).toContain('it was a race')
      const box = w.find('.chat').element as HTMLElement & { scrollTo: (o: unknown) => void }
      box.scrollTo = () => {}
      vm.search.q = 'race'
      await vm.runSearch()
      expect(vm.search.hits.length).toBeGreaterThan(0)
      expect(w.find('.search-count').text()).not.toBe('no results')
      await push({ ...pane, agentSession: 'sess-2' })
      await expect.poll(() => w.find('.chat').text()).toContain('release notes')
      // Marks and hits were the old conversation's: the kept query finds
      // nothing in the new one instead of marking the old transcript's text.
      expect(vm.search.hits).toEqual([])
      expect(vm.search.loading).toBe(false)
      expect(w.find('.search-count').text()).toBe('no results')
    } finally { w.unmount() }
  })
})
