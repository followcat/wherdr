import { expect, test } from './test'
import fs from 'node:fs/promises'

test('Board follows the sidebar tab and keeps manual choices through refreshes', async ({ page }) => {
  await expect.poll(async () => (await (await page.request.get('/api/state')).json()).ok).toBe(true)
  const base = await (await page.request.get('/api/state')).json()
  const keys = ['', 'laptop']
  const state = { ...base, machines: keys.map((key, i) => ({ key, label: ['Server', 'Laptop'][i], local: !key, status: 'online', error: null, session: 'default' })) }
  await page.routeWebSocket('**/ws/events', ws => ws.send(JSON.stringify(state)))
  let reads = 0
  await page.route('**/api/tasks?*', route => {
    reads++
    return route.fulfill({ json: { version: String(reads), machines: keys.map(machine => ({ machine, status: 'ready', version: '1', tasks: [], at: Date.now() })) } })
  })
  await page.route('**/api/tasks', route => {
    reads++
    return route.fulfill({ json: { version: String(reads), machines: keys.map(machine => ({ machine, status: 'ready', version: '1', tasks: [], at: Date.now() })) } })
  })
  await page.addInitScript(() => {
    localStorage.setItem('machineGroups', JSON.stringify([{ id: '*group:personal', name: 'Personal', machines: [''] }]))
  })
  // A fake clock (time still flows): the Board's 15 s poll is fired at once below.
  await page.clock.install()
  await page.goto('/')
  await page.locator('[data-bar-id="*group:personal"]').click()
  await page.goto('/#/board')
  const select = page.getByRole('combobox', { name: 'Machines shown' })
  await expect(select).toContainText('Personal')
  await select.click()
  await page.getByRole('option', { name: 'All machines', exact: true }).click()
  await expect(select).toContainText('All machines')
  const before = reads
  await page.clock.fastForward(15_000)
  await expect.poll(() => reads).toBeGreaterThan(before)
  await expect(select).toContainText('All machines')
  // A page reload on the same tab keeps it too.
  await page.reload()
  await expect(select).toContainText('All machines')
  // Leaving the Board and coming back on the same tab keeps the choice.
  await page.evaluate(() => { location.hash = '#/' })
  await expect(page.locator('[data-bar-id="laptop"]')).toBeVisible()
  await page.evaluate(() => { location.hash = '#/board' })
  await expect(select).toContainText('All machines')
  // Switching tabs away from the Board resets the earlier manual choice.
  await page.evaluate(() => { location.hash = '#/' })
  await page.locator('[data-bar-id="laptop"]').click()
  await page.locator('[data-bar-id="*group:personal"]').click()
  await page.evaluate(() => { location.hash = '#/board' })
  await expect(select).toContainText('Personal')
  await page.goto('/')
  await page.locator('[data-bar-id="laptop"]').click()
  await page.goto('/#/board')
  await expect(select).toContainText('Laptop')
  await fs.mkdir('.shots', { recursive: true })
  await page.screenshot({ path: '.shots/board-tab-scope-phone.png' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: '.shots/board-tab-scope-desktop.png' })
  // The sidebar stays available on desktop while the Board is open.
  await page.locator('[data-bar-id="*group:personal"]').click()
  await page.goto('/#/board')
  await expect(select).toContainText('Personal')
  await page.locator('[data-bar-id="*"]').click()
  await expect(select).toContainText('All machines')
})
