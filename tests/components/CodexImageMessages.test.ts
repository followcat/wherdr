// A Codex rollout with photos, parsed by the server and rendered: the photos
// show, their markers never do, and a photo-only message has no bubble.
import { describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ChatView from '~/components/ChatView.vue'
import { herdrState } from '~/composables/useHerdr'
import { parseLines } from '../../server/utils/transcripts'
import type { ChatItem, Pane } from '#shared/types'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const text = (t: string) => ({ type: 'input_text', text: t })
const local = (n: number) => [text(`<image name=[Image #${n}] path="/home/user/.cache/herdr-web/uploads/photo-${n}.jpg">`), { type: 'input_image', image_url: PNG }, text('</image>')]
const line = (role: string, content: object[], ts: string) => JSON.stringify({ timestamp: ts, type: 'response_item', payload: { type: 'message', role, content } })
// The event Codex writes after a message: its composer's "[Image #N]" placeholders as byte
// ranges (here the last occurrence of each label: the composer's).
const typed = (message: string, placeholders: string[], ts: string) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: {
  type: 'user_message', message, images: [], local_images: [], text_elements: placeholders.map((label) => {
    const start = Buffer.from(message).lastIndexOf(label)
    return { byte_range: { start, end: start + Buffer.byteLength(label) }, placeholder: label }
  }),
} })
const literal = 'Explique littéralement `[Image #1]` dans cet exemple.'
const rollout = [
  line('user', [...local(1), text('[Image #1]')], '2026-01-01T00:00:00Z'),
  typed('[Image #1]', ['[Image #1]'], '2026-01-01T00:00:00Z'),
  line('assistant', [{ type: 'output_text', text: 'A login page.' }], '2026-01-01T00:00:05Z'),
  line('user', [...local(1), ...local(2), text('Before [Image #1] and [Image #2] after.')], '2026-01-01T00:01:00Z'),
  typed('Before [Image #1] and [Image #2] after.', ['[Image #1]', '[Image #2]'], '2026-01-01T00:01:00Z'),
  line('assistant', [{ type: 'output_text', text: 'Both differ.' }], '2026-01-01T00:01:05Z'),
  line('user', [text('Close a tag with `</image>`, label it [Image #1].')], '2026-01-01T00:02:00Z'),
  line('assistant', [{ type: 'output_text', text: 'Noted.' }], '2026-01-01T00:02:05Z'),
  // A photo with a typed literal marker; the composer's placeholder comes after it.
  line('user', [...local(1), text(`${literal}\n[Image #1]`)], '2026-01-01T00:03:00Z'),
  typed(`${literal}\n[Image #1]`, ['[Image #1]'], '2026-01-01T00:03:00Z'),
].join('\n') + '\n'

const pane: Pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'codex', name: null, label: null, status: 'idle', title: null, cwd: '/home/user/acme-shop', agentSession: null }
const items: ChatItem[] = parseLines(rollout, 'codex')
registerEndpoint('/api/chat', () => ({ available: true, token: 'codex-images', file: 'rollout-test.jsonl', items }))

describe('Codex messages with photos', () => {
  it('shows the photos without markers and keeps the typed text', async () => {
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] }, global: { stubs: { UTooltip: { template: '<slot />' } } } })
    try {
      await expect.poll(() => w.findAll('.msg-user').length).toBe(4)
      const [alone, mixed, typedMarkers, withPhoto] = w.findAll('.msg-user')
      // Photo only: its thumbnail, no bubble text.
      expect(alone!.classes()).toContain('msg-no-text')
      expect(alone!.findAll('img')).toHaveLength(1)
      expect(alone!.find('img').attributes('src')).toMatch(/^\/api\/chat\/image\?pane=.*&i=0$/)
      expect(alone!.find('.msg-fold').exists()).toBe(false)
      // Text and photos: both photos, the text as typed.
      expect(mixed!.classes()).not.toContain('msg-no-text')
      expect(mixed!.findAll('img')).toHaveLength(2)
      expect(mixed!.find('.msg-fold').element.textContent).toBe('Before and after.')
      // Literal markers the user typed stay.
      expect(typedMarkers!.find('.msg-fold').element.textContent).toBe('Close a tag with `</image>`, label it [Image #1].')
      // A photo with a typed marker: the photo, the typed text whole.
      expect(withPhoto!.findAll('img')).toHaveLength(1)
      expect(withPhoto!.find('.msg-fold').element.textContent).toBe(literal)
      expect(w.find('.chat').text()).not.toMatch(/<\/image>\s*\[Image #1\]|path=/)
    } finally { w.unmount() }
  })
})
