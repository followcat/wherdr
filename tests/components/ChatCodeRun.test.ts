// Run in a reply: the command shows at once as a live "You ran" card and the
// button says Running…; once the transcript writes it, its entry alone shows
// (no second card) and the button says when it ran.
import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ChatView from '~/components/ChatView.vue'
import { herdrState } from '~/composables/useHerdr'
import { codeRuns } from '~/composables/useCodeRun'
import type { ChatItem, Pane } from '#shared/types'

const CMD = 'CARGO_BUILD_JOBS=1 cargo build --release && systemctl --user restart demo'
const pane: Pane = { id: 'w1:p9', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'working', title: null, cwd: '/tmp/demo', agentSession: null }
const reply: ChatItem = { role: 'assistant', text: `Then run:\n\n1. **Backend**\n   \`\`\`\n   ! ${CMD}\n   \`\`\``, ts: '2026-01-01T00:00:00Z' }
let items: ChatItem[] = [reply]
registerEndpoint('/api/chat', () => ({ available: true, token: `code-run-${items.length}`, file: '/tmp/demo/t.jsonl', items, queue: [] }))

async function mount() {
  herdrState.value = { ok: true, workspaces: [], panes: [pane] }
  const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] } })
  await expect.poll(() => w.find('.chat').text()).toContain('Then run')
  return w
}

describe('Run from a reply', () => {
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] } })

  it('shows the run at once, then only the transcript entry', async () => {
    codeRuns.value = { [pane.id]: [{ cmd: CMD, at: Date.now() }] }
    const w = await mount()
    try {
      await expect.poll(() => w.findAll('.queued-list .omp-run.live').map(c => c.text())).toEqual([expect.stringContaining(CMD)])
      expect(w.find('.code-run').text()).toBe('Running…')
    } finally { w.unmount() }

    items = [reply, { role: 'bash', text: CMD, ts: new Date(Date.now() + 1000).toISOString(), out: 'Finished release', ms: 900 }]
    const v = await mount()
    try {
      await expect.poll(() => v.findAll('.omp-run').length).toBe(1)
      expect(v.find('.queued-list').exists()).toBe(false)
      expect(v.find('.code-run').text()).toBe('Run')
      expect(v.find('.code-ran').text()).toMatch(/^Ran at /)
    } finally { v.unmount() }
  })
})
