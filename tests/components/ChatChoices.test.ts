// `choices` buttons of a wherdr block (utils/markdown.ts): a tap on those of
// the agent's last message sends the option quoted to the question; older
// ones, or once answered, are greyed with the answer given pressed.
import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ChatView from '~/components/ChatView.vue'
import { herdrState } from '~/composables/useHerdr'
import type { ChatItem, Pane } from '#shared/types'

const pane: Pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '/tmp/demo', agentSession: null }
const block = (q: string) => `${q}\n\n\`\`\`wherdr\nchoices "Squash" | "Rebase"\n\`\`\``
const items: ChatItem[] = [
  { role: 'assistant', text: block('How shall I merge it?'), ts: '2026-01-01T09:00:00Z' },
  { role: 'user', text: 'Later.', ts: '2026-01-01T09:01:00Z' },
  { role: 'assistant', text: block('And the next one, how?'), ts: '2026-01-01T09:02:00Z' },
]
registerEndpoint('/api/chat', () => ({ available: true, token: 'choices', file: '/tmp/demo/transcript.jsonl', items }))

describe('choice buttons in the conversation', () => {
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] } })

  it('keeps only the last message live and sends the tapped option quoted', async () => {
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] }, global: { stubs: { UTooltip: { template: '<slot />' } } } })
    try {
      await expect.poll(() => w.findAll('.w-choices').length).toBe(2)
      const [old, last] = w.findAll('.w-choices')
      await expect.poll(() => old!.classes()).toContain('done')
      expect(old!.findAll('button').every(b => b.element.hasAttribute('disabled'))).toBe(true)
      expect(last!.classes()).not.toContain('done')
      await last!.findAll('button')[1]!.trigger('click')
      const sent = w.emitted('choose')?.[0]?.[0] as string
      // Quoted to the last message (to its question in a browser: DOMPurify drops
      // the paragraph under happy-dom, see tests/markQuestions.test.ts).
      expect(sent.split("\n")).toEqual([expect.stringMatching(/^↳ Quote (?:point|message) .* : And the next one, how\? —$/), "Rebase"])
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
