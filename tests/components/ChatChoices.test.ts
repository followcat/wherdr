// `choices` buttons of a wherdr block (utils/markdown.ts): a tap sends the
// option quoted to the question; a card stays live until a sent message
// answers it, even under a later agent message (WHR-526); answered, or in a
// read-only conversation, it is greyed with the answer given pressed.
import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ChatView from '~/components/ChatView.vue'
import { cachedAt, herdrState } from '~/composables/useHerdr'
import type { ChatItem, Pane } from '#shared/types'

const pane: Pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '/tmp/demo', agentSession: null }
const block = (q: string) => `${q}\n\n\`\`\`wherdr\nchoices "Squash" | "Rebase"\n\`\`\``
const items: ChatItem[] = [
  { role: 'assistant', text: block('How shall I merge it?'), ts: '2026-01-01T09:00:00Z' },
  { role: 'user', text: 'Later.', ts: '2026-01-01T09:01:00Z' },
  { role: 'assistant', text: block('And the next one, how?'), ts: '2026-01-01T09:02:00Z' },
]
registerEndpoint('/api/chat', () => ({ available: true, token: `choices${items.length}`, file: '/tmp/demo/transcript.jsonl', items }))
const mount = () => mountSuspended(ChatView, { props: { pane, localQueued: [] }, global: { stubs: { UTooltip: { template: '<slot />' } } } })
const live = (el: { classes: () => string[], findAll: (s: string) => { element: Element }[] }) =>
  !el.classes().includes('done') && el.findAll('button').every(b => !b.element.hasAttribute('disabled'))

describe('choice buttons in the conversation', () => {
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] }; cachedAt.value = null })

  it('keeps a card live under a later agent message until a reply answers it', async () => {
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    let w = await mount()
    let sent = ''
    try {
      await expect.poll(() => w.findAll('.w-choices').length).toBe(2)
      const [old, last] = w.findAll('.w-choices')
      expect(live(old!)).toBe(true)
      expect(live(last!)).toBe(true)
      await old!.findAll('button')[1]!.trigger('click')
      sent = w.emitted('choose')?.[0]?.[0] as string
      // Quoted to the message (to its question in a browser: DOMPurify drops
      // the paragraph under happy-dom, see tests/markQuestions.test.ts).
      expect(sent.split('\n')).toEqual([expect.stringMatching(/^↳ Quote (?:point|message) .* : How shall I merge it\? —$/), 'Rebase'])
    } finally { w.unmount() }

    items.push({ role: 'user', text: sent, ts: '2026-01-01T09:03:00Z' })
    w = await mount()
    try {
      await expect.poll(() => w.findAll('.w-choices').length).toBe(2)
      const [old, last] = w.findAll('.w-choices')
      await expect.poll(() => old!.classes()).toContain('done')
      expect(old!.findAll('button').map(b => [b.element.hasAttribute('disabled'), b.attributes('aria-pressed')])).toEqual([[true, 'false'], [true, 'true']])
      expect(live(last!)).toBe(true)
    } finally { w.unmount() }
  }, 60000) // the file's first ChatView mount is slow when cold

  it('locks every card in a read-only conversation', async () => {
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    cachedAt.value = Date.now()
    const w = await mount()
    try {
      await expect.poll(() => w.findAll('.w-choices').length).toBe(2)
      await expect.poll(() => w.findAll('.w-choices').every(g => g.classes().includes('done'))).toBe(true)
    } finally { w.unmount() }
  })

  // WHR-283: a single option is a one-click confirm.
  it('draws a single option as one button that sends its text', async () => {
    items.splice(0, items.length, { role: 'assistant', text: 'Shall I fix the test?\n\n```wherdr\nchoices "OK, fix the test"\n```', ts: '2026-01-01T09:00:00Z' })
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] }, global: { stubs: { UTooltip: { template: '<slot />' } } } })
    try {
      await expect.poll(() => w.findAll('.w-choices button').length).toBe(1)
      await w.find('.w-choices button').trigger('click')
      expect((w.emitted('choose')?.[0]?.[0] as string).split('\n').at(-1)).toBe('OK, fix the test')
    } finally { w.unmount() }
  })
})
