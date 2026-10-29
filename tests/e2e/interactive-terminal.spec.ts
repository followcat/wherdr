import { readFileSync } from 'node:fs'
import { expect, test, type Page } from './test'
import { screenChoices } from '../../server/utils/choices'
import { OMP_CHAT_PANE, SPLIT_CHAT_PANE, SPLIT_SHELL_PANE, SPLIT_TAB, fakeHerdr } from './scenario.mjs'

const pane = OMP_CHAT_PANE
const usage = readFileSync(new URL('../fixtures/codex-usage-menu.txt', import.meta.url), 'utf8')
const screen = (text: string | null, agent = 'codex') => fakeHerdr('e2e.interaction_screen', { pane_id: pane, text, agent, status: 'idle' })
const original = { cols: 120, rows: 40, attached: false }
const size = () => fakeHerdr('e2e.pane_size', { pane_id: pane })
const sentKeys = async () => (await fakeHerdr('e2e.terminal_screen', { pane_id: pane }) as { keys: string[] }).keys
async function escapeKey(page: Page) {
  const window = page.getByRole('dialog', { name: 'Interactive terminal', exact: true })
  await window.locator('.vk-more').click()
  await window.getByRole('button', { name: 'Esc', exact: true }).click()
}
// What a tap at the middle of `selector` would reach: the window or its scrim, or the app.
const coveredAt = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => {
  const r = el.getBoundingClientRect()
  return Boolean(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.interactive-terminal, .hw-scrim'))
})
const bodyBlocked = (page: Page) => page.evaluate(() => getComputedStyle(document.body).pointerEvents === 'none')

test.beforeEach(async ({ page }) => {
  await expect.poll(size, { timeout: 15_000 }).toEqual(original)
  await screen(usage)
  await page.addInitScript(() => localStorage.setItem('terminalRenderer', 'html'))
  await page.goto(`/#/a/${pane}`)
})
test.afterEach(async () => {
  await screen(null, 'omp')
  await fakeHerdr('e2e.interaction_screen', { pane_id: SPLIT_CHAT_PANE, text: null, agent: 'omp', status: 'idle' })
})

test('shows only the live TUI, sends real keys and closes when its field returns', { tag: '@webkit-phone' }, async ({ page }, info) => {
  const window = page.getByRole('dialog', { name: 'Interactive terminal', exact: true })
  await expect(window).toBeVisible()
  await expect(window.locator('.xterm-rows')).toContainText('View analytics')
  await expect(page.locator('.choices')).toHaveCount(0)
  await expect(page.locator('.hw-sheet')).toHaveCount(0)
  await expect(page.locator('.composer')).toHaveCount(0)
  // A modal like the other windows: their scrim, and nothing behind it can be reached.
  await expect(page.locator('.hw-scrim')).toHaveCount(1)
  expect(await coveredAt(page, '.agent-top')).toBe(true)
  expect(await bodyBlocked(page)).toBe(true)
  const fitted = await size() as { cols: number, rows: number, attached: boolean }
  expect(fitted.attached).toBe(true)
  expect(fitted.cols).not.toBe(original.cols)
  if (info.project.name === 'chromium-phone') expect(fitted.cols).toBeLessThan(60)
  await page.screenshot({ path: `.shots/interactive-terminal-${info.project.name}.png` })
  await window.getByRole('button', { name: '↓', exact: true }).click()
  await window.getByRole('button', { name: 'Enter', exact: true }).click()
  await expect.poll(async () => (await fakeHerdr('e2e.terminal_screen', { pane_id: pane }) as { keys: string[] }).keys).toEqual(['down', 'enter'])
  await escapeKey(page)
  await expect(window).toHaveCount(0)
  await expect(page.locator('.composer')).toBeVisible()
  // Closed by the agent: no scrim left, the app answers again.
  await expect(page.locator('.hw-scrim')).toHaveCount(0)
  await expect.poll(() => bodyBlocked(page)).toBe(false)
  expect(await coveredAt(page, '.agent-top')).toBe(false)
  await expect.poll(size, { timeout: 15_000 }).toEqual(original)
})

