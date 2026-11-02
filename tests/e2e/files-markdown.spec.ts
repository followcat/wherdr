import { expect, test, type Page } from './test'
import { OMP_CHAT_PANE } from './scenario.mjs'

// A Markdown file in the file explorer: formatted by default (headings, task
// list, a wide table that scrolls by itself, coloured code, an image read from
// the folder), sanitised, with a Rendered / Source toggle kept on the device
// and relative links that open the other file here. A fictional project.
const ROOT = '/srv/lantern'
const DIAGRAM = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="90" viewBox="0 0 360 90"><rect width="360" height="90" fill="#14171d"/><g fill="none" stroke="#b18cff" stroke-width="2"><rect x="12" y="25" width="90" height="40"/><rect x="135" y="25" width="90" height="40"/><rect x="258" y="25" width="90" height="40"/><path d="M102 45h33M225 45h33"/></g><g fill="#d8dce6" font-family="monospace" font-size="12" text-anchor="middle"><text x="57" y="49">sensor</text><text x="180" y="49">queue</text><text x="303" y="49">lamp</text></g></svg>`
const README = [
  '# Lantern',
  '',
  'A small **fictional** service that turns sensor readings into lamp colours. See [setup](docs/setup.md), the [changelog](/CHANGELOG.md#v0-3-0) or [the project page](https://example.com/lantern).',
  '',
  '![Data flow](docs/diagram.svg)',
  '',
  '## Status',
  '',
  '- [x] Read the sensors',
  '- [x] Queue the readings',
  '- [ ] Dim the lamps at night',
  '',
  '> Readings older than a minute are dropped.',
  '',
  '## Settings',
  '',
  '| Name | Default | Unit | Range | Applies to | Notes |',
  '| ---- | ------- | ---- | ----- | ---------- | ----- |',
  '| `poll_interval` | 5 | seconds | 1–60 | every sensor | Lower values drain batteries faster |',
  '| `max_brightness` | 80 | percent | 0–100 | every lamp | Capped at night by the dimmer |',
  '',
  '## Run it',
  '',
  '```bash',
  '# start the service',
  'lantern serve --port 8080',
  '```',
  '',
  '```ts',
  'export function colour(reading: number): string {',
  '  return reading > 30 ? "red" : "green" // warm or calm',
  '}',
  '```',
  '',
  '<style>.agent-top{display:none}</style><img src="x" alt="probe" onerror="alert(1)">',
].join('\n')
const SETUP = '# Setup\n\n1. Install the service.\n2. Copy `lantern.toml` next to it.\n\nBack to the [overview](../README.md).\n'
const FILES: Record<string, { kind: 'text' | 'image', body: string }> = {
  'README.md': { kind: 'text', body: README },
  'docs/setup.md': { kind: 'text', body: SETUP },
  'CHANGELOG.md': { kind: 'text', body: '# Changelog\n\n## v0.3.0\n\nDimmer.\n' },
  'docs/diagram.svg': { kind: 'image', body: `data:image/svg+xml;base64,${Buffer.from(DIAGRAM).toString('base64')}` },
}
const listings: Record<string, unknown> = {
  '': { root: ROOT, path: '', truncated: false, entries: [
    { name: 'docs', kind: 'dir', size: null, link: false },
    { name: 'CHANGELOG.md', kind: 'file', size: 52, link: false },
    { name: 'README.md', kind: 'file', size: README.length, link: false },
  ] },
  'docs': { root: ROOT, path: 'docs', truncated: false, entries: [
    { name: 'diagram.svg', kind: 'file', size: DIAGRAM.length, link: false },
    { name: 'setup.md', kind: 'file', size: SETUP.length, link: false },
  ] },
}

async function openReadme(page: Page) {
  const read: string[] = []
  await page.route('**/api/files?**', r => r.fulfill({ json: listings[new URL(r.request().url()).searchParams.get('path') ?? ''] }))
  await page.route('**/api/files/read?**', (r) => {
    const path = new URL(r.request().url()).searchParams.get('path')!
    read.push(path)
    const f = FILES[path]
    if (!f) return r.fulfill({ status: 404, json: { error: 'not_found', message: 'Not found' } })
    return r.fulfill({ json: f.kind === 'image'
      ? { path, size: DIAGRAM.length, kind: 'image', dataUrl: f.body, truncated: false }
      : { path, size: f.body.length, kind: 'text', text: f.body, truncated: false } })
  })
  page.on('dialog', d => { throw new Error(`unexpected dialog: ${d.message()}`) })
  await page.goto(`/#/a/${OMP_CHAT_PANE}`)
  await expect(page.locator('.chat').getByText('Ready when you are.')).toBeVisible()
  await page.locator('.agent-top').getByRole('button', { name: 'Options', exact: true }).click()
  await page.getByRole('menuitem', { name: /^(Browse files|Parcourir les fichiers)$/ }).or(page.getByRole('button', { name: /^(Browse files|Parcourir les fichiers)$/ })).click()
  await page.locator('.files-entry', { hasText: 'README.md' }).click()
  return read
}

