// A file attached on herdr-core (v3) shows in the sent message as a chip
// (icon, name without the date prefix), not as its raw path line.
import { afterEach, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ChatView from '~/components/ChatView.vue'
import { herdrState } from '~/composables/useHerdr'
import type { ChatItem, Pane } from '#shared/types'

const pane: Pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '/tmp/demo', agentSession: null }
const path = '/home/user/.local/state/herdr-core/default/files/t1/2026-01-01T09-00-00-000Z-a1b2c3-report.md'
const items: ChatItem[] = [
  { role: 'user', text: `Read this\n@${path}`, ts: '2026-01-01T09:00:00Z' },
  { role: 'assistant', text: 'Done.', ts: '2026-01-01T09:00:05Z' },
]
registerEndpoint('/api/chat', () => ({ available: true, token: 'attachment-chip', file: '/tmp/demo/transcript.jsonl', items }))

afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] } })

it('renders a v3 attached file as a chip and drops its path line', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [pane] }
  const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] }, global: { stubs: { UTooltip: { template: '<slot />' } } } })
  try {
    await expect.poll(() => w.findAll('.msg-user-wrap').length).toBe(1)
    const msg = w.find('.msg-user-wrap')
    const chips = msg.findAll('.file-chip')
    expect(chips).toHaveLength(1)
    expect(chips[0]!.find('.file-chip-name').text()).toBe('report.md')
    expect(chips[0]!.find('.file-chip-icon .iconify, .file-chip-icon [class*="i-lucide"]').exists()).toBe(true)
    expect(msg.find('.msg-fold').text()).toBe('Read this')
    expect(msg.text()).not.toContain('herdr-core')
  } finally { w.unmount() }
})
