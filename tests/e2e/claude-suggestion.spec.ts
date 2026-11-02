import { expect, test, type Page } from './test'
import { CLAUDE_SUGGEST_ASK_PANE, CLAUDE_SUGGEST_PANE, SUGGEST_ASK, SUGGEST_PLAIN } from './scenario.mjs'

// Claude Code's grayed-out suggestion in the empty field: Tab takes it on a computer,
// a "Use" button inside the field on a phone (no Tab key there). Taking it fills the
// field, editable, and sends nothing.
const shot = (page: Page, name: string, project: string) =>
  process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${project}-${name}.png` }) : Promise.resolve()

async function open(page: Page, pane: string, suggestion: string) {
  await page.addInitScript(() => localStorage.setItem('typewriterSpeed', 'off'))
  await page.goto(`/#/a/${pane}`)
  const field = page.locator('.prompt textarea').first()
  // The server reads the suggestion from the screen once the pane is on view.
  await expect(field).toHaveAttribute('placeholder', suggestion, { timeout: 15_000 })
  return { field, use: page.locator('.prompt-suggest'), ask: page.locator('.composer-ask') }
}
const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!

test.describe('phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'touch screens only')

  test('with questions unanswered: Use fills the field, beside the reminder', async ({ page }, testInfo) => {
    const { field, use, ask } = await open(page, CLAUDE_SUGGEST_ASK_PANE, SUGGEST_ASK)
    await expect(ask).toHaveText('2 questions unanswered')
    await expect(use).toBeVisible()
    await expect(use).toHaveAccessibleName('Use suggestion')
    // Inside the field, on its right; the reminder tab hangs above the field, on its left.
    const [b, f, a] = [await box(page, '.prompt-suggest'), await box(page, '.prompt'), await box(page, '.composer-ask')]
    expect(b.y).toBeGreaterThanOrEqual(f.y)
    expect(b.x + b.width).toBeLessThanOrEqual(f.x + f.width)
    expect(b.x).toBeGreaterThan(f.x + f.width / 2)
    expect(a.y + a.height).toBeLessThanOrEqual(f.y)
    // 44 px for the finger: the button's own box and its invisible margin.
    const hit = await use.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const after = getComputedStyle(el, '::after')
      return { h: r.height - parseFloat(after.top) - parseFloat(after.bottom), w: r.width - parseFloat(after.left) - parseFloat(after.right) }
    })
    expect(hit.h).toBeGreaterThanOrEqual(44)
    expect(hit.w).toBeGreaterThanOrEqual(44)
    // What a finger lands on, around the button, is the button.
    const hitsUse = (x: number, y: number) => page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x!, y!)?.closest('.prompt-suggest')), [x, y])
    expect(await hitsUse(b.x + b.width / 2, b.y - 6)).toBe(true)
    expect(await hitsUse(b.x + b.width / 2, b.y + b.height + 6)).toBe(true)
    await shot(page, 'suggestion-questions', testInfo.project.name)

    await use.tap()
    await expect(field).toHaveValue(SUGGEST_ASK)
    await expect(use).toHaveCount(0)
    // Nothing sent: no message bubble of ours.
    await expect(page.locator('.chat').getByText(SUGGEST_ASK)).toHaveCount(0)
    // Editable like any draft.
    await field.press('End')
    await field.pressSequentially(', then merge')
    await expect(field).toHaveValue(`${SUGGEST_ASK}, then merge`)
    await shot(page, 'suggestion-taken', testInfo.project.name)
    await field.fill('')
    await expect(use).toBeVisible()
  })

  test('without questions: Use fills the field too', async ({ page }, testInfo) => {
    const { field, use, ask } = await open(page, CLAUDE_SUGGEST_PANE, SUGGEST_PLAIN)
    await expect(ask).toHaveCount(0)
    await shot(page, 'suggestion', testInfo.project.name)
    await use.tap()
    await expect(field).toHaveValue(SUGGEST_PLAIN)
  })

  test('with a legacy French preference: Use, and the suggestion stops before it', async ({ page }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem('herdrLanguage', 'fr'))
    const { field, use } = await open(page, CLAUDE_SUGGEST_ASK_PANE, SUGGEST_ASK)
    await expect(use).toHaveText('Use')
    await expect(use).toHaveAccessibleName('Use suggestion')
    const b = await box(page, '.prompt-suggest')
    const textEnd = await field.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return r.right - parseFloat(getComputedStyle(el).paddingRight)
    })
    expect(textEnd).toBeLessThanOrEqual(b.x)
    await shot(page, 'suggestion-fr', testInfo.project.name)
    await use.tap()
    await expect(field).toHaveValue(SUGGEST_ASK)
    await field.fill('')
  })

  test('typing hides the button, the field stays as usual', async ({ page }) => {
    const { field, use } = await open(page, CLAUDE_SUGGEST_PANE, SUGGEST_PLAIN)
    await field.tap()
    await expect(field).toBeFocused()
    await field.pressSequentially('no')
    await expect(use).toHaveCount(0)
    await expect(field).toHaveValue('no')
    await field.fill('')
  })
})

test.describe('computer', () => {
  test.skip(({ isMobile }) => Boolean(isMobile), 'computers only')

  test('no button; Tab takes the suggestion', { tag: '@chromium-desktop' }, async ({ page }, testInfo) => {
    const { field, use, ask } = await open(page, CLAUDE_SUGGEST_ASK_PANE, SUGGEST_ASK)
    await expect(ask).toHaveText('2 questions unanswered')
    await expect(use).toHaveCount(0)
    await expect(page.locator('.prompt-hint')).toContainText('suggestion')
    await shot(page, 'suggestion-questions', testInfo.project.name)
    await field.focus()
    await page.keyboard.press('Tab')
    await expect(field).toHaveValue(SUGGEST_ASK)
    await expect(field).toBeFocused()
    await field.fill('')
  })
})
