// Command Code in the Conversation view: its identity is the live process,
// not the pane. A kept tail cannot prove it came from this process, an
// unavailable reply is authoritative (no missed-poll grace), and a same-id
// identity change is a new conversation — every request in flight for the
// old one must then be a no-op, even when file, start and cursor coincide.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, type VueWrapper } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineComponent, getCurrentInstance, h, nextTick, shallowRef } from 'vue'
import { getQuery } from 'h3'
import { UApp } from '#components'
import ChatView from '~/components/ChatView.vue'
import { cachedAt, eventsOpen, herdrState, locked, netDown } from '~/composables/useHerdr'
import { saveChat, touchChat } from '~/utils/offlineCache'
import type { ChatItem, Pane } from '#shared/types'

const SAVED: ChatItem[] = [{ role: 'user', text: 'kept tail item', ts: '2026-01-01T00:00:00Z' }]
const LIVE: ChatItem[] = [
  { role: 'user', text: 'live question', ts: '2026-01-01T00:00:10Z' },
  { role: 'assistant', text: 'live reply', ts: '2026-01-01T00:00:11Z' },
]
const NEW: ChatItem[] = [{ role: 'assistant', text: 'new conversation reply', ts: '2026-01-02T00:00:00Z' }]
const PAGE: ChatItem[] = [{ role: 'user', text: 'stale older page', ts: '2025-12-31T00:00:00Z' }]
const PAGE2: ChatItem[] = [{ role: 'user', text: 'second older page', ts: '2025-12-30T00:00:00Z' }]
// A Command Code tool call: `toolId` lets a result appended later update the
// item already shown; the update's `at` is the outcome's revision.
const TOOL = (id: string, over: Partial<ChatItem> = {}): ChatItem =>
  ({ role: 'tool', text: 'run suite', name: 'Bash', ts: '2026-01-01T00:00:30Z', toolId: id, ...over })
// The last list passed to saveChat is the whole shown conversation.
const savedTool = (id: string): ChatItem | undefined => {
  const calls = vi.mocked(saveChat).mock.calls
  const items = calls.length ? calls[calls.length - 1]![1] : []
  return items.find(i => i.toolId === id)
}

// The kept tail (readChat/saveChat/touchChat): reads can be held, writes are
// observed, the store itself stays inspectable.
const cache = vi.hoisted(() => ({
  kept: new Map<string, { id: string, items: ChatItem[], at: number }>(),
  reads: [] as string[],
  gate: Promise.resolve() as Promise<void>,
}))
vi.mock('~/utils/offlineCache', async (importOriginal) => {
  const orig = await importOriginal<typeof import('~/utils/offlineCache')>()
  return {
    ...orig,
    readChat: vi.fn(async (id: string) => {
      cache.reads.push(id)
      await cache.gate
      return cache.kept.get(id) || null
    }),
    saveChat: vi.fn((id: string, items: ChatItem[]) => { cache.kept.set(id, { id, items, at: Date.now() }) }),
    touchChat: vi.fn(),
  }
})
const holdReads = () => {
  let release!: () => void
  cache.gate = new Promise<void>((resolve) => { release = resolve })
  return release
}

type Reply = Record<string, unknown>
const HOLD = Symbol('hold')
type Held = { q: Record<string, string>, resolve: (r: Reply) => void, reject: (e: Error) => void }
const held: Held[] = []
let requests = 0
const live = (extra: Reply = {}): Reply => ({ available: true, file: 's.jsonl', token: 't1', start: 0, items: LIVE, ...extra })
let answer: (q: Record<string, string>) => Reply | typeof HOLD = () => live()
registerEndpoint('/api/chat', (e) => {
  requests++
  const q = getQuery(e) as Record<string, string>
  const a = answer(q)
  if (a === HOLD) return new Promise<Reply>((resolve, reject) => held.push({ q, resolve, reject }))
  return a
})

