import { expect, test } from './test'
import { OMP_CHAT_PANE } from './scenario.mjs'
import type { HerdrState } from '../../shared/types'

for (const desktop of [false, true]) {
  test.describe(desktop ? 'desktop copy action' : 'phone copy action', () => {
    test.use(desktop
      ? { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }
      : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    for (const language of ['en', 'fr']) {
      test(`autopilot attribution in coordinator conversation (${language})`, async ({ page }) => {
        await page.addInitScript(language => localStorage.setItem('herdrLanguage', language), language)
        await expect.poll(async () => (await (await page.request.get('/api/state')).json()).ok).toBe(true)
        const base: HerdrState = await (await page.request.get('/api/state')).json()
        const state = { ...base, panes: base.panes.map(pane => ({ ...pane, cwd: '/demo' })) }
        await page.route('**/api/state', route => route.fulfill({ json: state }))
        await page.routeWebSocket('**/ws/events', ws => ws.send(JSON.stringify(state)))
        const wakes = ['Autopilot: Check ready work.\nBoard context: no pending replies.', 'Autopilot woke: Check older work.']
        await page.route('**/api/tasks', route => route.fulfill({ json: { version: 'wake', machines: [{ machine: '', status: 'ready', version: '1.2.16', tasks: [] }] } }))
        await page.route('**/api/tasks?**', route => route.fulfill({ json: { same: true } }))
        await page.route('**/api/tasks/coordinator?**', route => route.fulfill({ json: { state: 'idle', pane: OMP_CHAT_PANE } }))
        await page.route('**/api/chat?**', route => route.fulfill({ json: { available: true, token: 'wake', file: '/demo/transcript.jsonl', items: [
          ...wakes.map(text => ({ role: 'user', text, ts: null })),
          { role: 'user', text: 'Please explain Autopilot: behavior.', ts: null },
          { role: 'assistant', text: 'Autopilot: an assistant reply.', ts: null },
        ] } }))
        await page.goto('/#/board?machine=&coordinator=demo')
        const panel = page.locator('.board-panel')
        await expect(panel.locator('.msg-autopilot')).toHaveCount(2)
        for (const [i, text] of wakes.entries()) await expect(panel.locator('.msg-autopilot-body').nth(i)).toHaveText(text)
        await expect(panel.locator('.msg-user')).toHaveCount(1)
        await expect(panel.locator('.msg-ai')).toContainText('Autopilot: an assistant reply.')
        const wake = panel.locator('.msg-autopilot').first()
        const copy = wake.getByRole('button', { name: language === 'en' ? 'Copy message' : 'Copier le message', exact: true })
        await page.mouse.move(0, 0)
        if (desktop) {
          await expect(copy).toHaveCSS('opacity', '0')
          await expect(copy).toHaveCSS('pointer-events', 'none')
          await wake.hover()
          await expect(copy).toHaveCSS('opacity', '1')
          const body = await wake.locator('.msg-autopilot-body').boundingBox()
          const button = await copy.boundingBox()
          const text = await wake.locator('.msg-autopilot-text').boundingBox()
          expect(Math.abs(button!.y - text!.y)).toBeLessThanOrEqual(1)
          expect(button!.x).toBeGreaterThanOrEqual(text!.x + text!.width)
          expect(button!.y).toBeGreaterThanOrEqual(body!.y)
          expect(button!.y + button!.height).toBeLessThanOrEqual(body!.y + body!.height)
          await page.screenshot({ path: `.shots/autopilot-${language}-desktop-hover.png` })
          await page.mouse.move(0, 0)
          await expect(copy).toHaveCSS('opacity', '0')
          // Tab from the preceding element to prove the hidden action remains keyboard reachable.
          await copy.evaluate(el => {
            const anchor = document.createElement('button')
            anchor.id = 'copy-focus-start'
            el.before(anchor)
            anchor.focus()
          })
          await page.keyboard.press('Tab')
          await expect(copy).toBeFocused()
          await expect(copy).toHaveCSS('opacity', '1')
          await page.locator('#copy-focus-start').evaluate(el => el.remove())
          await page.screenshot({ path: `.shots/autopilot-${language}-desktop-focus.png` })
          await copy.evaluate(el => (el as HTMLElement).blur())
          await expect(copy).toHaveCSS('opacity', '0')
        } else {
          await expect(copy).toBeHidden()
          await wake.tap()
          await expect(copy).toBeHidden()
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: `.shots/autopilot-${language}-${desktop ? 'desktop' : 'phone'}.png` })
      })
    }
  })
}
