import { expect, test } from './test'
import { OMP_CHAT_PANE, SPLIT_TAB } from './scenario.mjs'

// Exercise desktop hover and keyboard behavior on the selected Chromium project.
test.use({ isMobile: false, hasTouch: false })

for (const split of [false, true]) {
  test(`one desktop action switches both views${split ? ' in a cell' : ''}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/#/${split ? `t/${SPLIT_TAB}` : `a/${OMP_CHAT_PANE}`}`)
    const scope = split ? page.locator('.cell-view').first() : page.locator('#agent')
    await expect(scope.locator('.chat')).toContainText(split ? 'It runs in the pane on the right.' : 'Ready when you are.')
    await expect(scope.locator('.view-toggle')).toHaveCount(1)
    const toggle = scope.getByRole('button', { name: 'Show terminal', exact: true })
    await expect(toggle).toContainText('Terminal')
    await toggle.hover()
    await expect(page.getByText('Show terminal', { exact: true })).toBeVisible()
    await expect(page.locator('[data-slot=kbds]')).toContainText('`')
    await toggle.click()
    await expect(scope.locator('#term .xterm')).toBeVisible()
    await expect(scope.getByRole('button', { name: 'Show conversation', exact: true })).toContainText('Conversation')
    await scope.getByRole('button', { name: 'Show conversation', exact: true }).click()
    await expect(scope.locator('.chat')).toBeVisible()
    // The same shortcut still switches the focused pane in either direction.
    await page.keyboard.press('Control+Backquote')
    await expect(scope.locator('#term .xterm')).toBeVisible()
    await page.keyboard.press('Control+Backquote')
    await expect(scope.locator('.chat')).toBeVisible()
    if (split) {
      await page.setViewportSize({ width: 1000, height: 900 })
      await expect(scope.locator('.view-toggle-label')).toBeHidden()
      await expect(scope.getByRole('button', { name: 'Show terminal', exact: true })).toBeVisible()
      const bounds = await scope.locator('.view-toggle').boundingBox()
      const actions = await scope.locator('.agent-actions').boundingBox()
      expect(bounds!.width).toBeGreaterThanOrEqual(44)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(actions!.x)
      await expect(page.locator('.cell-view').last().locator('.view-toggle')).toHaveCount(0)
    }
  })
}

test('the action is accessible with a legacy French preference', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => localStorage.setItem('herdrLanguage', 'fr'))
  await page.goto(`/#/a/${OMP_CHAT_PANE}`)
  await page.getByRole('button', { name: 'Show terminal', exact: true }).click()
  await expect(page.locator('#term .xterm')).toBeVisible()
  await page.getByRole('button', { name: 'Show conversation', exact: true }).click()
  await expect(page.locator('.chat')).toBeVisible()
})
