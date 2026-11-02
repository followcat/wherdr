import { expect, test } from './test'
import { OMP_CHAT_PANE as pane, fakeHerdr } from './scenario.mjs'

const rule = '─'.repeat(60)
const screen = (draft: string) => `${rule}\n❯\u00a0${draft}\n${rule}\n  ? for shortcuts`

test.afterEach(async () => {
  await fakeHerdr('e2e.interaction_screen', { pane_id: pane, text: null, agent: 'omp', status: 'idle' })
})

test('a queued message explains the terminal draft and offers clear or terminal', async ({ page }, info) => {
  await fakeHerdr('e2e.interaction_screen', { pane_id: pane, text: screen('ns'), agent: 'claude', status: 'idle' })
  await page.goto(`/#/a/${pane}`)
  // The server polls Herdr: the kept state can still name this pane as omp.
  // Sending must use Claude's guarded input, after the app sees that change.
  // This unnamed pane shows its kind as the phone title, without a duplicate subtitle.
  await expect(page.locator('.agent-top .phone-identity-title, .agent-top .pill-kind')).toHaveText(/^claude$/i)
  await page.locator('.prompt').locator('textarea, [contenteditable="true"]').first().fill('Please update the release notes.')
  await page.locator('.prompt-send').click()
  const tag = page.locator('.queued-tag').filter({ hasText: 'already contains text' })
  await expect(tag).toContainText('“ns”')
  await expect(tag.getByRole('button', { name: 'Clear and send' })).toBeEnabled()
  await expect(tag.getByRole('button', { name: 'Open terminal' })).toBeVisible()
  await expect(tag.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
  if (process.env.SHOTS) {
    await page.screenshot({ path: `${process.env.SHOTS}/queued-input-${info.project.name}.png` })
    await page.setViewportSize({ width: 1440, height: 900 })
    await tag.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${process.env.SHOTS}/queued-input-desktop.png` })
  }
  await page.evaluate(() => localStorage.setItem('herdrLanguage', 'fr'))
  await page.reload()
  const french = page.locator('.queued-tag').filter({ hasText: 'Not sent' })
  await expect(french).toContainText('“ns”')
  await expect(french.getByRole('button', { name: 'Clear and send' })).toBeEnabled()
  await expect(french.getByRole('button', { name: 'Open terminal' })).toBeVisible()
  if (process.env.SHOTS) {
    await page.setViewportSize({ width: 390, height: 844 })
    await french.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${process.env.SHOTS}/queued-input-fr-phone.png` })
    await page.setViewportSize({ width: 1440, height: 900 })
    await french.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${process.env.SHOTS}/queued-input-fr-desktop.png` })
  }
  // A changed draft must not be erased by an action rendered for the old one.
  await fakeHerdr('e2e.interaction_screen', { pane_id: pane, text: screen('new draft'), agent: 'claude', status: 'working' })
  await expect(french).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Clear and send' })).toHaveCount(0)
  await fakeHerdr('e2e.interaction_screen', { pane_id: pane, text: screen('ns'), agent: 'claude', status: 'idle', transitions: { 'ctrl+u': screen('') } })
  await expect(french).toBeVisible()
  const cleared = page.waitForResponse(r => r.url().endsWith('/api/clear-queued-input'))
  await french.getByRole('button', { name: 'Clear and send' }).click()
  expect((await cleared).status()).toBe(200)
  expect((await fakeHerdr('e2e.terminal_screen', { pane_id: pane })).keys).toContain('ctrl+u')
})
