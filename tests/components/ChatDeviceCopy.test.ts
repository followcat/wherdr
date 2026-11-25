// Back to a conversation: what was sent or received before leaving shows at
// once from this device, before the server answers.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ChatView from '~/components/ChatView.vue'
import { eventsOpen, herdrState, locked, netDown } from '~/composables/useHerdr'
import { setOfflineAccess } from '~/utils/offlineAccess'
import { clearOffline, readChat } from '~/utils/offlineCache'
import type { OutboxItem } from '~/utils/outbox'
import type { ChatItem, Pane } from '#shared/types'

const pane = { id: 'w1:p9', workspace: 'w1', tab: 'w1:t1', agent: 'claude', status: 'working', cwd: '/tmp/demo' } as Pane
const first: ChatItem = { role: 'user', text: 'Rename the helper.', ts: '2026-01-05T09:00:00.000Z' }
const reply: ChatItem = { role: 'assistant', text: 'Renamed it.', ts: '2026-01-05T09:01:00.000Z' }
const full = { available: true, file: 'demo.jsonl', token: 't1', start: 0 }

// Answers in order, then "unchanged"; 'hang' never answers.
function server(...replies: (Record<string, unknown> | 'hang')[]) {
  vi.stubGlobal('fetch', vi.fn((path: string) => {
    if (!path.startsWith('/api/chat?')) return Promise.resolve(Response.json({}))
    const r = replies.shift() ?? { available: true, unchanged: true }
    return r === 'hang' ? new Promise<Response>(() => {}) : Promise.resolve(Response.json(r))
  }))
}
const mount = (localQueued: OutboxItem[] = [], p = pane) => mountSuspended(ChatView, { props: { pane: p, localQueued }, global: { stubs: { UTooltip: { template: '<slot />' } } } })

beforeEach(async () => {
  await clearOffline()
  locked.value = false; netDown.value = false; eventsOpen.value = true
  herdrState.value = { ok: true, panes: [pane], workspaces: [] }
  setOfflineAccess({ enabled: false, expiresAt: 0 })
})
afterEach(() => {
  eventsOpen.value = false
  herdrState.value = { ok: false, panes: [], workspaces: [] }
  setOfflineAccess(null)
  vi.unstubAllGlobals()
})

it('keeps a reply brought by a poll once the conversation is left', async () => {
  server({ ...full, items: [first] }, { ...full, token: 't2', items: [first, reply] })
  const w = await mount()
  await expect.poll(() => w.text()).toContain('Rename the helper.')
  await w.setProps({ pane: { ...pane, status: 'idle' } })
  await expect.poll(() => w.text()).toContain('Renamed it.')
  w.unmount()
  expect((await readChat(pane.id))?.items.map(i => i.text)).toEqual([first.text, reply.text])
})

it('shows a message the agent still holds on reopen, before the server answers', async () => {
  const queue = [{ text: 'Also update the docs.', ts: '2026-01-05T09:02:00.000Z' }]
  server({ ...full, items: [first], queue })
  const w = await mount()
  await expect.poll(() => w.text()).toContain('Also update the docs.')
  w.unmount()
  server('hang')
  const back = await mount()
  try { await expect.poll(() => back.text()).toContain('Also update the docs.') }
  finally { back.unmount() }
})

it('shows a message still in the outbox on reopen, before the server answers', async () => {
  server('hang')
  const w = await mount([{ id: 'w-1', text: 'Sent just before leaving.', at: Date.now(), state: 'sending' }])
  try { await expect.poll(() => w.text()).toContain('Sent just before leaving.') }
  finally { w.unmount() }
})
