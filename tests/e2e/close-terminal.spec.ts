import { expect, test, type Page } from './test'
import { SPLIT_SHELL_PANE, fakeHerdr } from './scenario.mjs'

// Phone: closing a pane lives in the header identity's pane sheet; computer: in Options.
async function closeTerminal(page: Page, phone: boolean) {
  if (phone) await page.locator('.phone-identity').click()
  else await page.locator('#agent .agent-actions').getByRole('button', { name: 'Options', exact: true }).click()
  await page.getByText('Close this terminal', { exact: true }).click()
}

test('closing an idle terminal does not show a process warning', async ({ page, isMobile }) => {
  await fakeHerdr('pane.report_metadata', { pane_id: SPLIT_SHELL_PANE, tokens: { wherdr_split_prompt: '2000' } })
  await page.goto(`/#/a/${SPLIT_SHELL_PANE}`)
  await closeTerminal(page, isMobile)
  const dialog = page.getByRole('dialog').filter({ hasText: 'Close the terminal in space' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Close the terminal in space “split”?')
  await expect(dialog).not.toContainText('will be stopped')
  await page.screenshot({ path: '.shots/close-terminal-phone.png', animations: 'disabled', mask: [page.locator('.where')], maskColor: '#101419' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: '.shots/close-terminal-desktop.png', animations: 'disabled', mask: [page.locator('.where')], maskColor: '#101419' })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
})

test.afterEach(async () => {
  await fakeHerdr('pane.report_metadata', { pane_id: SPLIT_SHELL_PANE, tokens: { wherdr_split_prompt: null } })
})

test('a lone shell without prompt attestation keeps the conditional warning', async ({ page, isMobile }) => {
  await fakeHerdr('pane.report_metadata', { pane_id: SPLIT_SHELL_PANE, tokens: { wherdr_split_prompt: null } })
  await page.goto(`/#/a/${SPLIT_SHELL_PANE}`)
  await closeTerminal(page, isMobile)
  const dialog = page.getByRole('dialog').filter({ hasText: 'Close the terminal in space' })
  await expect(dialog).toContainText('Anything running in it will be stopped.')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
})