test('the scrim covers the whole app; a click on it closes the window until it is reopened', { tag: '@chromium-desktop' }, async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'the window fills the phone screen: no scrim to tap')
  const window = page.getByRole('dialog', { name: 'Interactive terminal', exact: true })
  await expect(window.locator('.xterm-rows')).toContainText('View analytics')
  await page.screenshot({ path: `.shots/interactive-terminal-modal-${info.project.name}.png` })
  const box = (await window.boundingBox())!
  expect(box.x).toBeGreaterThan(40)
  // Agent list, header and conversation: all under the scrim.
  for (const selector of ['#home', '.agent-top', '.swipe-area']) expect(await coveredAt(page, selector)).toBe(true)
  await expect(page.getByRole('tab', { name: 'Terminal', exact: true }).click({ trial: true, timeout: 1000 })).rejects.toThrow()
  // The keys go to the terminal, and the focus cannot leave the window.
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('.interactive-terminal .xterm')))).toBe(true)
  await page.locator('#home button').first().evaluate(el => (el as HTMLElement).focus())
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('.interactive-terminal')))).toBe(true)
  // Reka listens for pointerdown outside, which WebKit's synthetic tap does not send.
  await page.mouse.click(box.x / 2, box.y + box.height / 2)
  await expect(window).toHaveCount(0)
  await expect(page.locator('.hw-scrim')).toHaveCount(0)
  await expect.poll(() => bodyBlocked(page)).toBe(false)
  await expect.poll(size, { timeout: 15_000 }).toEqual(original)
  expect(await sentKeys()).toEqual([])
  // Same episode: it stays closed, with its button to open it again.
  const reopen = page.getByRole('button', { name: 'Open interactive terminal' })
  await expect(reopen).toBeVisible()
  await page.waitForTimeout(3500)
  await expect(window).toHaveCount(0)
  await expect(reopen).toBeVisible()
  await reopen.click()
  await expect(window).toBeVisible()
  await escapeKey(page)
  await expect(window).toHaveCount(0)
})

test('Escape goes to the agent instead of closing the window', { tag: '@chromium-desktop' }, async ({ page, isMobile }) => {
  test.skip(isMobile, 'no hardware keyboard on the phone')
  const window = page.getByRole('dialog', { name: 'Interactive terminal', exact: true })
  await expect(window.locator('.xterm-rows')).toContainText('View analytics')
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('.interactive-terminal .xterm')))).toBe(true)
  await page.keyboard.press('Escape')
  await expect.poll(sentKeys).toContain('esc')
  // The agent left its screen: the window follows, without a manual dismissal.
  await expect(window).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open interactive terminal' })).toHaveCount(0)
  await expect(page.locator('.composer')).toBeVisible()
})

test('manual close releases the pane without Escape and does not reopen the same screen', { tag: '@webkit-phone' }, async ({ page }) => {
  const window = page.getByRole('dialog', { name: 'Interactive terminal', exact: true })
  await expect(window).toBeVisible()
  await window.getByRole('button', { name: 'Close terminal window' }).click()
  await expect(window).toHaveCount(0)
  await expect.poll(size, { timeout: 15_000 }).toEqual(original)
  expect((await fakeHerdr('e2e.terminal_screen', { pane_id: pane }) as { keys: string[] }).keys).toEqual([])
  // More than a screen re-read interval; cursor motion is still the same episode.
  await screen(usage.replace('› 1.', '  1.').replace('  2.', '› 2.'))
  await page.waitForTimeout(3500)
  await expect(window).toHaveCount(0)
  await page.getByRole('button', { name: 'Open interactive terminal' }).click()
  await expect(window).toBeVisible()
  await escapeKey(page)
  await expect(window).toHaveCount(0)
})

