import { expect, test, type Page } from './test'
import fs from 'node:fs/promises'
import { OMP_CHAT_PANE, fakeHerdr } from './scenario.mjs'

test.describe('English interface', () => {
  const language = 'en'
  test(`machine connection diagnostics and legacy fallback (${language})`, async ({ page }) => {
    await expect.poll(async () => (await (await page.request.get('/api/state')).json()).ok).toBe(true)
    const base = await (await page.request.get('/api/state')).json()
    const state = { ...base, machines: [
      { key: '', label: 'Server', local: true, status: 'online', error: null },
      { key: 'abcdef01', label: 'Workbox', local: false, status: 'offline', error: 'SSH approval needed' },
    ] }
    await page.routeWebSocket('**/ws/events', ws => ws.send(JSON.stringify(state)))
    await page.addInitScript(lang => localStorage.setItem('herdrLanguage', lang), language)
    let supported = true
    const calls: string[] = []
    await page.route('**/api/machine/status', route => {
      expect(route.request().postDataJSON()).toEqual({ key: 'abcdef01' })
      calls.push('status')
      return route.fulfill({ json: supported
        ? { supported: true, status: 'auth required', error: 'SSH approval needed', reconnect: "herdr machine reconnect 'abcdef0123456789abcdef0123456789'" }
        : { supported: false, status: null, error: null, reconnect: null } })
    })
    await page.route('**/api/machine/reconnect', route => {
      expect(route.request().postDataJSON()).toEqual({ key: 'abcdef01' })
      calls.push('retry')
      return route.fulfill({ json: { ok: true } })
    })
    await page.goto('/')
    await page.locator('[data-machine="abcdef01"] .machine-options').click()
    await page.getByRole('menuitem', { name: 'Connection status' }).click()
    const sheet = page.locator('.machine-connection')
    await expect(sheet).toContainText('Authentication required')
    await expect(sheet.locator('code')).toContainText('herdr machine reconnect')
    await fs.mkdir('.shots', { recursive: true })
    await page.screenshot({ path: `.shots/machine-connection-${language}-phone.png` })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.screenshot({ path: `.shots/machine-connection-${language}-desktop.png` })
    supported = false
    await sheet.getByRole('button', { name: 'Retry connection' }).click()
    await expect(sheet).toContainText('require Herdr 0.9.2')
    await expect(sheet.locator('code')).toHaveCount(0)
    expect(calls).toEqual(['status', 'retry', 'status'])
  })
})

test('structured terminal mouse: touch tap, desktop drag, Shift selection and old Herdr', async ({ page, browser }) => {
  await fs.mkdir('.shots', { recursive: true })
  const events = async () => (await fakeHerdr('e2e.terminal_mouse', {})).events
  await fakeHerdr('e2e.terminal_version', { version: '0.9.2' })
  await expect.poll(async () => (await (await page.request.get('/api/state')).json()).version).toBe('0.9.2')
  await page.addInitScript(() => localStorage.setItem('terminalRenderer', 'html'))
  async function open(page: Page) {
    await page.goto(`/#/a/${OMP_CHAT_PANE}`)
    const output = page.locator('#term .xterm-rows')
    await expect(page.locator('.chat').getByText('Ready when you are.').or(output)).toBeVisible()
    if (!await output.isVisible()) {
      const tabs = page.locator('.view-toggle')
      if (await tabs.count()) await tabs.click()
      else await page.locator('button[aria-label="Terminal"]').first().click()
    }
    await expect(page.locator('#term .xterm-rows')).toContainText('fake terminal')
  }
  await open(page)
  const screen = page.locator('#term .xterm-screen')
  const box = (await screen.boundingBox())!
  await page.touchscreen.tap(box.x + 30, box.y + 30)
  await expect.poll(async () => (await events()).filter((x: any) => x.event.action === 'down').length).toBe(1)
  await expect.poll(async () => (await events()).filter((x: any) => x.event.action === 'up').length).toBe(1)
  await page.screenshot({ path: '.shots/terminal-mouse-phone.png' })
  await page.goto('/')
  await expect.poll(async () => (await fakeHerdr('e2e.pane_size', { pane_id: OMP_CHAT_PANE })).attached).toBe(false)
  // A desktop context has a fine pointer: resizing a touch context leaves the
  // phone's touch overlay enabled and cannot exercise desktop mouse routing.
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  try {
    const desktopPage = await context.newPage()
    await desktopPage.addInitScript(() => localStorage.setItem('terminalRenderer', 'html'))
    expect(await desktopPage.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)).toBe(true)
    await open(desktopPage)
    const desktopScreen = desktopPage.locator('#term .xterm-screen')
    const desktop = (await desktopScreen.boundingBox())!
    await desktopPage.mouse.move(desktop.x + 20, desktop.y + 20)
    await desktopPage.mouse.down()
    await desktopPage.mouse.move(desktop.x + 90, desktop.y + 20, { steps: 3 })
    await desktopPage.mouse.up()
    await expect.poll(async () => (await events()).some((x: any) => x.event.action === 'drag')).toBe(true)
    const before = (await events()).filter((x: any) => x.event.action === 'down').length
    await desktopPage.keyboard.down('Shift')
    await desktopPage.mouse.move(desktop.x + 10, desktop.y + 10)
    await desktopPage.mouse.down()
    await desktopPage.mouse.move(desktop.x + 100, desktop.y + 10, { steps: 3 })
    await desktopPage.mouse.up()
    await desktopPage.keyboard.up('Shift')
    expect((await events()).filter((x: any) => x.event.action === 'down').length).toBe(before)
    await desktopPage.screenshot({ path: '.shots/terminal-mouse-desktop.png' })
    await desktopPage.goto('/')
    await expect.poll(async () => (await fakeHerdr('e2e.pane_size', { pane_id: OMP_CHAT_PANE })).attached).toBe(false)
    await fakeHerdr('e2e.terminal_version', { version: '0.9.1' })
    await open(desktopPage)
    await desktopScreen.click({ position: { x: 20, y: 20 } })
    expect(await events()).toEqual([])
    await desktopPage.goto('/')
  } finally { await context.close() }
})
