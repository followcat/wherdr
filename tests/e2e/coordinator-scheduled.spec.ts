import { expect, test } from './test'

// Isolated API fixtures; no coordinator commands or real board data are used.
test.describe('English interface', () => {
  const language = 'en'
test(`scheduled disclosure (${language}) is lazy, read only, compact on phone and desktop, and refreshes with the board`, async ({ page }) => {
  await page.addInitScript(language => localStorage.setItem('herdrLanguage', language), language)
  let reads = 0
  let empty = false
  await page.route('**/api/tasks', route => route.fulfill({ json: { version: 'scheduled', machines: [{ machine: '', status: 'ready', version: '1.2.1', tasks: [] }] } }))
  await page.route('**/api/tasks?**', route => route.fulfill({ json: { same: true } }))
  await page.route('**/api/tasks/coordinator?**', route => route.fulfill({ json: { state: 'none', pane: null } }))
  await page.route('**/api/tasks/scheduled?**', route => {
    reads++
    expect(route.request().method()).toBe('GET')
    return route.fulfill({ json: { timezone: 'Australia/Brisbane', warnings: [],
      autopilot: empty ? null : { on: true, frequency: 'every 2h', goal: 'Keep the demo build green', today: '1 of 3 added · 1 of 2 under way', last: Date.parse('2026-01-05T00:00:00Z'), next: Date.parse('2026-01-05T02:00:00Z') },
      automations: empty ? [] : [{ id: 'demo', name: 'Weekly audit', trigger: 'mon 09:00', on: true, last: Date.parse('2026-01-04T23:00:00Z'), next: Date.parse('2026-01-11T23:00:00Z'), tasks: ['demo/12'] }],
      timers: empty ? [] : [{ id: 'job-demo', cron: '*/5 * * * *', recurring: true, next: Date.parse('2026-01-05T02:05:00Z'), prompt: 'Check deployment status' },
        { id: 'ScheduleWakeup', cron: '', recurring: false, next: Date.parse('2026-01-05T00:20:00Z'), prompt: 'Check the e2e run' }],
    } })
  })
  await page.clock.install()
  await page.goto('/#/board?machine=&coordinator=demo')
  const section = page.locator('.coordinator-scheduled')
  await expect(section).toBeVisible()
  expect(reads).toBe(0)
  await section.locator('summary').click()
  await expect(section).toContainText('Keep the demo build green')
  await expect(section).toContainText('Session: lost when the session closes')
  await expect(section).toContainText('Every Monday at 09:00')
  await expect(section).toContainText(/05\/01\/2026.*12:00/)
  await expect(section.getByRole('link', { name: 'demo/12' })).toHaveAttribute('href', '/#/board?machine=&task=demo%2F12')
  await expect(section.locator('button, input')).toHaveCount(0)
  await expect(section).toContainText('Wakeup')
  // The board's 15 s polls leave an open section alone (Refresh reads it again, below).
  const opened = reads
  await page.clock.runFor(46000)
  expect(reads).toBe(opened)
  await page.clock.resume()
  await page.screenshot({ path: `.shots/coordinator-scheduled-phone-${language}.png` })
  await section.locator('.scheduled-content').evaluate(el => { el.scrollTop = el.scrollHeight })
  await page.screenshot({ path: `.shots/coordinator-scheduled-timers-phone-${language}.png` })
  await section.locator('.scheduled-content').evaluate(el => { el.scrollTop = 0 })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: `.shots/coordinator-scheduled-desktop-${language}.png` })
  expect(await section.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect.poll(() => reads).toBe(opened + 1)
  await expect(section).toContainText('Keep the demo build green')
  empty = true
  const beforeReopen = reads
  await section.locator('summary').click()
  await section.locator('summary').click()
  await expect(section).toContainText('Nothing scheduled')
  expect(reads).toBeGreaterThan(beforeReopen)
  await expect(section).not.toContainText('Keep the demo build green')
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(section).toContainText('Nothing scheduled')
  const before = reads
  await section.locator('summary').click()
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect.poll(() => reads).toBe(before)
  await section.locator('summary').click()
  await expect.poll(() => reads).toBeGreaterThan(before)
})

})