test('rejects a stale native choice after the screen changes to an ambiguous menu', async ({ page }) => {
  await expect(page.locator('.interactive-terminal')).toBeVisible()
  const response = await page.request.post('/api/choose', {
    headers: { Origin: new URL(page.url()).origin },
    data: { pane_id: pane, index: 0, label: 'View analytics  Usage history', identity: screenChoices(usage, 'codex')!.identity },
  })
  expect(response.ok()).toBe(false)
  expect((await fakeHerdr('e2e.terminal_screen', { pane_id: pane }) as { keys: string[] }).keys).toEqual([])
})

test('Terminal view after closing the window keeps one fitted terminal for the pane', async ({ page }, info) => {
  const toggle = info.project.name.includes('desktop')
    ? (name: string) => page.getByRole('tab', { name, exact: true }).click()
    : () => page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await expect(page.locator('.interactive-terminal .xterm')).toBeVisible()
  await page.getByRole('button', { name: 'Close terminal window' }).click()
  await expect(page.locator('.interactive-terminal')).toHaveCount(0)
  await toggle('Terminal')
  await expect(page.locator('#term .xterm-rows')).toContainText('View analytics')
  await expect(page.locator('#term .xterm')).toHaveCount(1)
  expect((await size() as { attached: boolean }).attached).toBe(true)
  await toggle('Conversation')
  // Dismissed for this screen: back to the conversation with the button, not the window.
  await expect(page.getByRole('button', { name: 'Open interactive terminal' })).toBeVisible()
  await expect(page.locator('.xterm')).toHaveCount(0)
  await expect.poll(size, { timeout: 15_000 }).toEqual(original)
})

test('in a split, only the cell in use opens the window; another one keeps its button', { tag: '@chromium-desktop' }, async ({ page, isMobile }) => {
  test.skip(isMobile, 'side-by-side cells are a computer layout')
  await fakeHerdr('e2e.interaction_screen', { pane_id: SPLIT_CHAT_PANE, text: usage, agent: 'codex', status: 'idle' })
  // The app is still starting on the first pane: a hash change sent now can be
  // dropped, and the split tab never opens. Wait for that pane's window first.
  await expect(page.locator('.interactive-terminal')).toBeVisible()
  // Start in the shell cell: the other cell's screen must not cover the work in progress.
  await page.goto(`/#/t/${SPLIT_TAB}?pane=${SPLIT_SHELL_PANE}`)
  await expect(page).toHaveURL(new RegExp(`#/t/${SPLIT_TAB}`))
  const chat = page.locator(`.cell-view[data-pane="${SPLIT_CHAT_PANE}"]`)
  const shell = page.locator(`.cell-view[data-pane="${SPLIT_SHELL_PANE}"]`)
  const sizeOf = () => fakeHerdr('e2e.pane_size', { pane_id: SPLIT_CHAT_PANE }) as Promise<{ cols: number, attached: boolean }>
  await expect(shell.locator('.xterm-rows')).toContainText('fake terminal')
  const reopen = chat.getByRole('button', { name: 'Open interactive terminal' })
  await expect(reopen).toBeVisible()
  await page.waitForTimeout(1500)
  await expect(page.locator('.interactive-terminal')).toHaveCount(0)
  await expect(page.locator('.hw-scrim')).toHaveCount(0)
  expect((await sizeOf()).attached).toBe(false)
  // Its button opens the one window, over both cells.
  await reopen.click()
  const window = page.getByRole('dialog', { name: 'Interactive terminal', exact: true })
  await expect(window.locator('.xterm-rows')).toContainText('View analytics')
  await expect(page.locator('.interactive-terminal')).toHaveCount(1)
  expect(await coveredAt(page, `.cell-view[data-pane="${SPLIT_SHELL_PANE}"]`)).toBe(true)
  await expect.poll(async () => (await sizeOf()).attached).toBe(true)
  const before = await sizeOf()
  await page.setViewportSize({ width: 1000, height: 700 })
  await expect.poll(async () => (await sizeOf()).cols).toBeLessThan(before.cols)
  await page.goto('/#/')
  await expect(page.locator('.hw-scrim')).toHaveCount(0)
  await expect.poll(() => bodyBlocked(page)).toBe(false)
  await expect.poll(sizeOf, { timeout: 15000 }).toEqual({ cols: 60, rows: 40, attached: false })
})
