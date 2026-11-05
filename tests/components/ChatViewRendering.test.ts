import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ChatView from '~/components/ChatView.vue'
import { lightboxSet, lightboxSrc } from '~/composables/useUi'
import { herdrState } from '~/composables/useHerdr'
import type { ChatItem, Pane } from '#shared/types'
import { parseLines } from '../../server/utils/transcripts'
import ompErrors from '../fixtures/omp-errors.jsonl?raw'
import devinAtif from '../fixtures/devin-atif-v1.7-real.json'
import { parseDevin } from '../../server/utils/devinTranscripts'

const pane: Pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'omp', name: null, label: null, status: 'blocked', title: null, cwd: '/tmp/demo', agentSession: null }
let items: ChatItem[] = []
registerEndpoint('/api/chat', () => ({ available: true, token: 'rendering', file: '/tmp/demo/transcript.jsonl', items }))

describe('conversation rendering', () => {
  afterEach(() => { lightboxSrc.value = null; lightboxSet.value = []; herdrState.value = { ok: false, workspaces: [], panes: [] } })

  it('renders the saved Devin checkpoint while the process works on its next turn', async () => {
    const working = { ...pane, agent: 'devin', status: 'working' as const }
    herdrState.value = { ok: true, workspaces: [], panes: [working] }
    items = parseDevin(devinAtif.steps)
    const w = await mountSuspended(ChatView, {
      props: { pane: working, localQueued: [] },
      global: { stubs: { UTooltip: { template: '<slot />' } } },
    })
    try {
      await expect.poll(() => w.find('.chat').text()).toContain('all 12 tests pass')
      expect(w.findAll('.msg-user')).toHaveLength(2)
      expect(w.find('.chat').text()).not.toContain('System instructions')
      expect(w.find('.chat').text()).toContain('npm test')
      // The first historical turn is finished; the tail is still working.
      const order = [...w.find('.chat').element.querySelectorAll('.msg-user, .turn-end')]
        .map(el => el.classList.contains('turn-end') ? 'finished' : 'user')
      expect(order).toEqual(['user', 'finished', 'user'])
    } finally { w.unmount() }
  })

  it('keeps an action awaiting approval live without a finished-turn line', async () => {
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    items = [
      { role: 'user', text: 'Clean the build folder.', ts: '2026-01-01T00:00:00Z' },
      // Pending omp calls already carry their console view before any tool result.
      { role: 'tool', text: 'rm -rf build', name: 'Bash', ts: '2026-01-01T00:00:01Z', omp: { title: 'Bash', target: 'rm -rf build', intent: 'Removing the build folder' } },
    ]
    const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] } })
    try {
      await expect.poll(() => w.find('.chat').text()).toContain('Clean the build folder.')
      const message = w.find('.msg-user .msg-fold')
      expect(message.element.textContent).toBe('Clean the build folder.')
      expect(message.isVisible()).toBe(true)
      expect(w.find('.tools.omp-console.live').isVisible()).toBe(true)
      expect(w.find('.omp-console .omp-tool-cmd').text()).toBe('rm -rf build')
      expect(w.findAll('.turn-end')).toHaveLength(0)
    } finally { w.unmount() }
  })

  it('keeps a folded omp tool image outside the hidden calls and opens its viewer', async () => {
    const idle = { ...pane, status: 'idle' as const }
    herdrState.value = { ok: true, workspaces: [], panes: [idle] }
    items = [
      { role: 'tool', text: '', ts: '2026-01-01T00:00:00Z', ref: 'image-line', images: 1, omp: { title: 'Read', target: 'login.png' } },
      ...['ls', 'git status', 'npm test'].map((target, i): ChatItem => ({ role: 'tool', text: '', ts: `2026-01-01T00:00:0${i + 1}Z`, omp: { title: 'Bash', target, out: 'ok' } })),
      { role: 'assistant', text: 'The login button is clipped.', ts: '2026-01-01T00:00:04Z' },
    ]
    const w = await mountSuspended(ChatView, { props: { pane: idle, localQueued: [] } })
    try {
      await expect.poll(() => w.find('.chat').text()).toContain('The login button is clipped.')
      const consoleBlock = w.find('.omp-console')
      expect(consoleBlock.find('.omp-console-more').isVisible()).toBe(true)
      expect(consoleBlock.findAll('.omp-tool')).toHaveLength(3)
      expect(consoleBlock.text()).not.toContain('read login.png')
      const thumbs = consoleBlock.findAll('.tool-thumbs .msg-img')
      expect(thumbs).toHaveLength(1)
      const src = thumbs[0]!.attributes('src')!
      expect(src).toMatch(/^\/api\/chat\/image\?pane=/)
      await thumbs[0]!.trigger('click')
      expect(lightboxSrc.value).toBe(src)
      expect(lightboxSet.value).toEqual([src])
    } finally { w.unmount() }
  })
  it('opens the full output of a local "/" command from its one-line summary', async () => {
    const idle = { ...pane, agent: 'claude' as const, status: 'idle' as const }
    herdrState.value = { ok: true, workspaces: [], panes: [idle] }
    items = [
      { role: 'cmd', text: '/context → claude-opus · 45k/200k tokens (22%)', ts: '2026-01-01T00:00:00Z', out: 'Context Usage\nclaude-opus · 45k/200k tokens (22%)\nSystem prompt: 3k tokens\nMessages: 40k tokens' },
      { role: 'cmd', text: '/cost → Total cost: $0.12', ts: '2026-01-01T00:00:01Z' },
    ]
    const w = await mountSuspended(ChatView, { props: { pane: idle, localQueued: [] } })
    try {
      await expect.poll(() => w.find('.chat').text()).toContain('/cost → Total cost: $0.12')
      // Nothing more to say: a plain line, not a button.
      expect(w.findAll('div.msg-system').map(x => x.text())).toContain('/cost → Total cost: $0.12')
      const line = w.find('.msg-cmd button.msg-system')
      expect(line.text()).toContain('/context')
      expect(line.attributes('aria-expanded')).toBe('false')
      expect(w.find('.msg-cmd pre').exists()).toBe(false)
      await line.trigger('click')
      expect(line.attributes('aria-expanded')).toBe('true')
      expect(w.find('.msg-cmd pre').text()).toBe('Context Usage\nclaude-opus · 45k/200k tokens (22%)\nSystem prompt: 3k tokens\nMessages: 40k tokens')
      await line.trigger('click')
      expect(w.find('.msg-cmd pre').exists()).toBe(false)
    } finally { w.unmount() }
  })
  it('keeps a scheduled prompt folded while rendering its Markdown on demand', async () => {
    const idle = { ...pane, status: 'idle' as const }
    herdrState.value = { ok: true, workspaces: [], panes: [idle] }
    items = [
      { role: 'notice', name: 'scheduled', text: '**Check deployment**', ts: '2026-01-01T00:00:00Z' },
      { role: 'assistant', text: 'Deployment is green.', ts: '2026-01-01T00:00:01Z' },
    ]
    const w = await mountSuspended(ChatView, {
      props: { pane: idle, localQueued: [] },
      global: { stubs: { UTooltip: { template: '<slot />' } } },
    })
    try {
      await expect.poll(() => w.find('.chat').text()).toContain('Deployment is green.')
      const notice = w.find('.msg-notice.scheduled')
      expect(notice.classes()).toContain('long')
      expect(notice.classes()).not.toContain('open')
      expect(notice.find('.msg-notice-body strong').text()).toBe('Check deployment')
      expect(w.findAll('.msg-user-wrap')).toHaveLength(0)
      const toggle = notice.find('button.msg-shell-more')
      expect(toggle.attributes('aria-expanded')).toBe('false')
      await toggle.trigger('click')
      expect(toggle.attributes('aria-expanded')).toBe('true')
      expect(notice.classes()).toContain('open')
    } finally { w.unmount() }
  })

  it('shows omp errors between the check-ins and actions, each once, in plain text', async () => {
    const idle = { ...pane, status: 'idle' as const }
    herdrState.value = { ok: true, workspaces: [], panes: [idle] }
    // The conversation as the server reads it from omp's session file.
    items = parseLines(ompErrors, 'omp', 0, '/home/user')
    const w = await mountSuspended(ChatView, {
      props: { pane: idle, localQueued: [] },
      global: { stubs: { UTooltip: { template: '<slot />' } } },
    })
    try {
      await expect.poll(() => w.findAll('.msg-error').length).toBe(4)
      const errors = w.findAll('.msg-error')
      expect(errors.map(e => e.find('.msg-notice-head').text())).toEqual(['Error', 'Error', 'Error', 'Error'])
      const texts = errors.map(e => e.find('.msg-error-text').text())
      expect(texts[0]).toContain('You have reached your specified API usage limits.')
      expect(texts[1]).toContain('rate_limit_error')
      expect(texts[2]).toBe('Retry budget exhausted after 2 retries: Anthropic stream stalled while waiting for the next event')
      expect(texts[3]).toContain('Your credit balance is too low to access the Anthropic API.')
      // Raw provider JSON stays as written (no Markdown).
      expect(errors[0]!.find('.msg-error-text').element.textContent).toMatch(/^400 \{"type":"error"/)
      // Check-ins and actions are still there, around the errors.
      expect(w.findAll('.msg-user')).toHaveLength(5)
      expect(w.find('.omp-console .omp-tool-cmd').text()).toBe('tools/tasks.sh list')
      expect(w.find('.msg-ai').text()).toContain('Checking the board.')
      expect(w.findAll('.msg-system').map(s => s.text())).toEqual(expect.arrayContaining(['Retried after an error', 'Interrupted']))
      // Order: each error right after the check-in that hit it.
      const order = [...w.find('.chat').element.querySelectorAll('.msg-user, .msg-error')].map(el => el.classList.contains('msg-error') ? 'E' : 'A')
      expect(order.join('')).toBe('AEAEAEAAE')
    } finally { w.unmount() }
  })
})
