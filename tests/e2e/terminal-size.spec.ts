import { type Page, expect, test } from './test'
import { OMP_CHAT_PANE, fakeHerdr } from './scenario.mjs'

// The fake pane starts at 120x40 and, like a Herdr session nobody is attached
// to, keeps whatever size a terminal control session gave it.
const ORIGINAL = { cols: 120, rows: 40 }
const paneSize = () => fakeHerdr('e2e.pane_size', { pane_id: OMP_CHAT_PANE }) as Promise<{ cols: number, rows: number, attached: boolean }>

// Phone: the terminal icon toggles; computer: the button names the opposite view.
async function show(page: Page, view: 'Terminal' | 'Conversation') {
  const tabs = page.locator('.view-toggle')
  if (await tabs.count()) await page.getByRole('button', { name: `Show ${view.toLowerCase()}`, exact: true }).click()
  else await page.locator('button[aria-label="Terminal"]').first().click()
}

async function openTerminal(page: Page) {
  await page.addInitScript(() => localStorage.setItem('terminalRenderer', 'html'))
  await page.goto(`/#/a/${OMP_CHAT_PANE}`)
  await expect(page.locator('.chat').getByText('Ready when you are.')).toBeVisible()
  await show(page, 'Terminal')
  // The terminal's frames reach the screen (DOM renderer: the text is in the page).
  await expect(page.locator('#term .xterm-rows')).toContainText('fake terminal')
  // The control session resized the real pane to the size of this screen.
  await expect.poll(async () => (await paneSize()).attached).toBe(true)
  const size = await paneSize()
  expect({ cols: size.cols, rows: size.rows }).not.toEqual(ORIGINAL)
  return size
}

test.beforeEach(async () => {
  await expect.poll(paneSize, { timeout: 15_000 }).toEqual({ ...ORIGINAL, attached: false })
})

test('closing the terminal gives the pane its original size back', async ({ page }) => {
  const open = await openTerminal(page)
  // A resize of the open terminal (rotation, keyboard) is followed.
  await page.setViewportSize({ width: page.viewportSize()!.width, height: page.viewportSize()!.height - 120 })
  await expect.poll(async () => (await paneSize()).rows).toBeLessThan(open.rows)

  await show(page, 'Conversation')
  // The conversation is back. Not a given message: earlier specs add to this pane, and
  // on the shortened screen its first message can lie above the loaded tail.
  await expect(page.locator('#term')).toHaveCount(0)
  await expect(page.locator('.chat .chat-list article').last()).toBeVisible()
  await expect.poll(paneSize, { timeout: 10_000 }).toEqual({ ...ORIGINAL, attached: false })
})

test('a terminal whose connection drops gives the size back after the grace delay', async ({ page }) => {
  await openTerminal(page)
  const closedAt = Date.now()
  // The page goes away without closing its terminal.
  await page.close()
  await expect.poll(paneSize, { timeout: 15_000 }).toEqual({ ...ORIGINAL, attached: false })
  // Not before the grace delay (3 s in the e2e environment, see launch.mjs).
  expect(Date.now() - closedAt).toBeGreaterThanOrEqual(2500)
})

test('a terminal reopened at once keeps the pane at the size of the screen', async ({ page }) => {
  const open = await openTerminal(page)
  await show(page, 'Conversation')
  await expect(page.locator('.chat').getByText('Ready when you are.')).toBeVisible()
  await show(page, 'Terminal')
  await expect.poll(async () => (await paneSize()).attached).toBe(true)
  // Longer than the delay after a closed terminal: no restore happened.
  await page.waitForTimeout(3000)
  expect(await paneSize()).toEqual({ cols: open.cols, rows: open.rows, attached: true })

  await show(page, 'Conversation')
  await expect.poll(paneSize, { timeout: 10_000 }).toEqual({ ...ORIGINAL, attached: false })
})
