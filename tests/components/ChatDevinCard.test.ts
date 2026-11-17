// A Devin command card in the conversation: it comes with the reads of /api/chat,
// after the messages it follows, as a card and not as a message of the user.
import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ChatView from '~/components/ChatView.vue'
import { herdrState } from '~/composables/useHerdr'
import type { ChatItem, Pane } from '#shared/types'

const pane: Pane = { id: 'w1:devin', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'devin', name: null, label: null, status: 'idle', title: null, cwd: '/home/user/acme-shop', agentSession: null }
const at = (s: number) => `2026-11-17T03:19:${String(s).padStart(2, '0')}Z`
const CARD: ChatItem = {
  role: 'devinCard',
  text: 'Usage\nDaily 30% used · resets in 4h 39m',
  ts: at(30),
  card: {
    command: '/usage',
    kind: 'usage',
    windows: [{ label: 'Daily', percent: 30, reset: 'resets in 4h 39m' }],
    session: [],
    note: null,
  },
}
let items: ChatItem[] = []
registerEndpoint('/api/chat', () => ({ available: true, token: `t${items.length}`, file: '/home/user/acme-shop/session.db', start: 0, items }))

describe('Devin command cards in the conversation', () => {
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] } })

  it('shows the card after the messages before it, not as a message', async () => {
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    items = [
      { role: 'user', text: 'Reply with one word', ts: at(2) },
      { role: 'assistant', text: 'ok', ts: at(4) },
      CARD,
    ]
    const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] }, global: { stubs: { UTooltip: { template: '<slot />' } } } })
    await expect.poll(() => w.find('[data-testid="devin-card"]').exists()).toBe(true)
    expect(w.findAll('.msg-user')).toHaveLength(1)
    expect(w.find('[data-testid="devin-card"]').text()).toContain('Daily')
    expect(w.findAll('[data-testid="devin-card"]')).toHaveLength(1)
  })
})
