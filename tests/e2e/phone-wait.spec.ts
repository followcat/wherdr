import http from 'node:http'
import { expect, test, type Page } from './test'
import { BASE_URL, PORT } from './scenario.mjs'

// Settings › Phone right after publishing: the address waits for Tailscale's
// HTTPS certificate (a loader, no error, no QR code), then turns green with
// the QR code. /api/phone is intercepted: no Tailscale in the test box.
const URL = 'https://box.example.ts.net:7683/'
const status = (reach: 'pending' | 'ok') => ({
  mode: 'native', platform: 'linux', port: '7683', connected: true, https: true, url: URL, served: true, taken: false,
  suggested: URL, command: '', reach, reachCause: reach === 'ok' ? null : 'timeout', reachStatus: reach === 'ok' ? 200 : null,
  checkedAt: Date.now(), appUrl: URL, appUrlFromEnv: false,
  qr: reach === 'ok' ? { size: 9, path: 'M2 2h1v1h-1zM4 4h1v1h-1zM6 6h1v1h-1z' } : null,
})

test('waits for the HTTPS certificate with a loader, then shows the QR code', async ({ page }, testInfo) => {
  let reach: 'pending' | 'ok' = 'pending'
  await page.route('**/api/phone', route => route.fulfill({ json: status(reach) }))
  await page.goto('/#/settings?section=phone')
  const answers = page.locator('.phone-steps li', { hasText: 'ANSWERS' })
  await expect(answers).toContainText('Getting the HTTPS certificate from Tailscale')
  await expect(answers).toHaveClass(/\bwait\b/)
  await expect(page.locator('.phone-qr')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.phone-result.bad')).toHaveCount(0)
  await page.screenshot({ path: `.shots/phone-wait-${testInfo.project.name}.png` })

  reach = 'ok'
  await expect(answers).toHaveClass(/\bdone\b/, { timeout: 8000 })
  await expect(answers).toContainText('Your phone can open it.')
  await expect(page.locator('.phone-qr svg')).toBeVisible()
  await expect(page.locator('.phone-result.bad, .phone-note.warn')).toHaveCount(0)
  await page.screenshot({ path: `.shots/phone-ready-${testInfo.project.name}.png` })
})

// A browser opening an address that is not allowed yet: a readable page, not
// raw JSON; the API keeps its JSON error.
function get(path: string, accept: string) {
  return new Promise<{ status: number, type: string, body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path, headers: { host: 'not-enabled.example.ts.net', accept } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode || 0, type: String(res.headers['content-type']), body }))
    }).on('error', reject)
  })
}

test('a refused host gets a readable page in a browser, JSON for the API', async ({ page }, testInfo) => {
  const html = await get('/', 'text/html,application/xhtml+xml,*/*;q=0.8')
  expect(html.status).toBe(403)
  expect(html.type).toContain('text/html')
  expect(html.body).toContain('This address isn\'t enabled yet.')
  const api = await get('/api/state', 'text/html,*/*')
  expect(api.status).toBe(403)
  expect(JSON.parse(api.body)).toMatchObject({ code: 'host' })
  await page.setContent(html.body)
  await expect(page.getByRole('heading', { name: 'This address isn\'t enabled yet.' })).toBeVisible()
  await page.screenshot({ path: `.shots/host-refused-${testInfo.project.name}.png` })
})

test('the refusal page gives a command to run on the machine, in English only', async () => {
  const html = await get('/', 'text/html')
  // The test server is not on the default port: the command names it.
  expect(html.body).toContain(`<pre><code>npx wherdr phone --port ${PORT}</code></pre>`)
  // A tailnet name: the command alone, no setting to edit.
  expect(html.body).not.toContain('HERDR_WEB_ALLOWED_HOSTS')
  expect(html.body).toContain('This address isn\'t enabled yet.')
  expect(html.body).not.toContain('Cette adresse n’est pas encore activée.')
  expect(html.body).not.toContain('not-enabled.example.ts.net')
})

// What the phone address probes rely on (bin/lib/tailnet.mjs, the installer,
// the plugin): /api/health goes through the host check, the manifest does not.
test('/api/health tells a refused host, which the static manifest cannot', async ({ request }) => {
  const refused = await get('/api/health', 'application/json')
  expect(refused.status).toBe(403)
  expect(JSON.parse(refused.body)).toMatchObject({ code: 'host' })
  expect((await get('/manifest.webmanifest', 'application/json')).status).toBe(200)
  const ok = await request.get('/api/health')
  expect(await ok.json()).toMatchObject({ ok: true, name: 'wherdr' })
})

// The app opened on its tailnet address (HTTPS, not localhost): the requests
// of that origin are answered by the test server, and /api/phone does not
// answer, so the page shows the address it was opened on by itself.
const TAILNET = 'https://box.example.ts.net:7683'
async function onTailnet(page: Page) {
  await page.route(`${TAILNET}/**`, async (route) => {
    const url = route.request().url().replace(TAILNET, BASE_URL)
    if (new globalThis.URL(url).pathname === '/api/phone') {
      await route.fulfill({ status: 503, json: { error: 'Unavailable' } })
    } else await route.fulfill({ response: await route.fetch({ url }) })
  })
}

test('Settings › Phone on the tailnet address shows that address and its QR code', async ({ page }, testInfo) => {
  await onTailnet(page)
  await page.goto(`${TAILNET}/#/settings?section=phone`)
  const setup = page.locator('.phone-setup')
  await expect(setup.locator('.phone-qr svg')).toBeVisible()
  await expect(setup.locator('.phone-qr .phone-url')).toHaveText(`${TAILNET}/`)
  await expect(setup.locator('.phone-qr svg')).toHaveAttribute('aria-label', `QR code of ${TAILNET}/`)
  await expect(setup).toContainText('You are on wherdr’s phone address')
  await expect(setup).not.toContainText('http://localhost')
  await expect(setup.locator('.phone-note.warn')).toHaveCount(0)
  await page.screenshot({ path: `.shots/phone-on-tailnet-${testInfo.project.name}.png` })
})

test('the guide’s Phone step on the tailnet address shows it too, not "open localhost"', { tag: '@chromium-desktop' }, async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'a phone on the tailnet address gets Add to Home Screen instead')
  const setDone = async (done: boolean) => {
    const response = await page.request.post(`${BASE_URL}/api/onboarding`, { headers: { Origin: BASE_URL }, data: { done } })
    expect(response.ok()).toBe(true)
  }
  await onTailnet(page)
  await setDone(false)
  try {
    await page.goto(`${TAILNET}/#/setup?step=phone`)
    const guide = page.getByRole('dialog', { name: 'Setup guide' })
    await expect(guide.locator('[aria-current="step"]')).toHaveText('Phone')
    await expect(guide.locator('.phone-qr .phone-url')).toHaveText(`${TAILNET}/`)
    await expect(guide.locator('.phone-qr svg')).toBeVisible()
    await expect(guide).not.toContainText('http://localhost')
    await page.screenshot({ path: `.shots/guide-phone-on-tailnet-${testInfo.project.name}.png` })
  } finally { await setDone(true) }
})
