// The end of a conversation kept on this device shows at once, then the
// server's answer is reconciled with it: the blocks already shown keep their
// elements, and a reply that arrived meanwhile comes in as a live one would.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ChatView from '~/components/ChatView.vue'
import { cachedAt, eventsOpen, herdrState, locked, netDown } from '~/composables/useHerdr'
import { setOfflineAccess } from '~/utils/offlineAccess'
import { saveChat } from '~/utils/offlineCache'
import type { ChatItem, Pane } from '#shared/types'

const at = (m: number) => `2026-01-05T09:0${m}:00.000Z`
const kept: ChatItem[] = [
  { role: 'user', text: 'Add a theme choice to Settings.', ts: at(0) },
  { role: 'assistant', text: 'Done: System, Light and Dark.', ts: at(1) },
  { role: 'user', text: 'Add a note to the changelog.', ts: at(2) },
]
vi.mock('~/utils/offlineCache', () => ({
  readChat: async () => ({ id: 'w1:p1', items: kept, at: Date.parse(at(3)), file: 'demo.jsonl' }),
  saveChat: vi.fn(),
  touchChat: vi.fn(),
}))
const pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', agent: 'claude', status: 'idle', cwd: '/tmp/demo' } as Pane

let answer: (items: ChatItem[]) => void
beforeEach(() => {
  locked.value = false; netDown.value = false; cachedAt.value = null; eventsOpen.value = true
  herdrState.value = { ok: true, panes: [pane], workspaces: [] }
  setOfflineAccess({ enabled: false, expiresAt: 0 })
  vi.mocked(saveChat).mockClear()
  // The server answers when the test says so; its later re-reads change nothing.
  let first = true
  vi.stubGlobal('fetch', vi.fn((path: string) => {
    if (!path.startsWith('/api/chat?')) return Promise.resolve(Response.json({}))
    if (!first) return Promise.resolve(Response.json({ available: true, unchanged: true }))
    first = false
    return new Promise<Response>((resolve) => {
      answer = items => resolve(Response.json({ available: true, file: 'demo.jsonl', token: 't1', start: 0, items }))
    })
  }))
})
afterEach(() => {
  eventsOpen.value = false
  herdrState.value = { ok: false, panes: [], workspaces: [] }
  setOfflineAccess(null)
  vi.unstubAllGlobals()
})

const mount = () => mountSuspended(ChatView, { props: { pane, localQueued: [] }, global: { stubs: { UTooltip: { template: '<slot />' } } } })
const blocks = (w: { element: Element }) => new Map([...w.element.querySelectorAll<HTMLElement>('[data-hit-key]')].map(el => [el.textContent?.trim().slice(0, 30), el]))

it('shows the kept end before the server answers, and keeps every element when the answer is the same', async () => {
  const w = await mount()
  try {
    await expect.poll(() => w.text()).toContain('Add a note to the changelog.')
    const before = blocks(w)
    answer(kept.map(it => ({ ...it })))
    // Saved again once the answer is applied.
    await expect.poll(() => vi.mocked(saveChat).mock.calls.length).toBeGreaterThan(0)
    const after = blocks(w)
    expect([...after.keys()]).toEqual([...before.keys()])
    for (const [k, el] of after) expect(el, k).toBe(before.get(k))
    expect(w.find('.md-body.typing').exists()).toBe(false)
  } finally { w.unmount() }
})

it('keeps the blocks already shown when the answer starts lower, and types the reply that arrived meanwhile', async () => {
  const w = await mount()
  try {
    await expect.poll(() => w.text()).toContain('Add a note to the changelog.')
    const before = blocks(w)
    // The server's bottom starts one message later, with the agent's new reply under it.
    answer([...kept.slice(1), { role: 'assistant', text: 'Added under Unreleased.', ts: at(4) }].map(it => ({ ...it })))
    await expect.poll(() => w.text()).toContain('Added under Unreleased.')
    const after = blocks(w)
    const same = [...after.keys()].filter(k => before.has(k))
    expect(same.length).toBeGreaterThanOrEqual(2)
    for (const k of same) expect(after.get(k), k).toBe(before.get(k))
    expect(w.findAll('.md-body.typing')).toHaveLength(1)
    expect(w.find('.md-body.typing').text()).toBe('Added under Unreleased.')
  } finally { w.unmount() }
})
