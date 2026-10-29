import { readFileSync } from 'node:fs'
import { expect, test } from './test'
import { OMP_CHAT_PANE as pane, fakeHerdr } from './scenario.mjs'

const queued = readFileSync(new URL('../fixtures/claude-queued-turn.txt', import.meta.url), 'utf8')
const after = queued.replace('  ctrl+enter to send now\n', '')

async function setup(text = queued, agent = 'claude') {
  await fakeHerdr('e2e.interaction_screen', { pane_id: pane, text, agent, status: 'working', transitions: { 'ctrl+enter': after } })
}

test.afterEach(async () => {
  await fakeHerdr('e2e.interaction_screen', { pane_id: pane, text: null, agent: 'omp', status: 'idle' })
})

test('conversation sends the native queue now on phone and desktop, in EN and FR', async ({ page }) => {
  await setup()
  await page.goto(`/#/a/${pane}`)
  await expect(page.locator('.agent-top .pill-kind')).toHaveText('claude')
  // Add a wherdr message so the pending-list region is present even with a fake transcript.
  await page.locator('.prompt').locator('textarea, [contenteditable="true"]').first().fill('Also update the changelog.')
  await page.locator('.prompt-send').click()
  const send = page.getByRole('button', { name: 'Send now', exact: true })
  await expect(send).toBeVisible()
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/send-now-phone.png` })
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(send).toBeVisible()
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/send-now-desktop.png` })
  const response = page.waitForResponse(r => r.url().endsWith('/api/send-now'))
  await send.click()
  expect((await response).status()).toBe(200)
  expect((await fakeHerdr('e2e.terminal_screen', { pane_id: pane })).keys).toContain('ctrl+enter')
  await expect(send).toHaveCount(0)
  await setup()
  await page.evaluate(() => localStorage.setItem('herdrLanguage', 'fr'))
  await page.reload()
  await page.setViewportSize({ width: 390, height: 844 })
  const french = page.getByRole('button', { name: 'Envoyer maintenant', exact: true })
  await expect(french).toBeVisible()
  await french.click()
  await expect(french).toHaveCount(0)
  await setup(queued, 'codex')
  await expect(page.locator('.agent-top .pill-kind')).toHaveText('codex')
  await expect(french).toHaveCount(0)
})

test('terminal Ctrl+Enter reaches Herdr as a named key', { tag: '@chromium-desktop' }, async ({ page }, info) => {
  await setup()
  await page.goto(`/#/a/${pane}`)
  await page.getByRole(info.project.name.includes('desktop') ? 'tab' : 'button', { name: 'Terminal', exact: true }).click()
  const input = page.locator('.xterm-helper-textarea')
  await input.focus()
  await input.press('Control+Enter')
  await expect.poll(async () => (await fakeHerdr('e2e.terminal_screen', { pane_id: pane })).keys).toContain('ctrl+enter')
})
