// iOS Safari: a tap on the terminal must not focus xterm's hidden textarea (that
// opens the on-screen keyboard over what the user is reading). The keyboard
// comes from the composer or the key bar's "Type in terminal" button.
import { expect, test, type Page } from './test'
import { OMP_CHAT_PANE as pane, fakeHerdr } from './scenario.mjs'

async function terminal(page: Page, smooth: boolean) {
  await page.addInitScript(smooth => {
    localStorage.setItem('terminalRenderer', 'html')
    if (smooth) localStorage.setItem('smoothTouchScrolling', '1')
  }, smooth)
  await page.goto(`/#/a/${pane}`)
  await page.locator('button[aria-label="Terminal"]').first().click()
  await expect(page.locator('#term .xterm-rows')).toContainText('History offset 0')
}

test.beforeEach(async ({ isMobile, browserName }) => {
  test.skip(!isMobile || browserName !== 'webkit', 'iOS WebKit behaviour')
  await fakeHerdr('e2e.touch_scroll', { pane_id: pane, reset: true, mouse: false })
})

test.afterEach(async () => {
  await fakeHerdr('e2e.touch_scroll', { pane_id: pane, clear: true })
})

for (const smooth of [false, true]) {
  test(`a terminal tap keeps the keyboard closed with smooth scrolling ${smooth ? 'on' : 'off'}`, { tag: '@webkit-phone' }, async ({ page }) => {
    await terminal(page, smooth)
    const input = page.locator('.xterm-helper-textarea')
    await page.evaluate(() => {
      document.documentElement.dataset.tapFocusedTerminal = '0'
      document.addEventListener('focusin', event => {
        if ((event.target as Element).classList.contains('xterm-helper-textarea'))
          document.documentElement.dataset.tapFocusedTerminal = '1'
      })
    })
    await page.locator('#touch').tap()
    await expect(input).not.toBeFocused()
    await expect(page.locator('html')).toHaveAttribute('data-tap-focused-terminal', '0')
    await page.getByRole('button', { name: 'Show or hide terminal keys', exact: true }).click()
    if (!smooth) await page.screenshot({ path: '.shots/terminal-keyboard-webkit-phone.png' })
    // Also when it was typing: a tap closes the keyboard rather than keeping it.
    await page.evaluate(() => {
      document.addEventListener('touchend', () => {
        document.documentElement.dataset.focusAtTouchend = String(document.activeElement?.classList.contains('xterm-helper-textarea'))
      }, { once: true })
    })
    await page.getByRole('button', { name: 'Show or hide the phone keyboard' }).tap()
    await expect(page.locator('html')).toHaveAttribute('data-focus-at-touchend', 'true')
    await expect(input).toBeFocused()
    await page.locator('#touch').tap()
    await expect(input).not.toBeFocused()
  })
}

test('a composer tap gives the keyboard to the composer', { tag: '@webkit-phone' }, async ({ page }) => {
  await terminal(page, false)
  const field = page.locator('.composer textarea')
  await field.tap()
  await expect(field).toBeFocused()
  await expect(page.locator('.xterm-helper-textarea')).not.toBeFocused()
})
