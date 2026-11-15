// herdr-core, Claude: text left unsent in Claude's input box shows in the
// conversation as "Not sent" with Send now / Clear; Claude's queue gets Send now.
import { afterEach, describe, expect, it } from 'vitest'
import { readBody, setResponseStatus } from 'h3'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ChatView from '~/components/ChatView.vue'
import { herdrState } from '~/composables/useHerdr'
import type { Pane } from '#shared/types'

registerEndpoint('/api/chat', () => ({ available: true, token: 'unsent', file: '/tmp/demo/transcript.jsonl', items: [{ role: 'user', text: 'Write the release notes.', ts: '2026-01-01T00:00:00Z' }] }))
const calls: Record<string, unknown>[] = []
let started = true
// Set by a test to hold or fail the answer.
let answer: (() => Promise<unknown>) | null = null
registerEndpoint('/api/draft', { method: 'POST', handler: async (event) => {
  calls.push(await readBody(event))
  const r = answer ? await answer() : { ok: true, started }
  if ((r as { code?: string }).code) setResponseStatus(event, 409)
  return r
} })

const base: Pane = { id: 'core:t2', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '/tmp/demo', agentSession: null, coreAddress: 'local/t2' }

async function mount(pane: Pane) {
  herdrState.value = { ok: true, workspaces: [], panes: [pane] }
  const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] } })
  await expect.poll(() => w.find('.chat').text()).toContain('Write the release notes.')
  return w
}

describe('text left unsent in Claude’s input', () => {
  afterEach(() => { calls.length = 0; started = true; answer = null; herdrState.value = { ok: false, workspaces: [], panes: [] } })

  it('shows the text as not sent, and sends or clears it', async () => {
    const w = await mount({ ...base, draft: { text: 'Summarise the README.\nKeep it short.', lines: 2 } })
    try {
      const box = w.find('[data-testid="unsent-input"]')
      expect(box.text()).toContain('Summarise the README.')
      expect(box.find('.unsent-text').text()).toBe('Summarise the README.\nKeep it short.')
      expect(box.text()).toContain('Not sent — still in Claude’s input')
      const [send, clear] = box.findAll('button')
      expect(send!.text()).toContain('Send now')
      expect(clear!.text()).toContain('Clear')
      await clear!.trigger('click')
      await expect.poll(() => calls.length).toBe(1)
      await send!.trigger('click')
      await expect.poll(() => calls.length).toBe(2)
      // Sent, but the screen still shows the text: Clear waits too.
      expect(clear!.attributes('disabled')).toBeDefined()
      expect(calls).toEqual([
        { pane_id: 'core:t2', action: 'clear', text: 'Summarise the README.\nKeep it short.' },
        { pane_id: 'core:t2', action: 'send', text: 'Summarise the README.\nKeep it short.' },
      ])
    } finally { w.unmount() }
  })

  it('Send now for Claude’s queue: loading at once, one send, until the queue is taken', async () => {
    let release!: () => void
    answer = () => new Promise(r => { release = () => r({ ok: true }) })
    const w = await mount({ ...base, status: 'working', queueSendNow: true })
    try {
      expect(w.find('[data-testid="unsent-input"]').exists()).toBe(false)
      const btn = () => w.find('[data-testid="queue-send-now"]')
      await btn().trigger('click')
      await btn().trigger('click')
      expect(btn().attributes('disabled')).toBeDefined()
      expect(btn().find('.spin').exists()).toBe(true)
      await expect.poll(() => calls).toEqual([{ pane_id: 'core:t2', action: 'send-queued' }])
      release()
      // Answered, but the screen still shows the queue: still loading.
      await new Promise(r => setTimeout(r, 50))
      expect(btn().attributes('disabled')).toBeDefined()
      await w.setProps({ pane: { ...base, status: 'working' } })
      await expect.poll(() => btn().exists()).toBe(false)
      expect(calls).toHaveLength(1)
    } finally { w.unmount() }
  })

  it('a failed Send now says why under the message and can be tried again', async () => {
    answer = async () => ({ error: 'Claude’s input has changed — check the current screen.', code: 'stale' })
    const w = await mount({ ...base, draft: { text: 'Summarise the README.', lines: 1 } })
    try {
      const send = () => w.find('[data-testid="unsent-input"]').findAll('button')[0]!
      await send().trigger('click')
      await expect.poll(() => w.find('[data-testid="send-error"]').exists()).toBe(true)
      expect(w.find('[data-testid="send-error"]').text()).toBe('Not sent: Claude’s input has changed. Try again')
      expect(send().attributes('disabled')).toBeUndefined()
    } finally { w.unmount() }
  })

  it('nothing without a draft', async () => {
    const w = await mount(base)
    try {
      expect(w.find('[data-testid="unsent-input"]').exists()).toBe(false)
      expect(w.find('[data-testid="queue-send-now"]').exists()).toBe(false)
    } finally { w.unmount() }
  })
})
