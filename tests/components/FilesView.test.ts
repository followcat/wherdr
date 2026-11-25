import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { getQuery } from 'h3'
import FilesView from '~/components/FilesView.vue'
import { setToaster } from '~/composables/useHerdr'
import { lightboxSrc } from '~/composables/useUi'

vi.mock('~/components/PdfPreview.vue', () => ({ default: { props: ['src', 'title'], template: '<div class="files-pdf" :data-src="src" :title="title" />' } }))

const asked: string[] = []
registerEndpoint('/api/files', (event) => {
  const q = getQuery(event)
  // An agent started in src/, below the repository root.
  if (q.pane === 'w1:sub' && q.path === undefined) return { root: '/home/user/demo', path: 'src', truncated: false, entries: [{ name: 'app.ts', kind: 'file', size: 19, link: false }] }
  const path = String(q.path ?? '')
  asked.push(path)
  if (path === 'docs') return { root: '/home/user/demo', path: 'docs', truncated: false, entries: [{ name: 'guide.md', kind: 'file', size: 400, link: false }] }
  return path === 'src'
    ? { root: '/home/user/demo', path: 'src', truncated: false, entries: [{ name: 'app.ts', kind: 'file', size: 19, link: false }] }
    : { root: '/home/user/demo', path: '', truncated: false, entries: [
        { name: 'src', kind: 'dir', size: null, link: false },
        { name: '.env', kind: 'file', size: 4, link: false },
        { name: 'README.md', kind: 'file', size: 8, link: false },
      ] }
})
// Markdown files of a fictional project, by path. DOMPurify does not work
// under happy-dom (it unwraps the first element of a fragment, keeps event
// attributes, skips its hooks): each file starts with a line of text, and
// sanitising and images are checked in a browser (tests/e2e/files-markdown.spec.ts).
const DOCS: Record<string, string> = {
  'docs/guide.md': [
    'Sample.',
    '',
    '# Field guide',
    '',
    'Read [the setup](setup.md#install-steps), the [changelog](/CHANGELOG.md),',
    'a [web page](https://example.com/page) or [out there](../../outside.md).',
    'Jump [below](#last-words).',
    '',
    '- [x] done',
    '- [ ] to do',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '```ts',
    'const n = 1',
    '```',
    '',
    '## Last words',
  ].join('\n'),
  'docs/setup.md': 'Sample.\n\n# Setup\n\n## Install steps\n\nRun it.\n',
  'CHANGELOG.md': 'Sample.\n\n# Changelog\n',
  'README.md': 'Sample.\n\n# Demo\n\nSee the [guide](docs/guide.md).\n',
  '/home/user/notes/plan.md': 'Sample.\n\n# Plan\n\nSee [todo](todo.md).\n',
  '/home/user/notes/todo.md': 'Sample.\n\n# Todo\n',
  'mockup.html': '<h1>Mockup</h1>\n<script>document.title = "x"</script>\n',
}
const PNG = 'data:image/png;base64,iVBORw0KGgo='
let hold: Promise<void> | null = null
const reads: Record<string, unknown>[] = []
registerEndpoint('/api/files/read', async (event) => {
  if (hold) await hold
  const q = getQuery(event)
  reads.push(q)
  // A path written in the conversation comes back absolute.
  const path = String(q.path).replace(/^~(?=\/)/, '/home/user')
  if (path.endsWith('.pdf')) return { path, size: 11_000_000, kind: 'pdf', truncated: false }
  if (path.endsWith('.png')) return { path, size: 68, kind: 'image', dataUrl: PNG, truncated: false }
  if (path.endsWith('.zip')) return { path, size: 40, kind: 'binary', truncated: false }
  const doc = DOCS[path] ?? DOCS[path.replace('/home/user/demo/', '')]
  if (doc !== undefined) return { path, size: doc.length, kind: 'text', text: doc, truncated: false }
  return { path, size: 19, kind: 'text', text: 'export const x = 1\nlet y\n', truncated: false }
})
const downloads: Record<string, unknown>[] = []
registerEndpoint('/api/files/download', (event) => {
  const q = getQuery(event)
  downloads.push(q)
  return 'a,b\r\n1,2\r\n'
})

