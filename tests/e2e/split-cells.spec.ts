import { expect, test } from './test'
import { OMP_CHAT_PANE, SPLIT_TAB } from './scenario.mjs'

// Panes side by side on a computer: a cell is full width on a solid background.
// The reading column's lines and the "wherdr grid" backdrop (the default) belong
// to a pane opened alone; in a cell they ran through the conversation.
test.skip(({ isMobile }) => isMobile, 'side-by-side cells are a computer layout')

const shot = (page: import('@playwright/test').Page, name: string, project: string) =>
  process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${project}-${name}.png` }) : Promise.resolve()

const paint = (el: Element) => {
  const s = getComputedStyle(el)
  return { image: s.backgroundImage, color: s.backgroundColor }
}

for (const width of [1440, 2000]) {
  test(`a cell shows neither the backdrop nor the column lines (${width} px)`, { tag: '@chromium-desktop' }, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 2000 ? 1125 : 900 })
    await page.goto(`/#/t/${SPLIT_TAB}`)
    const cells = page.locator('.cell-view')
    await expect(cells).toHaveCount(2)
    const chat = cells.first().locator('.chat')
    await expect(chat.getByText('It runs in the pane on the right.')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-backdrop', 'wherdr')
    await expect(page.locator('.cell-view .grid-backdrop')).toHaveCount(0)

    const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())
    const solid = await page.evaluate((c) => {
      const probe = document.body.appendChild(document.createElement('i'))
      probe.style.backgroundColor = c
      const v = getComputedStyle(probe).backgroundColor
      probe.remove()
      return v
    }, bg)
    for (const sel of ['.chat', '.composer']) {
      expect(await cells.first().locator(sel).evaluate(paint), sel).toEqual({ image: 'none', color: solid })
    }
    await shot(page, `split-cells-${width}`, testInfo.project.name)
  })
}

test('a pane opened alone keeps the backdrop in its margins', { tag: '@chromium-desktop' }, async ({ page }) => {
  await page.goto(`/#/a/${OMP_CHAT_PANE}`)
  await expect(page.locator('.chat').getByText('Ready when you are.')).toBeVisible()
  await expect(page.locator('.agent-main > .grid-backdrop')).toHaveCount(1)
  expect(await page.locator('.chat').evaluate(paint)).toMatchObject({ color: 'rgba(0, 0, 0, 0)' })
})

// The Conversation / Terminal selector of a cell: its labels where they fit,
// its icon in a narrow cell; never cut by the cell's edge.
for (const [width, narrow] of [[1440, false], [1000, true]] as const) {
  test(`the selector of a cell stays whole (${width} px)`, { tag: '@chromium-desktop' }, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 })
    await page.goto(`/#/t/${SPLIT_TAB}`)
    const cell = page.locator('.cell-view').first()
    const terminal = cell.getByRole('button', { name: 'Show terminal' })
    await expect(terminal).toBeVisible()
    await expect(terminal.locator('.iconify')).toBeVisible()
    await expect(terminal.locator('.view-toggle-label')).toBeVisible({ visible: !narrow })
    const m = await cell.evaluate((el) => {
      const right = (x: Element) => x.getBoundingClientRect().right
      const label = el.querySelector('.view-toggle-label') as HTMLElement
      const tab = label.closest('.view-toggle') as HTMLElement
      return {
        cell: right(el), tabs: right(el.querySelector('.view-toggle')!), actions: right(el.querySelector('.agent-actions')!),
        label: label.getBoundingClientRect().width, cut: label.scrollWidth > label.clientWidth + 1 || tab.scrollWidth > tab.clientWidth + 1,
        title: el.querySelector('.agent-title')!.getBoundingClientRect().width,
      }
    })
    expect(m.tabs).toBeLessThanOrEqual(m.actions)
    expect(m.actions).toBeLessThanOrEqual(m.cell)
    expect(m.title).toBeGreaterThan(60)
    if (narrow) expect(m.label).toBeLessThanOrEqual(1)
    else expect(m.cut).toBe(false)
    await shot(page, `split-selector-${width}`, testInfo.project.name)
    // The icons still switch the view.
    await terminal.click()
    await expect(cell.locator('#term .xterm')).toBeVisible()
    await cell.getByRole('button', { name: 'Show conversation' }).click()
    await expect(cell.locator('.chat')).toContainText('It runs in the pane on the right.')
  })
}
