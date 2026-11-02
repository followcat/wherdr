import { type Page, expect, test } from '@playwright/test'
import { OMP_CHAT_PANE, fakeHerdr } from './scenario.mjs'

// OSC 52 in the terminal (issue #47). The fake control session writes the
// sequence as a terminal that passes it through would (Herdr 0.9.5 does not
// yet: it keeps OSC 52 for its own clients).
const pane = OMP_CHAT_PANE
const osc52 = (text: string, selection = 'c') => fakeHerdr('e2e.terminal_osc', {
  pane_id: pane, data: `\x1b]52;${selection};${Buffer.from(text, 'utf8').toString('base64')}\x07`,
})
const shot = (page: Page, name: string, project: string) =>
  process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${project}-${name}.png` }) : Promise.resolve()

// A clipboard that records writes; `refuse`: the first n writes are refused,
// as iOS Safari does outside a tap.
async function openTerminal(page: Page, { refuse = 0, enabled = true } = {}) {
  await page.addInitScript(({ refuse, enabled }) => {
    localStorage.setItem('terminalRenderer', 'html')
    if (!enabled) localStorage.setItem('agentClipboard', '0')
    const w = window as unknown as { copies: string[] }
    w.copies = []
    let left = refuse
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (left-- > 0) throw new DOMException('Write permission denied.', 'NotAllowedError')
          w.copies.push(text)
        },
      },
    })
  }, { refuse, enabled })
  await page.goto(`/#/a/${pane}`)
  await expect(page.locator('.chat').getByText('Ready when you are.')).toBeVisible()
  const tabs = page.locator('.view-toggle')
  if (await tabs.count()) await tabs.click()
  else await page.locator('button[aria-label="Terminal"]').first().click()
  await expect(page.locator('#term .xterm-rows')).toContainText('fake terminal')
}
const copies = (page: Page) => page.evaluate(() => (window as unknown as { copies: string[] }).copies)

test('an agent copy lands in the browser clipboard', async ({ page }, info) => {
  await openTerminal(page)
  await osc52('npm run build && npm test\nsecond line — déjà')
  await expect.poll(() => copies(page)).toEqual(['npm run build && npm test\nsecond line — déjà'])
  await expect(page.getByText('The agent copied text', { exact: true })).toBeVisible()
  await shot(page, 'osc52-copied', info.project.name)
})

test('a refused write is offered again on a tap', async ({ page }, info) => {
  await openTerminal(page, { refuse: 1 })
  await osc52('git checkout -b feature/x')
  const toast = page.getByText('The agent copied text — tap to copy', { exact: true })
  await expect(toast).toBeVisible()
  expect(await copies(page)).toEqual([])
  await shot(page, 'osc52-tap-to-copy', info.project.name)
  await page.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect.poll(() => copies(page)).toEqual(['git checkout -b feature/x'])
  await expect(page.getByText('Copied', { exact: true })).toBeVisible()
})

test('read requests, oversized copies and the setting are honoured', async ({ page }) => {
  await openTerminal(page)
  await fakeHerdr('e2e.terminal_osc', { pane_id: pane, data: '\x1b]52;c;?\x07' })
  await osc52('x'.repeat(150_000))
  await expect(page.getByText('Agent copy ignored: 150 kB (limit 100 kB)', { exact: true })).toBeVisible()
  // The read request wrote nothing, and nothing was answered to the program.
  expect(await copies(page)).toEqual([])
})

test('turned off in Settings, copies are ignored', async ({ page }) => {
  await openTerminal(page, { enabled: false })
  await osc52('secret')
  await osc52('marker')
  // Both frames went through (the terminal still draws), nothing was written.
  await page.waitForTimeout(800)
  expect(await copies(page)).toEqual([])
  await expect(page.getByText('The agent copied text')).toHaveCount(0)
})

test('the setting is in Settings › Terminal, on by default', async ({ page }, info) => {
  await page.goto('/#/settings')
  await page.locator('.settings-nav-item', { hasText: 'Terminal' }).click()
  const toggle = page.locator('label.settings-toggle', { hasText: 'Agent copies' }).getByRole('switch')
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await page.locator('label.settings-toggle', { hasText: 'Agent copies' }).scrollIntoViewIfNeeded()
  await shot(page, 'osc52-settings', info.project.name)
  await toggle.click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('agentClipboard'))).toBe('0')
})
