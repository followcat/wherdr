import fs from 'node:fs'
import { expect, test } from './test'
import { OMP_CHAT_PANE } from './scenario.mjs'

// The real desktop dropdown and phone sheet share this action. Readiness
// and split creation are exercised against the Herdr RPCs in unit tests.
for (const desktop of [false, true]) {
  test.describe(desktop ? 'desktop pointer' : 'phone touch', () => {
    if (desktop) test.use({ isMobile: false, hasTouch: false, viewport: { width: 1440, height: 900 } })
    test(`split command menu on ${desktop ? 'desktop' : 'phone'}`, async ({ page }) => {
      if (desktop) await page.setViewportSize({ width: 1440, height: 900 })
      await page.route('**/api/chat?**', route => route.fulfill({ json: {
        available: true, token: 'split-menu', file: '/project/chat.jsonl',
        items: [{ role: 'assistant', text: 'To sign in, run `! gcloud auth login`.', ts: null }],
      } }))
      let sent = false
      await page.route('**/api/split-command', route => {
        expect(route.request().postDataJSON()).toEqual({ pane_id: OMP_CHAT_PANE, command: 'gcloud auth login' })
        sent = true
        return route.fulfill({ status: 409, json: { code: 'busy_pane', error: 'Cannot verify an idle shell prompt. No command was sent.' } })
      })
      await page.goto(`/#/a/${OMP_CHAT_PANE}`)
      const command = page.locator('.md-cmd').first()
      await expect(command).toBeVisible()
      await command.click()
      const action = page.getByRole('menuitem', { name: 'Run in split terminal' }).or(page.getByRole('button', { name: 'Run in split terminal', exact: true }))
      await expect(action).toBeVisible()
      expect(sent).toBe(false)
      fs.mkdirSync('.shots', { recursive: true })
      await page.screenshot({ path: `.shots/chat-split-${desktop ? 'desktop' : 'phone'}.png` })
      await action.click()
      await expect.poll(() => sent).toBe(true)
      await expect(page.getByText('Cannot verify an idle shell prompt. No command was sent.', { exact: true })).toBeVisible()
    })
  })
}
