// A menu left open in the agent's terminal (Claude's /status during a turn)
// holds messages back with no card in the conversation: a notice says so and
// offers to close it or to send anyway.
import { afterEach, describe, expect, it } from 'vitest'
import { readBody } from 'h3'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ChatView from '~/components/ChatView.vue'
import { herdrState } from '~/composables/useHerdr'
import type { Pane } from '#shared/types'
import { checkQueue, publicEntry, type QueueEntry } from '../../server/utils/queued'

let available = true
registerEndpoint('/api/chat', () => ({ available, reason: available ? undefined : 'not_found', token: 'menu-left', file: '/tmp/demo/transcript.jsonl', items: [{ role: 'user', text: 'Write the release notes.', ts: '2026-01-01T00:00:00Z' }] }))
const calls: unknown[] = []
registerEndpoint('/api/menu-left', { method: 'POST', handler: async (event) => { calls.push(await readBody(event)); return { ok: true, closed: true, sent: 1 } } })

registerEndpoint('/api/send-now', { method: 'POST', handler: async (event) => { calls.push(await readBody(event)); return { ok: true } } })

registerEndpoint('/api/clear-queued-input', { method: 'POST', handler: async (event) => { calls.push(await readBody(event)); return { ok: true } } })

const base: Pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'working', title: null, cwd: '/tmp/demo', agentSession: null }
const queued = [{ id: 'm1', text: 'Also update the changelog.', at: Date.now(), state: 'held' as const, reason: 'turn' as const }]

async function mount(pane: Pane) {
  herdrState.value = { ok: true, workspaces: [], panes: [pane] }
  const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] } })
  await expect.poll(() => w.find('.chat').text()).toContain('Also update the changelog.')
  return w
}

describe('menu left open in the terminal', () => {
  afterEach(() => { available = true; calls.length = 0; herdrState.value = { ok: false, workspaces: [], panes: [] } })

  it('says the menu is still open and closes it, or sends anyway', async () => {
    const w = await mount({ ...base, queued, menuLeftOpen: true })
    try {
      const notice = w.find('.menu-left')
      expect(notice.exists()).toBe(true)
      expect(notice.text()).toContain('A menu is still open in the agent’s terminal')
      const [close, send] = notice.findAll('button')
      expect(close!.text()).toBe('Close menu')
      expect(send!.text()).toBe('Send anyway')
      await close!.trigger('click')
      await expect.poll(() => calls.length).toBe(1)
      await expect.poll(() => (send!.element as HTMLButtonElement).disabled).toBe(false)
      await send!.trigger('click')
      await expect.poll(() => calls.length).toBe(2)
      expect(calls).toEqual([{ pane_id: 'w1:p1', action: 'close' }, { pane_id: 'w1:p1', action: 'send' }])
    } finally { w.unmount() }
  })

  it('says nothing when no menu hides the field', async () => {
    const w = await mount({ ...base, queued })
    try {
      expect(w.find('.menu-left').exists()).toBe(false)
    } finally { w.unmount() }
  })

  it('leaves the waiting explanation to the open menu on a blocked agent', async () => {
    const w = await mount({ ...base, status: 'blocked', queued, menu: {
      title: 'Hooks', items: [], lines: [], actions: [{ key: 'esc', label: 'cancel' }],
      cursor: null, search: null, more: null,
    } })
    try {
      expect(w.find('.chat-status.waiting').exists()).toBe(false)
      expect(w.find('.chat-empty.waiting').exists()).toBe(false)
      // An unrecognized blocked screen still needs its terminal hint.
      await w.setProps({ pane: { ...base, status: 'blocked', queued } })
      expect(w.find('.chat-status.waiting').text()).toContain('Waiting for your reply')
    } finally { w.unmount() }
  })


  it('shows only one waiting hint when a transcript is not available yet', async () => {
    available = false
    const w = await mount({ ...base, id: 'w1:p2', status: 'blocked', queued, screen: {
      kind: 'other', title: null, lines: ['Waiting for input'], actions: [],
    } })
    try {
      await expect.poll(() => w.find('.chat-empty.waiting').exists()).toBe(true)
      expect(w.find('.chat-status.waiting').exists()).toBe(false)
    } finally { w.unmount() }
  })

})

describe('terminal draft blocking a message', () => {
  it('keeps the draft explanation and all actions after waiting through a long turn', async () => {
    const now = Date.now()
    const entry: QueueEntry = { id: 'm1', text: queued[0]!.text, at: now - 5 * 60_000, held: true, busy: true, turn: true, inputText: 'ns' }
    checkQueue([entry], 'idle', now)
    const w = await mount({ ...base, status: 'idle', queued: [publicEntry(entry)] })
    try {
      const tag = w.find('.queued-tag')
      expect(tag.classes()).not.toContain('failed')
      expect(tag.text()).toContain('Not sent: the agent’s input already contains text (“ns”)')
      expect(tag.findAll('button').map(b => b.text())).toEqual(['Clear and send', 'Open terminal', 'Cancel'])
    } finally { w.unmount() }
  })

  it('shows the draft, clear action and terminal action, then hides clear while working', async () => {
    const pane = { ...base, status: 'idle' as const, queued: [{ ...queued[0]!, reason: 'busy' as const, inputText: 'ns' }] }
    const w = await mount(pane)
    try {
      const tag = w.find('.queued-tag')
      expect(tag.text()).toContain('Not sent: the agent’s input already contains text (“ns”)')
      expect(tag.text()).toContain('Clear and send')
      const before = calls.length
      await tag.findAll('button').find(b => b.text() === 'Clear and send')!.trigger('click')
      await expect.poll(() => calls.length).toBe(before + 1)
      expect(calls.at(-1)).toEqual({ pane_id: pane.id, id: 'm1', input_text: 'ns' })
      await tag.findAll('button').find(b => b.text() === 'Open terminal')!.trigger('click')
      expect(w.emitted('gotoTerm')).toHaveLength(1)
      await w.setProps({ pane: { ...pane, status: 'working' } })
      expect(w.find('.queued-tag').text()).not.toContain('Clear and send')
      expect(w.find('.queued-tag').text()).toContain('Queued')
      expect(w.find('.queued-tag').text()).not.toContain('ns')
    } finally { w.unmount() }
  })
})


describe('native queue send now', () => {
  it('offers one action for the whole native queue and sends the shortcut request', async () => {
    calls.length = 0
    const pane = { ...base, queued, claudeScreen: { shell: null, sent: null, queued: [queued[0]!.text], sendNow: true } }
    const w = await mount(pane)
    try {
      const buttons = () => w.findAll('button').filter(b => b.text() === 'Send now')
      expect(buttons()).toHaveLength(1)
      await buttons()[0]!.trigger('click')
      await expect.poll(() => calls.length).toBe(1)
      expect(calls[0]).toEqual({ pane_id: base.id })
      for (const p of [{ ...pane, claudeScreen: undefined }, { ...pane, agent: 'codex' }, { ...pane, status: 'idle' as const }]) {
        await w.setProps({ pane: p })
        expect(buttons()).toHaveLength(0)
      }
    } finally { w.unmount(); calls.length = 0 }
  })
})
