// Messages sent while Claude works: "Queued by Claude" while its transcript
// still lists them in its queue. When a message counts as taken ("Read by the
// agent") is decided lower, in tests/pendingLabel.test.ts.
import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ChatView from '~/components/ChatView.vue'
import { herdrState } from '~/composables/useHerdr'
import type { ChatItem, ClaudeQueueEntry, Pane } from '#shared/types'

const ONE = 'Add a test for the parser too'
const TWO = 'And update the changelog'
const pane: Pane = { id: 'w1:p7', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'working', title: null, cwd: '/tmp/demo', agentSession: null }
const items: ChatItem[] = [{ role: 'user', text: 'Fix the page title', ts: '2026-01-01T00:00:00Z' }]
let queue: ClaudeQueueEntry[] = []
registerEndpoint('/api/chat', () => ({ available: true, token: 'queued-labels', file: '/tmp/demo/transcript.jsonl', items, queue }))
const sent = [
  { id: 'a', text: ONE, at: Date.now() - 2000, settledAt: Date.now() - 1900 },
  { id: 'b', text: TWO, at: Date.now() - 1000, settledAt: Date.now() - 900 },
]

async function tags(q: ClaudeQueueEntry[], p: Pane, expected: string[]) {
  queue = q
  herdrState.value = { ok: true, workspaces: [], panes: [p] }
  const w = await mountSuspended(ChatView, { props: { pane: p, localQueued: sent } })
  try {
    await expect.poll(() => w.find('.chat').text()).toContain('Fix the page title')
    await expect.poll(() => w.findAll('.queued-list .queued-tag').map(t => t.text())).toEqual(expected)
  } finally { w.unmount() }
}

describe('labels of messages sent while Claude works', () => {
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] } })

  it('still in Claude\'s queue: queued by Claude, not read', async () => {
    await tags([{ text: ONE, ts: '2026-01-01T00:00:01Z' }, { text: TWO, ts: '2026-01-01T00:00:02Z' }], pane,
      ['Queued by Claude · sent when it finishes', 'Queued by Claude · sent when it finishes'])
  })
})
