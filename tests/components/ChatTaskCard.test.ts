// WHR-202: a `task <ID>` line of a `wherdr` block shows the task's live card
// from the board, and a tap opens its sheet over the conversation. Parsed with
// marked (the renderer md() installs): happy-dom cannot run DOMPurify, see ChatMarkdownSvg.
import { expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { marked } from 'marked'
import { useRouter } from '#app'
import ChatMarkdown from '~/components/ChatMarkdown.vue'
import { md } from '~/utils/markdown'
import type { Board, Card } from '#shared/pm/board'

const card = { id: 'CO-4', shown: 'CO-4', project: 'co', title: 'Fix login redirect', column: 'merge', phase: 'working', holder: 'none', yourTurn: 'Look at the screenshots, then merge', state: { yourTurn: { reason: 'user' } }, userLabel: 'Merge' } as unknown as Card
registerEndpoint('/api/pm/board', (): Board => ({ projects: [], cards: [card] }))

it('shows each task line as its live card, and a tap opens its sheet', async () => {
  md('')
  const html = marked.parse('Here:\n\n```wherdr\ntask CO-4\ntask CO-9\n```\n\n```wherdr\nmerge CO-4\n```', { breaks: true, gfm: true, async: false }) as string
  const w = await mountSuspended(ChatMarkdown, { props: { typing: null, html }, attrs: { class: 'md' } })
  expect(w.find('.md-body').classes()).toContain('md')
  await expect.poll(() => w.find('[data-task="CO-4"] .handle-title').exists()).toBe(true)
  const row = w.find('.chat-task[data-task="CO-4"]')
  expect([row.find('.handle-title').text(), row.find('.handle-label').text(), row.find('.handle-action').text()]).toEqual(['Fix login redirect', 'Merge', 'Look at the screenshots, then merge'])
  expect(w.find('.chat-task[data-task="CO-9"]').text()).toBe('CO-9 · Not on the board')
  expect(w.find('pre code').text()).toBe('merge CO-4') // a line it does not know: plain code
  await row.find('.handle-row').trigger('click')
  await expect.poll(() => useRouter().currentRoute.value.fullPath).toBe('/?task=CO-4')
  w.unmount()
  await useRouter().replace('/')
}, 40000)