const cmd: Pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'cmd', name: null, label: null, status: 'idle', title: null, cwd: '/home/user/demo', agentSession: 's1', bornAt: 1000 }
const claude: Pane = { ...cmd, id: 'w1:p2', agent: 'claude', agentSession: 'c1', bornAt: 500 }

const current = shallowRef<Pane>(cmd)
const searchOpen = shallowRef(false)
const mounted: VueWrapper[] = []
async function mountChat(pane: Pane) {
  current.value = pane
  searchOpen.value = false
  herdrState.value = { ok: true, session: 'core-a', workspaces: [], panes: [pane] }
  const Host = defineComponent({
    render: () => h(UApp, null, () => h(ChatView, {
      pane: current.value,
      localQueued: [],
      search: searchOpen.value,
      'onUpdate:search': (v: boolean) => { searchOpen.value = v },
    })),
  })
  const w = await mountSuspended(Host)
  mounted.push(w)
  const push = async (next: Pane) => { current.value = next; await nextTick(); await flushPromises() }
  const text = () => w.find('.chat').text()
  return { w, push, text }
}
const settle = async () => { await flushPromises(); await nextTick() }
const loadEarlier = (w: VueWrapper) => w.find('.chat-more button').trigger('click')
const scrollTop = (w: VueWrapper) => w.find('.chat').element.dispatchEvent(new Event('scroll'))

