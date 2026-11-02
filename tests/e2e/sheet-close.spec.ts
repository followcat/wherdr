import { expect, test, type Page } from './test'
import { OMP_CHAT_PANE } from './scenario.mjs'

// Phone only: on a computer the menu is a dropdown, not a bottom sheet.
test.skip(({ isMobile }) => !isMobile, 'bottom sheets are a phone layout')

const sheet = (page: Page) => page.locator('.hw-sheet')

async function openMenu(page: Page) {
  await page.getByRole('button', { name: 'Options' }).click()
  await expect(sheet(page)).toBeVisible()
  await expect(sheet(page).getByText('Reconnect', { exact: true })).toBeVisible()
  await page.waitForTimeout(400) // opening animation
}

// Synthetic touches: Playwright has no swipe gesture, and WebKit's `Touch` has
// no constructor, so plain events carry the touch lists the sheet reads.
async function swipe(page: Page, selector: string, dy: number, steps = 8, stepMs = 30) {
  await page.evaluate(async ({ selector, dy, steps, stepMs }) => {
    const el = document.querySelector(selector)!
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y0 = r.top + Math.min(r.height / 2, 20)
    const fire = (type: string, y: number) => {
      const e = new Event(type, { bubbles: true, cancelable: true })
      const list = type === 'touchend' ? [] : [{ identifier: 1, target: el, clientX: x, clientY: y }]
      Object.defineProperty(e, 'touches', { value: list })
      Object.defineProperty(e, 'changedTouches', { value: [{ identifier: 1, target: el, clientX: x, clientY: y }] })
      el.dispatchEvent(e)
    }
    fire('touchstart', y0)
    for (let i = 1; i <= steps; i++) {
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, stepMs)
      await promise
      fire('touchmove', y0 + dy * i / steps)
    }
    fire('touchend', y0 + dy)
  }, { selector, dy, steps, stepMs })
}

test.beforeEach(async ({ page }) => {
  await page.goto(`/#/a/${OMP_CHAT_PANE}`)
  await expect(page.locator('.chat').getByText('Ready when you are.')).toBeVisible()
})

test('the agent menu sheet leaves room above it to tap outside', async ({ page }, testInfo) => {
  await openMenu(page)
  const box = (await sheet(page).boundingBox())!
  const vh = page.viewportSize()!.height
  expect(box.y).toBeGreaterThanOrEqual(vh * 0.15 - 1)
  const handle = (await page.locator('.hw-sheet-handle').boundingBox())!
  expect(handle.height).toBeGreaterThanOrEqual(44)
  await page.screenshot({ path: `.shots/sheet-open-${testInfo.project.name}.png` })
  // Reka listens for pointerdown outside, which WebKit's synthetic tap does not send.
  await page.mouse.click(box.width / 2, box.y / 2)
  await expect(sheet(page)).toHaveCount(0)
})

test('a tap on the handle closes the sheet', async ({ page }) => {
  await openMenu(page)
  await page.locator('.hw-sheet-handle').tap()
  await expect(sheet(page)).toHaveCount(0)
})

test('a swipe down from the handle closes the sheet; a short one springs back', { tag: '@webkit-phone' }, async ({ page }) => {
  await openMenu(page)
  await swipe(page, '.hw-sheet-handle', 30, 6, 60)
  await page.waitForTimeout(400)
  await expect(sheet(page)).toBeVisible()
  await swipe(page, '.hw-sheet-handle', 260)
  await expect(sheet(page)).toHaveCount(0)
})

test('a swipe down on the content at its top closes the sheet', async ({ page }) => {
  await openMenu(page)
  await swipe(page, '.hw-sheet-body', 260)
  await expect(sheet(page)).toHaveCount(0)
})

test('Escape closes the sheet', async ({ page }) => {
  await openMenu(page)
  await page.keyboard.press('Escape')
  await expect(sheet(page)).toHaveCount(0)
})
