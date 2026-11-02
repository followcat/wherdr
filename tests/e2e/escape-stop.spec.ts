import { expect, test } from './test'
import { CLAUDE_PANE, fakeHerdr } from './scenario.mjs'

test.skip(({ isMobile }) => Boolean(isMobile), 'computers only')

test.afterEach(async () => {
  await fakeHerdr('e2e.pane_status', { pane_id: CLAUDE_PANE, status: 'idle' })
})

// One stray Escape (a dictation app closing its popup) must not stop a working
// agent: the first press only arms, the second one stops (utils/escapeStop.ts;
// the delay and its variants are in tests/escapeStop.test.ts).
test('Escape stops a working agent on the second press', { tag: '@chromium-desktop' }, async ({ page }) => {
  await fakeHerdr('e2e.pane_status', { pane_id: CLAUDE_PANE, status: 'working' })
  const interrupts: string[] = []
  page.on('request', (r) => { if (r.url().endsWith('/api/interrupt') && r.method() === 'POST') interrupts.push(r.url()) })
  await page.goto(`/#/a/${CLAUDE_PANE}`)
  const hint = page.getByTestId('esc-hint')
  await expect(hint).toContainText('stop')
  await page.locator('.prompt textarea').focus()

  await page.keyboard.press('Escape')
  await expect(hint).toContainText('again to stop')
  expect(interrupts).toHaveLength(0)

  const stopped = page.waitForResponse(r => r.url().endsWith('/api/interrupt') && r.request().method() === 'POST')
  await page.keyboard.press('Escape')
  expect((await stopped).ok()).toBe(true)
  expect(interrupts).toHaveLength(1)
})
