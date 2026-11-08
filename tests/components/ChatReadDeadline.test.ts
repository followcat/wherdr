import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import ChatView from '~/components/ChatView.vue'
import { useChatIntent } from '~/composables/useChatIntent'
import { cachedAt, eventsOpen, herdrState, locked, netDown } from '~/composables/useHerdr'
import type { Pane } from '#shared/types'

vi.mock('~/utils/offlineCache', () => ({ readChat: async () => null, saveChat: vi.fn(), touchChat: vi.fn() }))
const pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', agent: 'claude', status: 'idle', cwd: '/tmp/demo' } as Pane

afterEach(() => {
  eventsOpen.value = false
  herdrState.value = { ok: false, panes: [], workspaces: [] }
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

function clock() {
  vi.useFakeTimers()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms)
    return controller.signal
  })
}

function reader() {
  locked.value = false; netDown.value = false; cachedAt.value = null
  herdrState.value = { ok: true, panes: [pane], workspaces: [] }
  let silent = false
  const requests: { older: boolean, aborted: boolean }[] = []
  let text = 'Kept reply'
  vi.stubGlobal('fetch', vi.fn((path: string, opts?: RequestInit) => {
    if (!path.startsWith('/api/chat?')) return Promise.resolve(Response.json({}))
    if (silent) {
      const request = { older: path.includes('before='), aborted: false }
      requests.push(request)
      return new Promise<Response>((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => { request.aborted = true; reject(opts.signal!.reason) }, { once: true })
      })
    }
    return Promise.resolve(Response.json({ available: true, file: 'fixture.jsonl', token: text, start: path.includes('before=') ? 0 : 4096, items: [{ role: 'assistant', text }] }))
  }))
  return { hang: () => { silent = true }, recover: () => { silent = false; text = 'Recovered reply' }, lastRead: (older = false) => requests.findLast(request => request.older === older)! }
}

it('shows a plain retry message when the first conversation read times out', async () => {
  const read = reader()
  read.hang()
  const deadline = new AbortController()
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  const wrapper = await mountSuspended(ChatView, { props: { pane, localQueued: [] } })
  try {
    deadline.abort(new DOMException('signal timed out', 'TimeoutError'))
    await expect.poll(() => wrapper.find('.chat-empty').text()).toBe('The conversation took too long to load. Retry.')
    expect(wrapper.text()).not.toContain('signal timed out')
  } finally { wrapper.unmount() }
})

it('releases a silent bottom read after 8 seconds so the next refresh can recover', async () => {
  const read = reader()
  const wrapper = await mountSuspended(ChatView, { props: { pane, localQueued: [] } })
  try {
    await expect.poll(() => wrapper.text()).toContain('Kept reply')
    clock(); read.hang()
    await wrapper.setProps({ pane: { ...pane, status: 'blocked' } })
    await flushPromises()
    const pending = read.lastRead()
    await vi.advanceTimersByTimeAsync(7999)
    expect(pending.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(pending.aborted).toBe(true)
    expect(wrapper.text()).toContain('Kept reply')
    read.recover()
    await wrapper.setProps({ pane: { ...pane, status: 'working' } })
    await vi.advanceTimersByTimeAsync(100)
    await flushPromises()
    expect(wrapper.text()).toContain('Recovered reply')
  } finally { wrapper.unmount() }
})

it('releases a silent older-page read so it can be retried', async () => {
  const read = reader()
  const wrapper = await mountSuspended(ChatView, { props: { pane, localQueued: [] } })
  try {
    await expect.poll(() => wrapper.text()).toContain('Kept reply')
    clock(); read.hang()
    // Start a bottom read first so its abort cannot stand in for this page's.
    await wrapper.setProps({ pane: { ...pane, status: 'blocked' } })
    await flushPromises()
    const bottom = read.lastRead()
    await vi.advanceTimersByTimeAsync(1000)
    const older = wrapper.find('.chat-more button')
    await older.trigger('click')
    const pending = read.lastRead(true)
    await vi.advanceTimersByTimeAsync(7999)
    expect(bottom.aborted).toBe(true)
    expect(pending.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(pending.aborted).toBe(true)
    read.recover()
    await older.trigger('click')
    await vi.advanceTimersByTimeAsync(100)
    await flushPromises()
    expect(wrapper.text()).toContain('Recovered reply')
    expect(wrapper.text()).toContain('Kept reply')
  } finally { wrapper.unmount() }
})

it('expires a silent speculative read without AbortSignal.any', async () => {
  const read = reader()
  clock(); read.hang()
  // iOS 16.4 has AbortSignal.timeout, but not AbortSignal.any.
  vi.stubGlobal('AbortSignal', { timeout: AbortSignal.timeout, any: undefined })
  eventsOpen.value = true
  const intent = useChatIntent()
  intent.preload(pane)
  const request = read.lastRead()
  const pending = intent.take(pane)
  await vi.advanceTimersByTimeAsync(7999)
  expect(request.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(request.aborted).toBe(true)
  expect(await pending).toBeUndefined()
})

// A restart of the bottom read: another session (/clear), or the server
// restarted and forgot this list (server/utils/chatDelta.ts), so its full
// reply starts at another byte. The list never goes empty in between, and an
// item already shown keeps its node.
it.each([
  ['another session', 'new.jsonl', 0],
  ['the server forgot the list', 'old.jsonl', 2048],
])('keeps the conversation on screen while a restarted read is in flight (%s)', async (_case, file, start) => {
  locked.value = false; netDown.value = false; cachedAt.value = null
  herdrState.value = { ok: true, panes: [pane], workspaces: [] }
  const item = (text: string) => ({ role: 'assistant', text, ts: `2026-01-01T00:00:0${text.length % 10}Z` })
  const reply = (f: string, at: number, token: string, texts: string[]) => Response.json({ available: true, file: f, token, start: at, items: texts.map(item) })
  let next: (() => Promise<Response>) = async () => reply('old.jsonl', 0, 'a', ['Same reply', 'Old reply'])
  vi.stubGlobal('fetch', vi.fn((path: string) => path.startsWith('/api/chat?') ? next() : Promise.resolve(Response.json({}))))
  const wrapper = await mountSuspended(ChatView, { props: { pane, localQueued: [] } })
  try {
    await expect.poll(() => wrapper.text()).toContain('Old reply')
    const node = () => wrapper.findAll('.chat *').find(n => n.element.childElementCount === 0 && n.text() === 'Same reply')?.element
    const before = node()
    expect(before).toBeTruthy()
    // The reply that tells of the restart, then the full read, held back.
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    let calls = 0
    next = async () => (calls++
      ? (await held, reply(file, start, 'b', ['Same reply', 'New reply']))
      : reply(file, start, 'b', ['Same reply', 'New reply']))
    await wrapper.setProps({ pane: { ...pane, status: 'working' } })
    await expect.poll(() => calls).toBe(2)
    await flushPromises()
    expect(wrapper.text()).toContain('Old reply')
    expect(wrapper.find('.chat-empty').exists()).toBe(false)
    release()
    await expect.poll(() => wrapper.text()).toContain('New reply')
    expect(wrapper.text()).not.toContain('Old reply')
    expect(node()).toBe(before)
  } finally { wrapper.unmount() }
})
