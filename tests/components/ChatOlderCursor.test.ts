import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ChatView from '~/components/ChatView.vue'
import { cachedAt, herdrState, locked, netDown } from '~/composables/useHerdr'
import type { ChatResponse, Pane } from '#shared/types'

// Scroll-back with Codex daemon cursors (server/utils/codexDaemon.ts) and JSONL byte offsets.
vi.mock('~/utils/offlineCache', () => ({ readChat: async () => null, saveChat: vi.fn(), touchChat: vi.fn() }))
const pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', agent: 'codex', status: 'idle', cwd: '/tmp/demo' } as Pane
const FILE = 'codex-daemon-thread-a.jsonl'
const TAIL = [{ role: 'user' as const, text: 'The latest question.', ts: null }, { role: 'assistant' as const, text: 'The tail reply keeps showing.', ts: null }]
let asks: Record<string, string>[] = []

afterEach(() => {
  herdrState.value = { ok: false, panes: [], workspaces: [] }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function mount(reply: (q: Record<string, string>) => ChatResponse) {
  locked.value = false; netDown.value = false; cachedAt.value = null
  herdrState.value = { ok: true, panes: [pane], workspaces: [] }
  asks = []
  vi.stubGlobal('fetch', vi.fn((path: string) => {
    if (!path.startsWith('/api/chat?')) return Promise.resolve(Response.json({}))
    const q = Object.fromEntries(new URLSearchParams(path.split('?')[1]))
    asks.push(q)
    return Promise.resolve(Response.json(reply(q)))
  }))
  const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] } })
  await expect.poll(() => w.find('.chat').text()).toContain('The tail reply keeps showing.')
  const older = () => w.findAll('button').find(b => b.text().includes('Load earlier messages'))
  return { w, older }
}
const tail = (token: string, start: number, opaque = true): ChatResponse =>
  ({ available: true, file: FILE, token, start, items: structuredClone(TAIL), ...(opaque ? { cursorKind: 'opaque' as const } : {}) })
const page = (start: number, text: string, opaque = true): ChatResponse =>
  ({ available: true, file: FILE, older: true, start, items: [{ role: 'user', text, ts: null }], ...(opaque ? { cursorKind: 'opaque' as const } : {}) })

it('reloads the tail when a daemon cursor expired, then pages from the new cursor', async () => {
  let expired = false
  const { w, older } = await mount((q) => {
    if (q.before && !expired) { expired = true; return { available: true, file: FILE, reload: true } }
    if (q.before) return page(0, 'The earlier question.')
    return tail(expired ? 'fresh-tail' : 'old-tail', expired ? 8 : 10)
  })
  try {
    await older()!.trigger('click')
    await expect.poll(() => asks.some(q => q.before === '10')).toBe(true)
    // The fresh tail read after the expired cursor: paging starts again from its cursor.
    await expect.poll(() => asks.findLastIndex(q => !q.before) > asks.findIndex(q => q.before === '10')).toBe(true)
    await expect.poll(() => older()?.attributes('disabled')).toBeUndefined()
    await older()!.trigger('click')
    await expect.poll(() => w.find('.chat').text()).toContain('The earlier question.')
    expect(asks.some(q => q.before === '8')).toBe(true)
    expect(w.find('.chat').text()).toContain('The tail reply keeps showing.')
  } finally { w.unmount() }
})

it('keeps paging when opaque daemon cursors increase, and stops a JSONL page at a later byte', async () => {
  const daemon = await mount(q => q.before === '1' ? page(2, 'The middle question.') : q.before === '2' ? page(0, 'The first question.') : tail('opaque-tail', 1))
  try {
    await daemon.older()!.trigger('click')
    await expect.poll(() => daemon.w.find('.chat').text()).toContain('The middle question.')
    await expect.poll(() => daemon.older()?.attributes('disabled')).toBeUndefined()
    await daemon.older()!.trigger('click')
    await expect.poll(() => daemon.w.find('.chat').text()).toContain('The first question.')
  } finally { daemon.w.unmount() }
  const jsonl = await mount(q => q.before ? page(20, 'A rewritten slice.', false) : tail('jsonl-tail', 10, false))
  try {
    await jsonl.older()!.trigger('click')
    await expect.poll(() => jsonl.w.find('.chat').text()).toContain('A rewritten slice.')
    expect(jsonl.older()).toBeUndefined()
    expect(asks.filter(q => q.before)).toHaveLength(1)
  } finally { jsonl.w.unmount() }
})

it('keeps its older-page cursor while the bound daemon is temporarily unavailable', async () => {
  let available = false
  const { w, older } = await mount(q => q.before
    ? available ? page(0, 'Recovered history.') : { available: true, file: FILE, stale: true, unchanged: true }
    : tail('pinned-tail', 10))
  try {
    await older()!.trigger('click')
    await expect.poll(() => asks.filter(q => q.before)).toHaveLength(1)
    await expect.poll(() => older()?.attributes('disabled')).toBeUndefined()
    available = true
    await older()!.trigger('click')
    await expect.poll(() => w.find('.chat').text()).toContain('Recovered history.')
    expect(asks.filter(q => q.before).map(q => q.before)).toEqual(['10', '10'])
  } finally { w.unmount() }
})
