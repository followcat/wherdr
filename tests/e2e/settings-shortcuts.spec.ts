import { expect, test } from './test'

for (const device of ['desktop', 'phone']) test.describe(device, () => {
  if (device === 'desktop') test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36' })
  test.describe('English interface', () => {
    const language = 'en'
    test(`Conversation preference and inline shortcuts (${language})`, async ({ page }) => {
      test.setTimeout(60_000)
      await page.addInitScript(l => localStorage.setItem('herdrLanguage', l), language)
      await page.goto('/#/settings?section=conversation')
      const desktop = await page.evaluate(() => matchMedia('(min-width: 900px)').matches && !matchMedia('(pointer: coarse)').matches)
      const title = 'Default pane view'
      const shortcuts = 'Shortcuts'
      const group = page.locator('.settings-group').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
      await expect(group).toBeVisible()
      await group.getByRole('radio', { name: /Terminal/ }).check()
      await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).settings.defaultViewMode).toBe('term')
      await page.screenshot({ path: `.shots/settings-conversation-${language}-${desktop ? 'desktop' : 'phone'}.png` })
      await page.goto('/#/settings')
      const nav = page.locator('.settings-nav')
      await expect(nav).not.toContainText('Desktop')
      const link = nav.getByRole('button', { name: shortcuts, exact: true })
      if (desktop) {
        await link.click()
        await expect(page.locator('.settings-section:visible .shortcut-row')).toHaveCount(22)
        await page.screenshot({ path: `.shots/settings-shortcuts-${language}-desktop.png` })
        await page.goto('/#/')
        await page.keyboard.press('Control+/')
        await expect(page.locator('.hw-sheet .shortcut-row')).toHaveCount(22)
        await page.keyboard.press('Escape')
        await expect(page.locator('.hw-sheet')).toHaveCount(0)
      } else {
        await expect(link).toHaveCount(0)
        await page.screenshot({ path: `.shots/settings-menu-${language}-phone.png` })
        await page.setViewportSize({ width: 1024, height: 1366 })
        await expect(link).toHaveCount(0)
      }
      for (const url of ['/#/settings?section=desktop', '/#/settings/desktop']) {
        await page.goto(url)
        await expect(page).toHaveURL(/settings\?section=conversation/)
        await expect(group).toBeVisible()
      }
    })
  })
})