test('a Markdown file is shown formatted, sanitised, with its own images and links', async ({ page }, info) => {
  const read = await openReadme(page)
  const doc = page.locator('.files-md')
  await expect(doc.getByRole('heading', { level: 1, name: 'Lantern' })).toBeVisible()
  await expect(doc.locator('li input[type="checkbox"]')).toHaveCount(3)
  await expect(doc.locator('.code-block .hl-k', { hasText: 'export' })).toBeVisible()
  await expect(doc.locator('.code-block .hl-c', { hasText: '# start the service' })).toBeVisible()
  await expect(doc.locator('.code-run')).toHaveCount(0)
  // The image is read from the folder, never from the app's address.
  const diagram = doc.locator('img[alt="Data flow"]')
  await expect(diagram).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/)
  await expect.poll(() => diagram.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0)
  expect(read).toContain('docs/diagram.svg')
  // The file's raw HTML neither restyles the app nor runs anything.
  await expect(doc.locator('style')).toHaveCount(0)
  await expect(page.locator('.agent-top')).toBeVisible()
  await expect(doc.locator('img[alt="probe"]')).not.toHaveAttribute('onerror')
  // A wide table scrolls by itself; the page never scrolls sideways.
  const table = doc.locator('table')
  const sizes = await table.evaluate(t => ({ scroll: t.scrollWidth, client: t.clientWidth, page: document.documentElement.scrollWidth, view: innerWidth }))
  expect(sizes.page).toBeLessThanOrEqual(sizes.view)
  if (info.project.name.includes('phone')) expect(sizes.scroll).toBeGreaterThan(sizes.client)
  await expect(doc.locator('a[href="https://example.com/lantern"]')).toHaveAttribute('target', '_blank')
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${info.project.name}-files-markdown.png` })
  if (process.env.SHOTS) {
    await doc.locator('.code-block').last().scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${process.env.SHOTS}/${info.project.name}-files-markdown-code.png` })
  }

  // A relative link opens the other file here, in its folder.
  await doc.getByRole('link', { name: 'setup' }).click()
  await expect(page.locator('.files-md').getByRole('heading', { level: 1, name: 'Setup' })).toBeVisible()
  await expect(page.locator('.files-crumb.current')).toHaveText('setup.md')
  await expect(page.locator('.files-crumb').nth(1)).toHaveText('docs')
  await page.locator('.files-md').getByRole('link', { name: 'overview' }).click()
  await expect(page.locator('.files-md').getByRole('heading', { level: 1, name: 'Lantern' })).toBeVisible()

  // Source: the raw text with line numbers, remembered after a reload.
  await page.locator('.files-md-mode').getByRole('button', { name: 'Source' }).click()
  await expect(page.locator('.files-text')).toContainText('# Lantern')
  await expect(page.locator('.files-num')).toContainText('1\n2\n3')
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeVisible()
  await page.reload()
  await page.locator('.agent-top').getByRole('button', { name: 'Options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Browse files', exact: true }).or(page.getByRole('button', { name: 'Browse files', exact: true })).click()
  await page.locator('.files-entry', { hasText: 'README.md' }).click()
  await expect(page.locator('.files-text')).toContainText('# Lantern')
  await expect(page.locator('.files-md-mode').getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'true')
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${info.project.name}-files-markdown-source.png` })
})

test('the Markdown toggle stays English with a legacy French preference', async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem('herdrLanguage', 'fr'))
  await openReadme(page)
  const toggle = page.locator('.files-md-mode')
  await expect(toggle).toHaveAttribute('aria-label', 'Markdown view')
  await expect(toggle.getByRole('button', { name: 'Rendered' })).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle.getByRole('button', { name: 'Source' })).toBeVisible()
  await expect(page.locator('.files-md').getByRole('heading', { level: 1, name: 'Lantern' })).toBeVisible()
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${info.project.name}-files-markdown-fr.png` })
})

// Each file read gets its own images: Refresh reads them again, and another
// file with the same text shows its own, not the previous one's.
test('images follow the file shown and Refresh', async ({ page }) => {
  const svg = (fill: string) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="${fill}"/></svg>`).toString('base64')}`
  const text = 'Pictures.\n\n![Diagram](diagram.svg)\n\n[Other](b/README.md)\n'
  const images: Record<string, string> = { 'diagram.svg': svg('red'), 'b/diagram.svg': svg('blue') }
  const read: string[] = []
  await page.route('**/api/files?**', r => r.fulfill({ json: { root: ROOT, path: new URL(r.request().url()).searchParams.get('path') ?? '', truncated: false, entries: [{ name: 'README.md', kind: 'file', size: text.length, link: false }] } }))
  await page.route('**/api/files/read?**', (r) => {
    const path = new URL(r.request().url()).searchParams.get('path')!
    read.push(path)
    if (path.endsWith('README.md')) return r.fulfill({ json: { path, size: text.length, kind: 'text', text, truncated: false } })
    return r.fulfill({ json: { path, size: 100, kind: 'image', dataUrl: images[path], truncated: false } })
  })
  await page.goto(`/#/a/${OMP_CHAT_PANE}`)
  await expect(page.locator('.chat').getByText('Ready when you are.')).toBeVisible()
  await page.locator('.agent-top').getByRole('button', { name: 'Options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Browse files', exact: true }).or(page.getByRole('button', { name: 'Browse files', exact: true })).click()
  await page.locator('.files-entry', { hasText: 'README.md' }).click()
  const img = page.locator('.files-md img[alt="Diagram"]')
  await expect(img).toHaveAttribute('src', svg('red'))

  images['diagram.svg'] = svg('green')
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(img).toHaveAttribute('src', svg('green'))

  await page.locator('.files-md').getByRole('link', { name: 'Other' }).click()
  await expect(page.locator('.files-crumb.current')).toHaveText('README.md')
  await expect(page.locator('.files-crumb').nth(1)).toHaveText('b')
  await expect(img).toHaveAttribute('src', svg('blue'))
  expect(read.filter(p => p === 'diagram.svg')).toHaveLength(2)
  expect(read).toContain('b/diagram.svg')
})