// The tree reads each folder through fetch: wait until no row is loading.
async function settle(w: { find: (s: string) => { exists: () => boolean } }) {
  await flushPromises()
  await vi.waitFor(() => expect(w.find('.tree-row').exists() && !w.find('.tree-note.tree-loading').exists()).toBe(true))
}
async function mountTree() {
  const w = await mountSuspended(FilesView, { props: { paneId: 'w1:p1' } })
  await settle(w)
  return w
}

describe('FilesView', () => {
  beforeEach(() => { localStorage.clear(); hold = null })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('expands a folder in the tree, shows a file clicked with line numbers, and goes back through the breadcrumb', async () => {
    const w = await mountTree()
    expect(w.findAll('.tree-row').map(b => b.text())).toEqual(['src', '.env4 B', 'README.md8 B'])
    await w.findAll('.tree-row')[0]!.trigger('click')
    await settle(w)
    expect(asked.at(-1)).toBe('src')
    expect(w.findAll('.tree-row').map(b => b.text())).toEqual(['src', 'app.ts19 B', '.env4 B', 'README.md8 B'])
    await w.findAll('.tree-row')[1]!.trigger('click')
    await flushPromises()
    expect(w.find('.files-num').text()).toBe('1\n2')
    expect(w.find('.files-text').text()).toBe('export const x = 1\nlet y')
    expect(w.find('.changes-location').text()).toContain('src/app.ts')
    expect(w.findAll('.files-crumb').map(c => c.text())).toEqual(['demo', 'src', 'app.ts'])
    await w.find('.files-crumb').trigger('click')
    await flushPromises()
    expect(w.find('.files-text').exists()).toBe(false)
    expect(w.findAll('.tree-row')).toHaveLength(4)
  })

  it('opens on an agent folder below the repository root, its files read by their full path', async () => {
    const w = await mountSuspended(FilesView, { props: { paneId: 'w1:sub' } })
    await settle(w)
    await vi.waitFor(() => expect(w.findAll('.tree-row').map(b => b.text())).toEqual(['src', 'app.ts19 B', '.env4 B', 'README.md8 B']))
    await w.findAll('.tree-row')[1]!.trigger('click')
    await flushPromises()
    expect(reads.at(-1)).toEqual({ pane: 'w1:sub', path: 'src/app.ts' })
  })

  it('hides dotfiles when asked, and remembers it', async () => {
    const w = await mountTree()
    await w.find('.changes-toggle input').setValue(false)
    expect(w.findAll('.tree-row').map(b => b.text())).toEqual(['src', 'README.md8 B'])
    const again = await mountTree()
    expect(again.findAll('.tree-row')).toHaveLength(2)
  })

  it('stays on the folder when going back while a refresh is loading', async () => {
    const w = await mountTree()
    await w.findAll('.tree-row')[2]!.trigger('click')
    await flushPromises()
    let release = () => {}
    hold = new Promise((r) => { release = r })
    await w.find('button[aria-label="Refresh"]').trigger('click')
    await w.find('button[aria-label="Back to folder"]').trigger('click')
    release()
    await new Promise(r => setTimeout(r, 100))
    await flushPromises()
    expect(w.find('.files-text').exists()).toBe(false)
  })

  it('downloads the file it shows', async () => {
    // Nuxt uses happy-dom's response Blob but keeps Node's URL API, which
    // rejects that Blob. Model the browser object URL boundary explicitly.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:files-view-download')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const saved: { href: string, name: string }[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push({ href: this.href, name: this.download }) })
    const w = await mountTree()
    await w.findAll('.tree-row')[2]!.trigger('click')
    await flushPromises()
    await w.find('button[aria-label="Download"]').trigger('click')
    await vi.waitFor(() => expect(saved).toHaveLength(1))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(await (createObjectURL.mock.calls[0]![0] as Blob).text()).toBe('a,b\r\n1,2\r\n')
    expect(saved[0]!.href).toBe('blob:files-view-download')
    expect(revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:files-view-download')
    expect(downloads.at(-1)).toEqual({ pane: 'w1:p1', path: 'README.md' })
    expect(saved[0]).toMatchObject({ href: expect.stringMatching(/^blob:/), name: 'README.md' })
  })

  it('shows one file named in the conversation, with no folder around it, and downloads it', async () => {
    // Nuxt uses happy-dom's response Blob but keeps Node's URL API, which
    // rejects that Blob. Model the browser object URL boundary explicitly.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:files-view-download')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const saved: { href: string, name: string }[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push({ href: this.href, name: this.download }) })
    const listed = asked.length
    const w = await mountSuspended(FilesView, { props: { paneId: 'w1:p1', file: '~/exports/report.csv' } })
    await flushPromises()
    expect(asked).toHaveLength(listed)
    expect(reads.at(-1)).toEqual({ pane: 'w1:p1', path: '~/exports/report.csv', from: 'chat' })
    // Its folder and size only: the window's title names it (head).
    expect(w.find('[data-testid="files-located"]').text()).toBe('/home/user/exports · 19 B')
    expect(w.find('.files-crumb').exists()).toBe(false)
    expect(w.find('button[aria-label="Back to folder"]').exists()).toBe(false)
    expect(w.emitted('name')).toEqual([['report.csv']])
    await w.find('button[aria-label="Download"]').trigger('click')
    await vi.waitFor(() => expect(saved).toHaveLength(1))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(await (createObjectURL.mock.calls[0]![0] as Blob).text()).toBe('a,b\r\n1,2\r\n')
    expect(saved[0]!.href).toBe('blob:files-view-download')
    expect(revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:files-view-download')
    expect(downloads.at(-1)).toEqual({ pane: 'w1:p1', path: '/home/user/exports/report.csv', from: 'chat' })
    expect(saved[0]!.name).toBe('report.csv')
    // Refresh reads the same file again, still with no folder.
    await w.find('button[aria-label="Refresh"]').trigger('click')
    await flushPromises()
    expect(reads.at(-1)).toEqual({ pane: 'w1:p1', path: '~/exports/report.csv', from: 'chat' })
    expect(w.find('.files-text').text()).toBe('export const x = 1\nlet y')
    expect(asked).toHaveLength(listed)
  })

  it('runs an HTML page in a frame sandboxed without same origin, with its source a toggle away', async () => {
    const w = await mountSuspended(FilesView, { props: { paneId: 'w1:p1', file: 'mockup.html', inFolder: true } })
    await flushPromises()
    const url = '/api/files/download?pane=w1%3Ap1&path=mockup.html&inline=1'
    const frame = w.find('iframe.files-page')
    expect(frame.attributes('src')).toBe(url)
    expect(frame.attributes('sandbox')).toBe('allow-scripts')
    expect(w.find('a[aria-label="Open"]').attributes('href')).toBe(url)
    expect(w.find('.files-page-note').text()).toContain('Self-contained pages only')
    await w.findAll('.files-md-mode button')[1]!.trigger('click')
    expect(w.find('iframe').exists()).toBe(false)
    expect(w.find('.files-text').text()).toContain('<h1>Mockup</h1>')
  })

  it('opens an image an agent shows in the zoomable viewer', async () => {
    const w = await mountSuspended(FilesView, { props: { paneId: 'w1:p1', file: 'design/mockup.png', inFolder: true } })
    await flushPromises()
    await w.find('button[aria-label="Enlarge image"]').trigger('click')
    expect(lightboxSrc.value).toBe(PNG)
    lightboxSrc.value = null
  })

  it('shows a PDF in the canvas viewer from the download path, with Open; other binaries stay a notice', async () => {
    const w = await mountSuspended(FilesView, { props: { paneId: 'w1:p1', file: '~/docs/manual.pdf' } })
    await flushPromises()
    const url = '/api/files/download?pane=w1%3Ap1&path=%2Fhome%2Fuser%2Fdocs%2Fmanual.pdf&from=chat&inline=1'
    const frame = w.find('.files-pdf')
    expect(frame.attributes('data-src')).toBe(url)
    expect(frame.attributes('sandbox')).toBeUndefined()
    expect(frame.attributes('title')).toBe('/home/user/docs/manual.pdf')
    const open = w.find('a[aria-label="Open"]')
    expect(open.attributes('href')).toBe(url)
    expect(open.attributes('target')).toBe('_blank')
    expect(w.find('button[aria-label="Download"]').exists()).toBe(true)
    // Refresh loads the viewer again.
    await w.find('button[aria-label="Refresh"]').trigger('click')
    await flushPromises()
    expect(w.find('.files-pdf').element).not.toBe(frame.element)

    const zip = await mountSuspended(FilesView, { props: { paneId: 'w1:p1', file: '~/docs/archive.zip' } })
    await flushPromises()
    expect(zip.find('iframe').exists()).toBe(false)
    expect(zip.find('a[aria-label="Open"]').exists()).toBe(false)
    expect(zip.find('.changes-notice').text()).toBe('Binary file')
  })

  describe('a Markdown file', () => {
    const toasts: string[] = []
    beforeEach(() => {
      toasts.length = 0
      setToaster({ clear() {}, add: (t: { title: string }) => { toasts.push(t.title) } } as unknown as Parameters<typeof setToaster>[0])
    })
    afterEach(() => setToaster(null as unknown as Parameters<typeof setToaster>[0]))

    it('is shown formatted by default, sanitised, and as its source on demand, remembered on the device', async () => {
      const w = await mountSuspended(FilesView, { props: { paneId: 'w1:p1', file: 'docs/guide.md' } })
      await flushPromises()
      const doc = w.find('.files-md')
      expect(doc.find('h1').text()).toBe('Field guide')
      expect(doc.findAll('input[type="checkbox"]').map(i => (i.element as HTMLInputElement).checked)).toEqual([true, false])
      expect(doc.find('table td').text()).toBe('1')
      expect(doc.find('.code-block .hl-k').text()).toBe('const')
      expect(doc.find('.code-run').exists()).toBe(false)
      expect(w.find('.files-num').exists()).toBe(false)
      const [rendered, source] = w.findAll('.files-md-mode button')
      expect(rendered!.text()).toBe('Rendered')
      expect(rendered!.attributes('aria-pressed')).toBe('true')

      await source!.trigger('click')
      expect(w.find('.files-md').exists()).toBe(false)
      expect(w.find('.files-text').text()).toContain('# Field guide')
      expect(w.find('.files-num').text().split('\n')).toHaveLength(DOCS['docs/guide.md']!.split('\n').length)
      // Download and Refresh are still there.
      expect(w.find('button[aria-label="Download"]').exists()).toBe(true)
      expect(w.find('button[aria-label="Refresh"]').exists()).toBe(true)

      const again = await mountSuspended(FilesView, { props: { paneId: 'w1:p1', file: 'docs/guide.md' } })
      await flushPromises()
      expect(again.find('.files-md').exists()).toBe(false)
      expect(again.find('.files-md-mode button[aria-pressed="true"]').text()).toBe('Source')
    })

    it('shows no toggle for a file that is not Markdown', async () => {
      const w = await mountSuspended(FilesView, { props: { paneId: 'w1:p1', file: '~/exports/report.csv' } })
      await flushPromises()
      expect(w.find('.files-md-mode').exists()).toBe(false)
      expect(w.find('.files-text').exists()).toBe(true)
    })

    it('opens a relative link to another file of the folder here, with its folder, and refuses one that leaves it', async () => {
      const w = await mountTree()
      await w.findAll('.tree-row')[2]!.trigger('click') // README.md
      await flushPromises()
      await w.find('.files-md a[href="docs/guide.md"]').trigger('click')
      await flushPromises()
      const page = w.find('.files-md')
      expect(page.find('h1').text()).toBe('Field guide')
      expect(w.findAll('.files-crumb').map(c => c.text())).toEqual(['demo', 'docs', 'guide.md'])

      // A link that leaves the folder: nothing read, a message.
      const count = reads.length
      await page.find('a[href="../../outside.md"]').trigger('click')
      await flushPromises()
      expect(reads.length).toBe(count)
      expect(toasts).toEqual(['This link leads outside the folder.'])

      // A web link is left to the browser (a new tab: the e2e test).
      const web = page.find('a[href="https://example.com/page"]')
      const event = new MouseEvent('click', { bubbles: true, cancelable: true })
      web.element.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
      expect(reads.length).toBe(count)

      // An anchor of the page scrolls to its heading.
      const scrolled: string[] = []
      vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) { scrolled.push(this.textContent || '') })
      await page.find('a[href="#last-words"]').trigger('click')
      expect(scrolled).toEqual(['Last words'])
      expect(reads.length).toBe(count)

      // A link from the folder's top.
      await page.find('a[href="/CHANGELOG.md"]').trigger('click')
      await flushPromises()
      expect(reads.at(-1)).toEqual({ pane: 'w1:p1', path: 'CHANGELOG.md' })
      expect(w.findAll('.files-crumb').map(c => c.text())).toEqual(['demo', 'CHANGELOG.md'])
      await w.find('button[aria-label="Back to folder"]').trigger('click')
      await flushPromises()
      expect(w.find('.files-md').exists()).toBe(false)
      expect(w.findAll('.tree-row')).toHaveLength(3)
    })

    it('opens a linked file at its anchor', async () => {
      const scrolled: string[] = []
      vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) { scrolled.push(this.textContent || '') })
      const w = await mountSuspended(FilesView, { props: { paneId: 'w1:p1', file: '/home/user/demo/docs/guide.md' } })
      await flushPromises()
      await w.find('.files-md a[href="setup.md#install-steps"]').trigger('click')
      await flushPromises()
      expect(reads.at(-1)).toEqual({ pane: 'w1:p1', path: '/home/user/demo/docs/setup.md', from: 'chat' })
      await vi.waitFor(() => expect(scrolled).toContain('Install steps'))
    })

    it('follows links of a file named in a conversation, with Back to the previous file', async () => {
      const w = await mountSuspended(FilesView, { props: { paneId: 'w1:p1', file: '/home/user/notes/plan.md' } })
      await flushPromises()
      expect(w.find('button[aria-label="Back to folder"]').exists()).toBe(false)
      await w.find('.files-md a[href="todo.md"]').trigger('click')
      await flushPromises()
      expect(reads.at(-1)).toEqual({ pane: 'w1:p1', path: '/home/user/notes/todo.md', from: 'chat' })
      expect(w.find('.files-md h1').text()).toBe('Todo')
      // Refresh reads the file shown, not the one first named.
      await w.find('button[aria-label="Refresh"]').trigger('click')
      await flushPromises()
      expect(reads.at(-1)).toEqual({ pane: 'w1:p1', path: '/home/user/notes/todo.md', from: 'chat' })
      await w.find('button[aria-label="Back to folder"]').trigger('click')
      await flushPromises()
      expect(w.find('.files-md h1').text()).toBe('Plan')
      expect(w.find('button[aria-label="Back to folder"]').exists()).toBe(false)
    })

  })
})
