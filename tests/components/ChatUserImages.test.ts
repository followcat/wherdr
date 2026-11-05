// User messages with images render as any other user message: one framed
// bubble on the right (images inside, then the text) and the time under it.
import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ChatView from '~/components/ChatView.vue'
import { lightboxSet, lightboxSrc } from '~/composables/useUi'
import { herdrState } from '~/composables/useHerdr'
import type { ChatItem, Pane } from '#shared/types'

const pane: Pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '/tmp/demo', agentSession: null }
const items: ChatItem[] = [
  { role: 'user', text: '', ts: '2026-01-01T09:00:00Z', ref: 'shot', images: 1 },
  { role: 'assistant', text: 'The header overlaps.', ts: '2026-01-01T09:00:05Z' },
  { role: 'user', text: 'Here on my phone:', ts: '2026-01-01T09:01:00Z', ref: 'with-text', images: 1 },
  { role: 'assistant', text: 'Seen.', ts: '2026-01-01T09:01:05Z' },
  { role: 'user', text: '', ts: '2026-01-01T09:02:00Z', ref: 'three', images: 3 },
  { role: 'assistant', text: 'Three screenshots.', ts: '2026-01-01T09:02:05Z' },
]
registerEndpoint('/api/chat', () => ({ available: true, token: 'user-images', file: '/tmp/demo/transcript.jsonl', items }))

describe('user messages with images', () => {
  afterEach(() => { lightboxSrc.value = null; lightboxSet.value = []; herdrState.value = { ok: false, workspaces: [], panes: [] } })

  it('frames images-only, text + image and several images like a typed message', async () => {
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] }, global: { stubs: { UTooltip: { template: '<slot />' } } } })
    try {
      await expect.poll(() => w.findAll('.msg-user-wrap').length).toBe(3)
      const [alone, mixed, several] = w.findAll('.msg-user-wrap')
      for (const m of [alone!, mixed!, several!]) {
        // A user message on the right, its images inside the bubble, its time under it.
        const msg = m.find('.msg-user')
        expect(msg.attributes('data-role')).toBe('user')
        expect(msg.find('[data-slot="header"]').exists()).toBe(false)
        expect(msg.find('.msg-bubble .msg-media .thumbs').exists()).toBe(true)
        expect(m.find('.msg-time').exists()).toBe(true)
      }
      // Image only: framed, one readable thumbnail, no empty text.
      expect(alone!.find('.msg-user').classes()).toContain('msg-no-text')
      expect(alone!.find('.thumbs').classes()).toContain('one')
      expect(alone!.findAll('.msg-img')).toHaveLength(1)
      expect(alone!.find('.msg-fold').exists()).toBe(false)
      expect(alone!.find('.msg-time').text()).toMatch(/\d{2}:\d{2}/)
      // Text + image: the image above the text, in the same bubble.
      expect(mixed!.find('.msg-user').classes()).not.toContain('msg-no-text')
      expect(mixed!.find('.msg-bubble').element.firstElementChild!.classList.contains('msg-media')).toBe(true)
      expect(mixed!.find('.msg-bubble .msg-fold').text()).toBe('Here on my phone:')
      // Several images: a grid of thumbnails.
      expect(several!.find('.thumbs').classes()).not.toContain('one')
      const imgs = several!.findAll('.msg-img')
      expect(imgs).toHaveLength(3)
      // A tap opens the viewer on the message's images.
      await imgs[1]!.trigger('click')
      expect(lightboxSet.value).toEqual(imgs.map(i => i.attributes('src')))
      expect(lightboxSrc.value).toBe(imgs[1]!.attributes('src'))
    } finally { w.unmount() }
  })
})
