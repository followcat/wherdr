import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { marked } from 'marked'
import ChatMarkdown from '~/components/ChatMarkdown.vue'
import { md } from '~/utils/markdown'

// Install the real fenced-code renderer. As in markQuestions.test.ts, parse
// with marked here: happy-dom does not implement DOMPurify's HTML document
// traversal correctly. svgPreview.test.ts exercises the actual image sanitizer.
md('')
const source = '<svg viewBox="0 0 160 60"><rect x="1" y="1" width="158" height="58" fill="var(--surface)" stroke="currentColor"/><text x="12" y="34" fill="var(--fg)">Ready &amp; safe</text></svg>'
function render(text: string) {
  return marked.parse(text, { breaks: true, gfm: true, async: false }) as string
}

describe('SVG fenced previews', () => {
  it('switches between preview and exact source within one card while keeping Copy available', async () => {
    const w = await mountSuspended(ChatMarkdown, { props: { html: render(`\`\`\`svg\n${source}\n\`\`\``), typing: null } })
    expect(w.find('img.svg-preview').attributes('src')).toMatch(/^data:image\/svg\+xml,/)
    expect((w.find('.svg-source').element as HTMLElement).hidden).toBe(true)
    expect(w.find('.code-head .svg-toggle').exists()).toBe(true)
    await w.find('.svg-toggle').trigger('click')
    expect((w.find('.svg-source').element as HTMLElement).hidden).toBe(false)
    expect((w.find('img').element as HTMLImageElement).hidden).toBe(true)
    expect(w.find('.svg-toggle').attributes('aria-pressed')).toBe('true')
    expect(w.findAll('.svg-block')).toHaveLength(1)
    expect(w.find('.code-copy').exists()).toBe(true)
    await w.find('.svg-toggle').trigger('click')
    expect((w.find('img').element as HTMLImageElement).hidden).toBe(false)
    expect(w.find('pre').element.textContent).toBe(source)
    expect(w.find('svg').exists()).toBe(false)
    w.unmount()
  })

  it.each([
    '<svg viewBox="0 0 100 40"><rect width="100"',
    '<svg><foreignObject><iframe src="https://example.com"/></foreignObject></svg>',
  ])('shows unusable SVG as readable, exactly copyable source', async (text) => {
    const w = await mountSuspended(ChatMarkdown, { props: { html: render(`\`\`\`svg\n${text}\n\`\`\``), typing: null } })
    expect(w.find('img').exists()).toBe(false)
    expect(w.find('pre').element.textContent).toBe(text)
    expect(w.find('.code-copy').exists()).toBe(true)
    w.unmount()
  })

  it('reveals source instead of leaving a broken or blank image after a decode error', async () => {
    const w = await mountSuspended(ChatMarkdown, { props: { html: render(`\`\`\`svg\n${source}\n\`\`\``), typing: null } })
    await w.find('img').trigger('error')
    expect(w.find('img').exists()).toBe(false)
    expect((w.find('.svg-source').element as HTMLElement).hidden).toBe(false)
    expect((w.find('.svg-toggle').element as HTMLButtonElement).disabled).toBe(true)
    expect(w.find('pre').element.textContent).toBe(source)
    w.unmount()
  })

  it('keeps source and controls intact throughout typewriter reveal', async () => {
    const html = render(`${'Prose before the drawing. '.repeat(30)}\n\n\`\`\`svg\n${source}\n\`\`\``)
    const w = await mountSuspended(ChatMarkdown, { props: { html, typing: null, cipher: true, speed: 'slow' } })
    await w.setProps({ typing: Date.now() })
    expect(w.find('pre').element.textContent).toBe(source)
    await w.find('.md-body').trigger('click')
    expect(w.find('pre').element.textContent).toBe(source)
    expect((w.find('.svg-source').element as HTMLElement).hidden).toBe(true)
    expect(w.emitted('done')).toHaveLength(1)
    w.unmount()
  })

  it('does not promote SVG inside an ordinary XML fence or change shell command copying', () => {
    const root = document.createElement('div')
    root.innerHTML = render(`\`\`\`xml\n${source}\n\`\`\`\n\n\`\`\`sh\n$ pwd\n\`\`\``)
    expect(root.querySelector('img, svg')).toBeNull()
    expect(root.querySelector('pre')?.textContent).toBe(source)
    expect(root.querySelector('.code-block[data-cmd]')?.getAttribute('data-cmd')).toBe('pwd')
  })
})
