// Settings kept on the server (shared/settings.ts): taken from the browser on
// the first load, applied on another device without reloading, while the
// device's own settings stay in its browser.
import fs from 'node:fs/promises'
import { BASE_URL } from './scenario.mjs'
import { expect, test, type Page } from './test'

const serverSettings = async (page: Page) => (await (await page.request.get('/api/settings')).json()).settings as Record<string, string>
const themeOf = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme)
const groupBy = (page: Page, language: string) => page.getByRole('radio', { name: 'State', exact: true })

test('migration: each browser merges in its settings once, not the device ones', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('migrationFixture')) return
    localStorage.setItem('migrationFixture', '1')
    localStorage.setItem('theme', 'wherdr-graphite')
    localStorage.setItem('compactListV2', '1')
    localStorage.setItem('contentWidth', 'wide')
  })
  await page.goto('/')
  await expect.poll(() => serverSettings(page)).toMatchObject({ theme: 'wherdr-graphite', compactListV2: '1' })
  expect(await serverSettings(page)).not.toHaveProperty('contentWidth')
  await expect.poll(() => themeOf(page)).toBe('wherdr-graphite')
  // A second browser merges in its own settings the server lacks, and takes
  // the server's values for the others.
  const other = await page.context().browser()!.newContext({ baseURL: BASE_URL, viewport: page.viewportSize(), serviceWorkers: 'block' })
  const b = await other.newPage()
  const groups = JSON.stringify([{ id: '*group:ipad', name: 'iPad', machines: [''] }])
  await b.addInitScript((groups) => {
    if (localStorage.getItem('migrationFixture')) return
    localStorage.setItem('migrationFixture', '1')
    localStorage.setItem('theme', 'wherdr-neon')
    localStorage.setItem('machineGroups', groups)
  }, groups)
  await b.goto('/')
  await expect.poll(() => serverSettings(page)).toMatchObject({ theme: 'wherdr-graphite', compactListV2: '1', machineGroups: groups })
  await expect.poll(() => themeOf(b)).toBe('wherdr-graphite')
  expect(await b.evaluate(() => localStorage.getItem('machineGroups'))).toBe(groups)
  // Merged once: afterwards the server is the reference on this device too.
  await page.request.post(`${BASE_URL}/api/settings`, { headers: { Origin: BASE_URL }, data: { settings: { machineGroups: null } } })
  await b.reload()
  await expect.poll(() => b.evaluate(() => localStorage.getItem('machineGroups'))).toBeNull()
  expect(await b.evaluate(() => localStorage.getItem('contentWidth'))).not.toBe('wide')
  await other.close()
})

test.describe('English interface', () => {
  const language = 'en'
  test(`two devices: a change on one shows on the other without reloading (${language})`, async ({ page, browser }, info) => {
    const setLanguage = (l: string) => { localStorage.setItem('herdrLanguage', l) }
    await page.addInitScript(setLanguage, language)
    await page.goto('/#/settings?section=appearance')
    const other = await browser.newContext({ baseURL: BASE_URL, viewport: page.viewportSize(), serviceWorkers: 'block' })
    const b = await other.newPage()
    await b.addInitScript(setLanguage, language)
    await b.goto('/#/settings?section=appearance')
    await expect(groupBy(b, language)).not.toBeChecked()
    const before = await themeOf(b)
    expect(before).not.toBe('wherdr-graphite')

    // Device A: a theme, "Group by" State, and its own content width.
    await page.locator('.theme-current').click()
    await page.locator('.theme-list .theme-opt', { hasText: 'wherdr Graphite' }).click()
    await groupBy(page, language).check()
    await page.evaluate(() => localStorage.setItem('contentWidth', 'full'))

    // Device B follows, on the same page, without a reload.
    await expect.poll(() => themeOf(b)).toBe('wherdr-graphite')
    await expect(b.locator('.theme-current')).toContainText('wherdr Graphite')
    await expect(groupBy(b, language)).toBeChecked()
    expect(await serverSettings(page)).toMatchObject({ theme: 'wherdr-graphite', homeGrouping: 'state' })
    // The device setting stayed on device A.
    expect(await serverSettings(page)).not.toHaveProperty('contentWidth')
    expect(await b.evaluate(() => localStorage.getItem('contentWidth'))).toBe('normal')

    // Back on B: its change reaches A (last write wins, setting by setting).
    await b.getByRole('radio', { name: 'Machine', exact: true }).check()
    await expect(groupBy(page, language)).not.toBeChecked()
    await expect.poll(() => themeOf(page)).toBe('wherdr-graphite')

    await fs.mkdir('.shots', { recursive: true })
    await page.evaluate(() => document.fonts.ready)
    await b.screenshot({ path: `.shots/synced-settings-${language}-${info.project.name}.png` })
    await b.goto('/')
    await b.evaluate(() => document.fonts.ready)
    await b.screenshot({ path: `.shots/synced-home-${language}-${info.project.name}.png` })
    await other.close()
  })
})

test('a change made right before a reload is kept', async ({ page }) => {
  await page.goto('/#/settings?section=appearance')
  await groupBy(page, 'en').check()
  await page.reload()
  await expect(groupBy(page, 'en')).toBeChecked()
  await expect.poll(() => serverSettings(page)).toMatchObject({ homeGrouping: 'state' })
})
