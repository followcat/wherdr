import { expect, test } from './test'
import fs from 'node:fs/promises'

test('long task titles keep their full height above badges', { tag: '@webkit-phone' }, async ({ page }) => {
  test.setTimeout(60_000)
  const row = {
    id: 'demo/11', repo: 'demo', repoKey: 'DEMO', n: 11, state: 'working',
    kind: 'agent', stage: 'working',
    title: 'Passive reading and agent allowance, solutions for the lunar garden and its seasonal planting schedule',
    msg: '', app: 'claude', progress: null, eta: null, pr: '', review: null,
    reviewRound: 0, research: true, archived: false, queue: null, group: 'working',
  }
  await page.route('**/api/tasks**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/tasks') return route.fulfill({ json: {
      version: 'title-fixture', machines: [{ machine: 'remote', status: 'ready', version: '1.2.21', tasks: [row] }],
    } })
    if (url.pathname === '/api/tasks/details') return route.fulfill({ json: {
      ...row, pane: null, description: 'Garden planning details.\n\n'.repeat(80),
    } })
    return route.fulfill({ json: { agent: null, agents: [], settings: [], problems: [] } })
  })
  await page.goto('/#/board?machine=remote&task=demo%2F11')
  await page.locator('.board-panel-sheet').click()
  const sheet = page.getByRole('dialog')
  const title = sheet.locator('.hw-sheet-title')
  const badges = sheet.locator('.task-sheet-meta')
  await expect(title).toHaveText(row.title)
  await expect(badges).toContainText('DEMO-11')
  await expect(sheet.locator('.task-description')).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await fs.mkdir('.shots', { recursive: true })
  // Keep the same overflowing body while exercising narrow, phone, tablet
  // and desktop widths. Only the body may shrink; every title line stays above it.
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
    await expect.poll(async () => {
      const heading = await title.boundingBox()
      const meta = await badges.boundingBox()
      return heading && meta ? meta.y - (heading.y + heading.height) : -1
    }).toBeGreaterThanOrEqual(0)
    const heading = (await title.boundingBox())!
    const lineHeight = await title.evaluate(el => Number.parseFloat(getComputedStyle(el).lineHeight))
    if (width <= 390) expect(heading.height).toBeGreaterThanOrEqual(lineHeight * 3)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (width === 390 || width === 1440) {
      await page.screenshot({ path: `.shots/task-title-${width}.png` })
    }
  }
})
