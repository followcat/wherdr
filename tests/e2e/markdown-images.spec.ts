import { expect, test, type Page } from './test'
import { MD_IMAGES, OMP_IMAGE_PANE as pane, fakeHerdr, gradientPng } from './scenario.mjs'

// Markdown images in an agent reply, with the app's real Content Security
// Policy (served by the built app, never relaxed here). The server is reached
// by the tailnet name box.example.ts.net (HERDR_WEB_ALLOWED_HOSTS, launch.mjs):
// HTTPS images from any machine and port of example.ts.net load; any other
// source is refused by the browser before a request leaves; a refused or
// unreachable image becomes a readable note with a link to it.
// Remote addresses are answered by page.route: a request the policy blocks
// never reaches it.

const png = gradientPng(320, 200)
let original: string | null = null
let hits: string[] = []
let violations: string[] = []

async function openReply(page: Page) {
  hits = []
  violations = []
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', e => ((window as unknown as { __csp: string[] }).__csp ||= []).push(`${e.effectiveDirective} ${e.blockedURI}`))
  })
  await page.route(/^https?:\/\/[^/]*\.(?:example\.ts\.net|other-tailnet\.ts\.net|example\.com)(?::\d+)?\//, (route) => {
    const url = route.request().url()
    hits.push(url)
    if (url === MD_IMAGES.missing) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' })
    // Every other address answers a valid PNG: an image left broken was refused by the policy.
    return route.fulfill({ status: 200, contentType: 'image/png', body: png })
  })
  const response = await page.goto(`/#/a/${pane}`)
  await expect(page.locator('.chat').getByText('End of the captures.')).toBeVisible()
  // Every image of the reply settled (loaded, refused or failed).
  await expect.poll(() => reply(page).evaluate(el => [...el.querySelectorAll('img')].every(i => i.complete))).toBe(true)
  return response!
}

const reply = (page: Page) => page.locator('.msg-ai .md-body').filter({ hasText: 'Here are the captures.' })
const image = (page: Page, src: string) => reply(page).locator(`img[src="${src}"]`)
const loaded = (page: Page, src: string) => image(page, src).evaluate(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth)
const note = (page: Page, src: string) => reply(page).locator('.md-img-fallback').filter({ has: page.locator(`a[href="${src}"]`) })

test.beforeAll(async () => {
  original = (await fakeHerdr('e2e.pane_field', { pane_id: pane, field: 'session' }) as { value: string }).value
  const file = (await fakeHerdr('e2e.pane_field', { pane_id: pane, field: 'markdownImages' }) as { value: string }).value
  await fakeHerdr('e2e.update_session', { pane_id: pane, session: file })
})
test.afterAll(async () => {
  await fakeHerdr('e2e.update_session', { pane_id: pane, session: original })
})

test('images from other machines and ports of the tailnet load under the real policy', { tag: '@webkit-phone' }, async ({ page }) => {
  const response = await openReply(page)
  const policy = response.headers()['content-security-policy'] || ''
  expect(policy).toContain("img-src 'self' data: blob: https://*.example.ts.net:*")

  for (const src of [MD_IMAGES.otherPort, MD_IMAGES.otherMachine]) {
    await expect.poll(() => loaded(page, src), src).toBe(320)
    await expect(image(page, src)).toBeVisible()
    await expect(note(page, src)).toHaveCount(0)
  }
  expect(hits).toEqual(expect.arrayContaining([MD_IMAGES.otherPort, MD_IMAGES.otherMachine]))
})

test('an image from a source outside the tailnet is refused and shown as a link', { tag: '@webkit-phone' }, async ({ page }, info) => {
  await openReply(page)
  // Tall enough for the whole reply on one screenshot (review evidence).
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 2400 })
  await reply(page).scrollIntoViewIfNeeded()
  await page.screenshot({ path: `.shots/markdown-images-${info.project.name}.png` })
  for (const src of [MD_IMAGES.outside, MD_IMAGES.otherTailnet, MD_IMAGES.plainHttp]) {
    const n = note(page, src)
    await expect(n, src).toBeVisible()
    await expect(n).toContainText('Image not shown')
    await expect(n).toContainText('wherdr only shows images from its own address and from HTTPS addresses on your tailnet.')
    await expect(n.getByRole('link', { name: 'Open image' })).toHaveAttribute('target', '_blank')
    await expect(n).toContainText(src.replace(/^https?:\/\//, ''))
    await expect(image(page, src)).toBeHidden()
  }
  // Refused by the browser itself: no request left for these addresses.
  for (const src of [MD_IMAGES.outside, MD_IMAGES.otherTailnet, MD_IMAGES.plainHttp]) expect(hits).not.toContain(src)
  const reported = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp || [])
  expect(reported.filter(v => v.startsWith('img-src')).length).toBeGreaterThanOrEqual(3)
})

test('an image that cannot be loaded says so, with its link', async ({ page }) => {
  await openReply(page)
  const n = note(page, MD_IMAGES.missing)
  await expect(n).toBeVisible()
  await expect(n).toContainText('Image not shown')
  await expect(n).toContainText('The image could not be loaded.')
  await expect(n).not.toContainText('only shows images')
  await expect(n.getByRole('link', { name: 'Open image' })).toHaveAttribute('href', MD_IMAGES.missing)
  // Allowed by the policy: the request was made.
  expect(hits).toContain(MD_IMAGES.missing)
})

test('wherdr\'s own images, inline images and tool images still load', async ({ page }) => {
  await openReply(page)
  await expect.poll(() => loaded(page, MD_IMAGES.local)).toBe(192)
  const dot = reply(page).locator('img[src^="data:image/png"]')
  await expect.poll(() => dot.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(8)
  const thumb = page.locator('.tool-thumbs .msg-img').first()
  await expect.poll(() => thumb.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(240)
  await expect(reply(page).locator('.md-img-fallback')).toHaveCount(4)
})

test('a tap opens an allowed tailnet image, a local one and a tool image in the viewer', { tag: '@webkit-phone' }, async ({ page }) => {
  await openReply(page)
  const viewer = page.locator('.lightbox img')
  const close = page.locator('.lightbox').getByRole('button', { name: 'Close' })
  for (const src of [MD_IMAGES.otherPort, MD_IMAGES.local]) {
    await expect.poll(() => loaded(page, src)).toBeGreaterThan(0)
    await image(page, src).click()
    await expect(viewer).toHaveAttribute('src', new RegExp(`${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
    await expect.poll(() => viewer.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await close.click()
    await expect(viewer).toHaveCount(0)
  }
  await page.locator('.tool-thumbs .msg-img').first().click()
  await expect(viewer).toHaveAttribute('src', /\/api\/chat\/image\?pane=/)
  await expect.poll(() => viewer.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(240)
})
