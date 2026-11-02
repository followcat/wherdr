import { expect, test, type Page } from './test'
import { OMP_CHAT_PANE } from './scenario.mjs'

const DEFAULT = [
  'keyboard', 'ctrl', 'esc', 'tab', 'left', 'up', 'down', 'right', 'enter', 'ctrl-c', 'backspace',
  'home', 'end', 'pageup', 'pagedown', 'delete', 'insert', 'alt', 'shift', 'y', 'n',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]

const settingsRows = (page: Page) => page.locator('.phone-key-order [data-key-row]').evaluateAll(rows => rows.map(r => (r as HTMLElement).dataset.keyRow))
const previewKeys = (page: Page) => page.locator('.phone-key-order .key-order-preview [data-key]').evaluateAll(keys => keys.map(k => (k as HTMLElement).dataset.key))

async function barKeys(page: Page) {
  const toggle = page.getByRole('button', { name: 'Show or hide terminal keys', exact: true })
  const strip = page.getByRole('toolbar', { name: 'Common keys and modifiers' })
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
  await expect(strip).toBeVisible()
  return strip.getByRole('button').evaluateAll(buttons => buttons.map(b => (b as HTMLElement).dataset.key))
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('terminalRenderer', 'html'))
})

test('the phone key order is chosen in Settings, survives a reload, applies to Conversation and Terminal, and resets', { tag: '@webkit-phone' }, async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('phone'), 'Phone key bar')
  await page.goto('/#/settings?section=terminal')
  const group = page.locator('.phone-key-order')
  await expect(group.getByRole('heading', { name: 'Phone key bar' })).toBeVisible()
  await expect.poll(() => settingsRows(page)).toEqual(DEFAULT)
  await expect.poll(() => previewKeys(page)).toEqual(DEFAULT)
  const reset = group.getByRole('button', { name: 'Reset to default order' })
  await expect(reset).toBeDisabled()
  await expect(group.getByRole('button', { name: 'Move Phone keyboard up' })).toBeDisabled()
  await expect(group.getByRole('button', { name: 'Move F12 down' })).toBeDisabled()

  // Enter to the front with its up button; the focus stays on that button.
  const enterUp = group.getByRole('button', { name: 'Move Enter up', exact: true })
  for (let i = 0; i < 8; i++) await enterUp.click()
  await expect(enterUp).toBeDisabled()
  await expect(group.getByRole('button', { name: 'Move Enter down', exact: true })).toBeFocused()
  // Shift before Alt from the keyboard, on its handle.
  await group.getByRole('button', { name: 'Move Shift — up and down arrows', exact: true }).focus()
  await page.keyboard.press('ArrowUp')
  await expect(group.getByRole('button', { name: 'Move Shift — up and down arrows', exact: true })).toBeFocused()
  // Esc after Tab with its down button.
  await group.getByRole('button', { name: 'Move Esc down', exact: true }).click()

  const custom = ['enter', 'keyboard', 'ctrl', 'tab', 'esc', 'left', 'up', 'down', 'right', 'ctrl-c', 'backspace',
    'home', 'end', 'pageup', 'pagedown', 'delete', 'insert', 'shift', 'alt', 'y', 'n', ...DEFAULT.slice(21)]
  await expect.poll(() => settingsRows(page)).toEqual(custom)
  await expect.poll(() => previewKeys(page)).toEqual(custom)
  await expect(reset).toBeEnabled()
  await expect(group.locator('[aria-live="polite"]')).toHaveText('Esc: position 5 of 33')
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${info.project.name}-key-order-settings.png` })

  await page.reload()
  await expect.poll(() => settingsRows(page)).toEqual(custom)

  await page.goto(`/#/a/${OMP_CHAT_PANE}`)
  await expect(page.locator('#term')).toHaveCount(0)
  await expect.poll(() => barKeys(page)).toEqual(custom)
  // The keys keep their behavior: Enter, now first, still sends enter.
  const input = page.waitForRequest(r => r.url().endsWith('/api/input') && r.method() === 'POST')
  await page.getByRole('toolbar', { name: 'Common keys and modifiers' }).getByRole('button').first().click()
  expect((await input).postDataJSON()).toMatchObject({ pane_id: OMP_CHAT_PANE, keys: ['enter'] })
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${info.project.name}-key-order-bar.png` })

  await page.locator('.mode-btn').click()
  await expect(page.locator('#term .xterm-rows')).toBeVisible()
  await expect.poll(() => barKeys(page)).toEqual(custom)

  await page.goto('/#/settings?section=terminal')
  await reset.click()
  await expect(reset).toBeDisabled()
  await expect.poll(() => settingsRows(page)).toEqual(DEFAULT)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('phoneKeyOrder'))).toBeNull()
  await page.goto(`/#/a/${OMP_CHAT_PANE}`)
  await expect.poll(() => barKeys(page)).toEqual(DEFAULT)
})

test('a saved order from another version keeps every key: unknown ids dropped, new keys last', async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('phone'), 'Phone key bar')
  await page.addInitScript(() => localStorage.setItem('phoneKeyOrder', JSON.stringify(['esc', 'hyper', 'tab', 'esc'])))
  await page.goto(`/#/a/${OMP_CHAT_PANE}`)
  await expect.poll(() => barKeys(page)).toEqual(['esc', 'tab', ...DEFAULT.filter(k => k !== 'esc' && k !== 'tab')])
})