describe('Command Code conversation identity', () => {
  beforeEach(() => {
    requests = 0
    held.length = 0
    cache.kept.clear()
    cache.reads.length = 0
    cache.gate = Promise.resolve()
    vi.mocked(saveChat).mockClear()
    vi.mocked(touchChat).mockClear()
    localStorage.setItem('wherdr-offline-access', JSON.stringify({ enabled: true, expiresAt: Date.now() + 3_600_000 }))
    answer = () => live()
  })
  afterEach(() => {
    for (const w of mounted.splice(0)) w.unmount()
    for (const h of held.splice(0)) h.resolve({ available: false, reason: 'unsupported' })
    vi.useRealTimers()
    answer = () => live()
    cache.gate = Promise.resolve()
    cachedAt.value = null
    locked.value = false
    netDown.value = false
    eventsOpen.value = false
    herdrState.value = { ok: false, workspaces: [], panes: [] }
    localStorage.clear()
  })

  it('restores a kept tail for a legacy agent but never for Command Code online', async () => {
    answer = () => HOLD
    cache.kept.set('w1:p2', { id: 'w1:p2', items: SAVED, at: 1 })
    const a = await mountChat(claude)
    await expect.poll(a.text).toContain('kept tail item')
    held.shift()?.resolve(live({ file: 'c.jsonl' }))
    await expect.poll(a.text).toContain('live reply')
    a.w.unmount()

    cache.kept.set('w1:p1', { id: 'w1:p1', items: SAVED, at: 1 })
    cache.reads.length = 0
    const b = await mountChat(cmd)
    await settle()
    // The snapshot is not even opened, and nothing of it flashes on screen.
    expect(cache.reads).not.toContain('w1:p1')
    expect(b.text()).not.toContain('kept tail item')
    held.shift()?.resolve(live())
    await expect.poll(b.text).toContain('live reply')
  })

  it('does not paint a kept tail read while offline once the pane is back online', async () => {
    answer = () => HOLD
    cachedAt.value = 1 // explicit offline view: the passkey policy allows the read
    cache.kept.set('w1:p1', { id: 'w1:p1', items: SAVED, at: 1 })
    const release = holdReads()
    const a = await mountChat(cmd)
    await settle()
    expect(cache.reads).toEqual(['w1:p1'])
    cachedAt.value = null // back online while the read is still in flight
    release()
    await settle()
    expect(a.text()).not.toContain('kept tail item')
    expect(touchChat).not.toHaveBeenCalled()
    held.shift()?.resolve(live())
    await expect.poll(a.text).toContain('live reply')
  })

  it('does not paint a kept tail whose passkey lease was revoked while reading', async () => {
    answer = () => HOLD
    cache.kept.set('w1:p2', { id: 'w1:p2', items: SAVED, at: 1 })
    const release = holdReads()
    const a = await mountChat(claude)
    await settle()
    expect(cache.reads).toEqual(['w1:p2'])
    localStorage.removeItem('wherdr-offline-access') // lease revoked mid-read
    release()
    await settle()
    expect(a.text()).not.toContain('kept tail item')
    expect(touchChat).not.toHaveBeenCalled()
    held.shift()?.resolve(live())
    await expect.poll(a.text).toContain('live reply')
  })

  it('shows the kept tail for Command Code in an explicit offline view', async () => {
    answer = () => HOLD
    cachedAt.value = 1
    cache.kept.set('w1:p1', { id: 'w1:p1', items: SAVED, at: 1 })
    const a = await mountChat(cmd)
    await expect.poll(a.text).toContain('kept tail item')
    expect(touchChat).toHaveBeenCalledWith('w1:p1')
  })

  it('clears an unvalidated cached Command Code view when it comes back online', async () => {
    answer = () => HOLD
    cachedAt.value = 1
    cache.kept.set('w1:p1', { id: 'w1:p1', items: SAVED, at: 1 })
    const a = await mountChat(cmd)
    await expect.poll(a.text).toContain('kept tail item')
    const before = requests
    cachedAt.value = null
    await settle()
    // The unvalidated view is dropped and a fresh identity is requested —
    // nothing passes for the live conversation while the answer is out.
    expect(a.text()).not.toContain('kept tail item')
    expect(requests).toBeGreaterThan(before)
    for (const h of held.splice(0)) h.resolve(live())
    await expect.poll(a.text).toContain('live reply')
    // The authorized snapshot itself was never deleted.
    expect(cache.kept.get('w1:p1')).toBeTruthy()
  })

  it('clears a Command Code conversation on the first unavailable and keeps its snapshot', async () => {
    const a = await mountChat(cmd)
    await expect.poll(a.text).toContain('live reply')
    cache.kept.set('w1:p1', { id: 'w1:p1', items: SAVED, at: 1 })
    answer = () => ({ available: false, reason: 'unsupported' })
    await a.push({ ...cmd, preview: 'x' })
    await expect.poll(a.text).toContain('Conversation unavailable')
    expect(a.text()).not.toContain('live reply')
    // Unavailable is not a wipe: the authorized offline snapshot stays.
    expect(cache.kept.get('w1:p1')).toBeTruthy()
  })

  it('keeps a legacy conversation through the first unavailable replies', async () => {
    const a = await mountChat(claude)
    await expect.poll(a.text).toContain('live reply')
    answer = () => ({ available: false, reason: 'not_found' })
    await a.push({ ...claude, preview: 'x' })
    await a.push({ ...claude, preview: 'y' })
    await settle()
    expect(a.text()).toContain('live reply')
  })

  it('clears Command Code on an older-page unavailable; a legacy agent is untouched', async () => {
    answer = q => q.before ? HOLD : live({ start: 500 })
    const a = await mountChat(cmd)
    await expect.poll(a.text).toContain('live reply')
    await loadEarlier(a.w)
    await settle()
    held.shift()?.resolve({ available: false, reason: 'unsupported' })
    await expect.poll(a.text).toContain('Conversation unavailable')
    expect(a.text()).not.toContain('live reply')

    answer = q => q.before ? HOLD : live({ file: 'c.jsonl', start: 500 })
    const b = await mountChat(claude)
    await expect.poll(b.text).toContain('live reply')
    await loadEarlier(b.w)
    await settle()
    held.shift()?.resolve({ available: false, reason: 'not_found' })
    await settle()
    expect(b.text()).toContain('live reply')
  })

  it.each([
    ['agent', { agent: 'claude' }],
    ['agent session', { agentSession: 's2' }],
    ['process start', { bornAt: 2000 }],
    ['working directory', { cwd: '/home/user/other' }],
    ['core address', { coreAddress: '/tmp/other/hc.sock' }],
  ])('resets and reloads at once when the same-id %s changes', async (_field, patch) => {
    answer = q => (q.since ? { available: true, unchanged: true } : live())
    const a = await mountChat(cmd)
    await expect.poll(a.text).toContain('live reply')
    const before = requests
    answer = q => (q.since ? { available: true, unchanged: true } : live({ file: 's2.jsonl', token: 't2', items: NEW }))
    await a.push({ ...cmd, ...patch })
    await expect.poll(a.text).toContain('new conversation reply')
    expect(requests).toBeGreaterThan(before) // reloaded at once, no poll waited
    expect(a.text()).not.toContain('live reply')
  })

  it('does not reset on a new pane object, title, status or preview', async () => {
    const a = await mountChat(cmd)
    await expect.poll(a.text).toContain('live reply')
    // A false reset would read fresh again and paint the new conversation.
    answer = q => (q.since ? { available: true, unchanged: true } : live({ items: NEW }))
    await a.push({ ...cmd, title: 'retitled', status: 'working', preview: 'still here' })
    await settle()
    expect(a.text()).toContain('live reply')
    expect(a.text()).not.toContain('new conversation reply')
  })

  it('drops a late older page of the previous identity, even with the same file and cursor', async () => {
    answer = q => q.before ? HOLD : live({ start: 500 })
    const a = await mountChat(cmd)
    await expect.poll(a.text).toContain('live reply')
    await loadEarlier(a.w)
    await settle()
    const oldPage = held.shift()! // before=500 still in flight
    // Same file, same cursor — only the identity changed. The new tail must
    // actually be loaded before the late page lands.
    answer = q => q.before ? HOLD : (q.since ? { available: true, unchanged: true } : live({ start: 500, token: 't2', items: NEW }))
    await a.push({ ...cmd, bornAt: 2000 })
    await expect.poll(a.text).toContain('new conversation reply')
    await loadEarlier(a.w)
    await settle()
    const newPage = held.shift()!
    oldPage.resolve({ available: true, older: true, file: 's.jsonl', items: PAGE, start: 100 })
    await settle()
    expect(a.text()).not.toContain('stale older page')
    // Its cleanup must not free the new request either: still busy, no third call.
    scrollTop(a.w)
    await settle()
    expect(held.length).toBe(0)
    newPage.resolve({ available: true, older: true, file: 's.jsonl', items: PAGE2, start: 0 })
    await expect.poll(a.text).toContain('second older page')
  })

  it('a late older-page error of the previous identity toasts nothing and keeps the busy flag', async () => {
    answer = q => q.before ? HOLD : live({ start: 500 })
    const a = await mountChat(cmd)
    await expect.poll(a.text).toContain('live reply')
    await loadEarlier(a.w)
    await settle()
    const oldPage = held.shift()!
    answer = q => q.before ? HOLD : (q.since ? { available: true, unchanged: true } : live({ start: 500, token: 't2', items: NEW }))
    await a.push({ ...cmd, bornAt: 2000 })
    await expect.poll(a.text).toContain('new conversation reply')
    // The new conversation's own older request is already in flight — the
    // busy flag belongs to it now.
    await loadEarlier(a.w)
    await settle()
    const newPage = held.shift()!
    oldPage.reject(new Error('stale failure'))
    await settle()
    expect(document.body.textContent).not.toContain('stale failure')
    scrollTop(a.w)
    await settle()
    expect(held.length).toBe(0)
    newPage.resolve({ available: true, older: true, file: 's.jsonl', items: PAGE2, start: 0 })
    await expect.poll(a.text).toContain('second older page')
  })

  it('a reply applied while the pane moves cannot save or mark-rendered the new conversation', async () => {
    const paneB: Pane = { ...cmd, id: 'w1:p9', agentSession: 's9', bornAt: 9000 }
    const moved = shallowRef<Pane>(cmd)
    herdrState.value = { ok: true, session: 'core-a', workspaces: [], panes: [cmd, paneB] }
    // The pane flips inside the update painted by the old reply's apply() —
    // after update(), before apply() resumes past nextTick.
    let flipped = false
    const flip = {
      updated() {
        const el = (getCurrentInstance()?.proxy?.$el ?? null) as HTMLElement | null
        if (flipped || !el?.textContent?.includes('live question')) return
        flipped = true
        moved.value = paneB
      },
    }
    const Host = defineComponent({ render: () => h(UApp, null, () => h(ChatView, { pane: moved.value, localQueued: [] })) })
    answer = () => HOLD
    const w = await mountSuspended(Host, { global: { mixins: [flip] } })
    mounted.push(w)
    await settle()
    const first = held.shift()! // the mount's tail read
    first.resolve(live())
    await expect.poll(() => flipped).toBe(true)
    await settle()
    // The old generation's completion saves nothing under the pane it captured…
    expect(vi.mocked(saveChat).mock.calls.every(c => c[0] !== 'w1:p1')).toBe(true)
    // …and never marked the incoming conversation rendered: its delayed
    // skeleton stays armed (a completed apply would have cleared the flag).
    await expect.poll(() => w.find('.chat-list').classes(), { timeout: 1500 }).toContain('skeleton')
    held.shift()?.resolve(live({ file: 'b.jsonl', token: 't9', items: NEW }))
    await expect.poll(() => w.find('.chat').text()).toContain('new conversation reply')
    expect(w.find('.chat').text()).not.toContain('live question')
  })

  it('a search loading all older pages stops at a reset instead of continuing the new conversation', async () => {
    answer = q => q.before ? HOLD : live({ start: 500 })
    const a = await mountChat(cmd)
    await expect.poll(a.text).toContain('live reply')
    // A real search: the bar opens, a query debounces, loadAllOlder walks up.
    searchOpen.value = true
    await settle()
    vi.useFakeTimers() // before the input: its debounce must arm on this clock
    await a.w.find('.search-bar input').setValue('needle')
    await vi.advanceTimersByTimeAsync(300) // past the 250 ms input debounce
    expect(held.length).toBe(1)
    const first = held.shift()! // the chain's before=500 request, in flight
    vi.useRealTimers()
    // Reset mid-search — the new conversation still has older pages (cursor 300).
    answer = q => q.before ? HOLD : (q.since ? { available: true, unchanged: true } : live({ start: 300, token: 't2', items: NEW }))
    await a.push({ ...cmd, bornAt: 2000 })
    await expect.poll(a.text).toContain('new conversation reply')
    first.resolve({ available: true, older: true, file: 's.jsonl', items: PAGE, start: 400 })
    await settle()
    // The stale chain must not issue the new conversation's next page request.
    expect(held.length).toBe(0)
    expect(a.text()).not.toContain('stale older page')
  })

  it.each<[string, Reply, 'success' | 'error']>([
    ['a file change', { file: 's2.jsonl' }, 'success'],
    ['a same-file rewrite', { rewritten: true }, 'error'],
  ])('a server reset during an older request frees it: %s without any pane change', async (_why, reset, oldOutcome) => {
    answer = q => q.before ? HOLD : live({ start: 500 })
    const a = await mountChat(cmd)
    await expect.poll(a.text).toContain('live reply')
    await loadEarlier(a.w)
    await settle()
    const oldPage = held.shift()! // before=500 of the old generation, in flight
    // The tail itself reports the reset — no pane-identity change at all. The
    // fresh retry paints the new conversation with the same numeric cursor.
    answer = q => q.before ? HOLD
      : q.since === 't1' ? live({ ...reset, token: 't2' })
      : live({ file: reset.file ?? 's.jsonl', token: 't2', start: 500, items: NEW })
    await a.push({ ...cmd, preview: 'x' })
    await expect.poll(a.text).toContain('new conversation reply')
    expect(a.text()).not.toContain('live reply')
    // The old request's busy flag ended with the reset: a new older request
    // starts at once — same before=500 on the wire, a distinct generation.
    await loadEarlier(a.w)
    await settle()
    expect(held.length).toBe(1)
    const newPage = held.shift()!
    expect(newPage.q.before).toBe('500')
    // The old generation's end — success or error — changes none of it: no
    // stale page, no toast, and the still-held new request stays busy.
    if (oldOutcome === 'error') oldPage.reject(new Error('stale failure'))
    else oldPage.resolve({ available: true, older: true, file: 's.jsonl', items: PAGE, start: 100 })
    await settle()
    expect(a.text()).not.toContain('stale older page')
    expect(document.body.textContent).not.toContain('stale failure')
    expect(held.length).toBe(0)
    newPage.resolve({ available: true, older: true, file: reset.file ?? 's.jsonl', items: PAGE2, start: 0 })
    await expect.poll(a.text).toContain('second older page')
  })

  it('applies a late outcome to a tool on an older page, and an empty one clears it', async () => {
    answer = q => q.before
      ? { available: true, older: true, file: 's.jsonl', items: [TOOL('call-1')], start: 0 }
      : live({ start: 500 })
    const a = await mountChat(cmd)
    await expect.poll(a.text).toContain('live reply')
    await loadEarlier(a.w)
    await expect.poll(a.text).toContain('run suite')
    // The result lands on the tail reply while the call sits on the older page.
    answer = q => q.before ? HOLD
      : q.since ? live({ start: 500, keep: 2, items: [], toolUpdates: [{ id: 'call-1', at: 900, out: 'tool output', error: true, images: 1, ref: '40:70' }] })
      : live({ start: 500 })
    await a.push({ ...cmd, preview: 'x' })
    await expect.poll(() => a.w.find('.tool.err').exists()).toBe(true)
    expect(a.w.find('.tool-thumbs').exists()).toBe(true)
    expect(savedTool('call-1')).toMatchObject({ out: 'tool output', error: true, images: 1, ref: '40:70', toolAt: 900 })
    // A newer empty success is a full clear: output, error and image all go.
    answer = q => q.before ? HOLD
      : q.since ? live({ start: 500, keep: 2, items: [], toolUpdates: [{ id: 'call-1', at: 1000, out: '', error: false, images: 0, ref: '', imageAt: 0 }] })
      : live({ start: 500 })
    await a.push({ ...cmd, preview: 'y' })
    await expect.poll(() => a.w.find('.tool.err').exists()).toBe(false)
    expect(a.w.find('.tool-thumbs').exists()).toBe(false)
    const cleared = savedTool('call-1')
    expect(cleared?.toolAt).toBe(1000)
    expect(cleared?.out).toBeUndefined()
    expect(cleared?.error).toBeUndefined()
    expect(cleared?.images).toBeUndefined()
    expect(cleared?.ref).toBeUndefined()
    expect(cleared?.imageAt).toBeUndefined()
  })

  it.each<[string, Reply]>([
    ['none', {}],
    ['an older revision', { toolUpdates: [{ id: 'call-9', at: 500, out: 'stale page outcome' }] }],
  ])('remembers a result while its call page is in flight and applies it on arrival (page carries %s)', async (_why, pageExtra) => {
    answer = q => q.before ? HOLD
      : q.since ? live({ start: 500, keep: 2, items: [], toolUpdates: [{ id: 'call-9', at: 900, out: 'pending result', images: 1, ref: '40:70' }] })
      : live({ start: 500 })
    const a = await mountChat(cmd)
    await expect.poll(a.text).toContain('live reply')
    // The page request goes out FIRST — held, call-9 still unseen.
    await loadEarlier(a.w)
    await settle()
    const page = held.shift()!
    expect(page.q).toMatchObject({ before: '500', since: 't1' })
    // …then the result lands on the tail reply: pending, no call on screen.
    await a.push({ ...cmd, preview: 'x' })
    await settle()
    // Whether the page brings no update or an older one, the remembered
    // newest outcome fills its call — never the stale revision.
    page.resolve({ available: true, older: true, file: 's.jsonl', items: [TOOL('call-9')], start: 100, ...pageExtra })
    await expect.poll(a.text).toContain('run suite')
    expect(a.w.find('.tool-thumbs').exists()).toBe(true)
    expect(savedTool('call-9')).toMatchObject({ out: 'pending result', images: 1, toolAt: 900 })
  })

  it('sends the tail token on Command Code before requests — never on a legacy one', async () => {
    answer = q => q.before ? HOLD : live({ start: 500 })
    const a = await mountChat(cmd)
    await expect.poll(a.text).toContain('live reply')
    await loadEarlier(a.w)
    await settle()
    expect(held.shift()!.q).toEqual({ pane: 'w1:p1', before: '500', since: 't1' })
    a.w.unmount()
    mounted.length = 0
    const b = await mountChat({ ...claude })
    await expect.poll(b.text).toContain('live reply')
    await loadEarlier(b.w)
    await settle()
    expect(held.shift()!.q).toEqual({ pane: 'w1:p2', before: '500' })
  })

  it('a current-bottom reply to a before request resets — never prepended as history', async () => {
    answer = q => q.before ? HOLD : live({ start: 500 })
    const a = await mountChat(cmd)
    await expect.poll(a.text).toContain('live reply')
    // A real older page is already part of the shown history.
    await loadEarlier(a.w)
    await settle()
    held.shift()!.resolve({ available: true, older: true, file: 's.jsonl', items: PAGE, start: 100 })
    await expect.poll(a.text).toContain('stale older page')
    // The next page request is answered with the fresh bottom, not a page.
    await loadEarlier(a.w)
    await settle()
    const page = held.shift()!
    expect(page.q.before).toBe('100')
    answer = () => HOLD // the reset retry must surface as a request, not a splice
    page.resolve({ available: true, file: 's.jsonl', token: 't2', items: [{ role: 'assistant', text: 'supplied bottom', ts: '2026-01-02T00:00:01Z' }] })
    await expect.poll(() => held.length).toBe(1)
    const retry = held.shift()!
    expect(retry.q.before).toBeUndefined() // a genuine new tail read
    retry.resolve(live({ token: 't2', items: NEW }))
    await expect.poll(a.text).toContain('new conversation reply')
    // Neither the supplied bottom nor the dropped history survives the reset.
    expect(a.text()).not.toContain('supplied bottom')
    expect(a.text()).not.toContain('stale older page')
  })

  it('drops remembered outcomes when the conversation resets', async () => {
    answer = q => q.before ? HOLD
      : q.since ? live({ start: 500, keep: 2, items: [], toolUpdates: [{ id: 'call-9', at: 900, out: 'stale pending' }] })
      : live({ start: 500 })
    const a = await mountChat(cmd)
    await expect.poll(a.text).toContain('live reply')
    // Remembered with the old conversation — its call never showed.
    await a.push({ ...cmd, preview: 'x' })
    await settle()
    answer = q => q.before ? HOLD
      : q.since ? { available: true, unchanged: true }
      : live({ start: 500, token: 't2', items: [TOOL('call-9'), ...NEW] })
    await a.push({ ...cmd, bornAt: 2000 })
    await expect.poll(a.text).toContain('run suite')
    // Same tool id in the new file: the old outcome must not be inherited.
    const t = savedTool('call-9')
    expect(t?.out).toBeUndefined()
    expect(t?.toolAt).toBeUndefined()
    expect(a.w.find('.tool.err').exists()).toBe(false)
  })

  it('keeps the shown Command Code conversation on a transport read error', async () => {
    answer = () => live({ start: 500, items: [TOOL('call-1', { error: true, out: 'kept output' }), ...LIVE] })
    const a = await mountChat(cmd)
    await expect.poll(a.text).toContain('run suite')
    answer = () => { throw new Error('read failed') }
    await a.push({ ...cmd, preview: 'x' })
    await settle()
    // Not unavailable, not cleared: the shown outcome and history stay.
    expect(a.text()).toContain('live reply')
    expect(a.text()).toContain('run suite')
    expect(a.text()).not.toContain('Conversation unavailable')
    expect(a.w.find('.tool.err').exists()).toBe(true)
  })
})
