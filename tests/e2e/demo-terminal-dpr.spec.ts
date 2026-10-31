import { execFileSync } from 'node:child_process'
import { devices, expect, test, type Browser } from './test'
import { serveDemo } from '../../tools/launch-video/serve.mjs'

// The demo terminal (WebGL renderer) looks the same at every devicePixelRatio:
// same CSS cell size, a backing store scaled by the DPR, and glyphs drawn at
// the same CSS size. Chromium may report the canvas device-pixel size in CSS
// pixels; trusted, it drew every glyph twice as large at DPR 2.
const DEV_SERVER = 'w4:p2' // app/demo/scenario.ts: a shell pane, opened on its terminal

let server: { url: string, close: () => Promise<void> }

test.beforeAll(async () => {
  // Contexts are made here with their own device and DPR: one project is enough.
  test.skip(test.info().project.name !== 'chromium-phone', 'runs on chromium-phone')
  test.setTimeout(180_000)
  // Built here so the test never runs an outdated demo (≈ 15 s).
  execFileSync('npm', ['run', 'build:demo'], { stdio: 'ignore', timeout: 170_000 })
  server = await serveDemo('.output-demo/public')
})
test.afterAll(async () => { await server?.close() })

async function measure(browser: Browser, dpr: number) {
  const context = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: dpr, serviceWorkers: 'block', locale: 'en-US' })
  const page = await context.newPage()
  await page.goto(server.url)
  await page.locator('.card[data-pane]').first().waitFor()
  await page.evaluate((h) => { location.hash = h }, `#/a/${DEV_SERVER}`)
  const canvas = page.locator('.xterm-screen canvas:not(.xterm-link-layer)')
  await expect(canvas).toHaveCount(1)
  await page.evaluate(() => document.fonts.ready)
  // The recorded output is on screen and xterm's resizes have settled.
  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.width), { timeout: 5000 }).toBeGreaterThan(0)
  await page.waitForFunction(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))
  const box = await canvas.evaluate((c: HTMLCanvasElement) => {
    const r = c.getBoundingClientRect()
    return { cssWidth: r.width, cssHeight: r.height, width: c.width, height: c.height }
  })
  const screen = page.locator('.xterm-screen')
  const shot = await screen.screenshot({ scale: 'css' })
  // Bounding box of the drawn text, in CSS pixels.
  const ink = await page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    const bg = [d[0]!, d[1]!, d[2]!]
    let left = c.width, top = c.height, right = -1, bottom = -1
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4
        if (Math.abs(d[i]! - bg[0]!) + Math.abs(d[i + 1]! - bg[1]!) + Math.abs(d[i + 2]! - bg[2]!) < 60) continue
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y)
      }
    }
    return { left, top, right, bottom }
  }, shot.toString('base64'))
  const pageShot = await page.screenshot()
  await context.close()
  return { box, ink, pageShot }
}

test('the demo terminal has the same cell size at DPR 1, 2 and 3', async ({ browser }, info) => {
  const one = await measure(browser, 1)
  expect(one.ink.right).toBeGreaterThan(100) // the recorded output is drawn
  for (const dpr of [2, 3]) {
    const m = await measure(browser, dpr)
    // Same CSS size, backing store scaled by the DPR.
    expect(m.box.cssWidth).toBe(one.box.cssWidth)
    expect(m.box.cssHeight).toBe(one.box.cssHeight)
    expect(Math.abs(m.box.width - one.box.cssWidth * dpr)).toBeLessThanOrEqual(dpr)
    expect(Math.abs(m.box.height - one.box.cssHeight * dpr)).toBeLessThanOrEqual(dpr)
    // The same text at the same place and size, in CSS pixels.
    for (const k of ['left', 'top', 'right', 'bottom'] as const) expect(Math.abs(m.ink[k] - one.ink[k]), `${k} at DPR ${dpr}`).toBeLessThanOrEqual(2)
    if (dpr === 2) await info.attach('demo terminal at DPR 2', { body: m.pageShot, contentType: 'image/png' })
  }
  await info.attach('demo terminal at DPR 1', { body: one.pageShot, contentType: 'image/png' })
})
