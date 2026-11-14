import { describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { marked } from 'marked'
import { useRouter } from '#app'
import ChatMarkdown from '~/components/ChatMarkdown.vue'
import { md } from '~/utils/markdown'

// WHR-44: an agent's in-app address, as a link or as inline code, opens the
// place through the router; other code stays plain. Parsed with marked (the
// renderer md() installs): happy-dom cannot run DOMPurify, see ChatMarkdownSvg.
describe('ChatMarkdown in-app links', () => {
  it('navigates inside the app from a link or an inline code address', async () => {
    md('')
    const html = marked.parse('Open [Phone](#/settings?section=phone), then `#/board?project=CO&tag=ui`, [CO-4](#/board?task=CO-4), not `npm test`.', { breaks: true, gfm: true, async: false }) as string
    const w = await mountSuspended(ChatMarkdown, { props: { typing: null, html } })
    const push = vi.spyOn(useRouter(), 'push').mockResolvedValue(undefined)
    const [phone, board, task] = w.findAll('a').map(a => a.element as HTMLAnchorElement)
    expect(w.findAll('code').filter(c => !c.element.closest('a')).map(c => c.text())).toEqual(['npm test'])
    const click = (a: HTMLAnchorElement) => { const e = new MouseEvent('click', { bubbles: true, cancelable: true }); a.dispatchEvent(e); return e.defaultPrevented }
    expect(click(phone!)).toBe(true) // no reload
    expect(click(board!)).toBe(true)
    // A task's sheet opens over the conversation (WHR-113).
    expect(click(task!)).toBe(true)
    expect(push.mock.calls).toEqual([['/settings?section=phone'], ['/board?project=CO&tag=ui'], [{ path: '/', query: { task: 'CO-4' } }]])
    push.mockRestore()
    w.unmount()
  }, 40000)

  // WHR-196: an action button with a readable label, never the raw address.
  it('shows in-app links as labelled buttons without their address', async () => {
    md('')
    const html = marked.parse('See `#/settings?section=projects&project=WHR&tab=guards` and [the board](#/board?project=WHR), [#/decisions](#/decisions).', { breaks: true, gfm: true, async: false }) as string
    const w = await mountSuspended(ChatMarkdown, { props: { typing: null, html } })
    const links = w.findAll('a.md-app-link')
    expect(links.map(a => a.text())).toEqual(['Open Settings › Projects › WHR › Guards', 'the board', 'Open Decisions'])
    expect(links.every(a => a.find('.md-app-icon').exists() && !a.find('code').exists())).toBe(true)
    expect(w.text()).not.toContain('#/')
    w.unmount()
  }, 40000)
})
