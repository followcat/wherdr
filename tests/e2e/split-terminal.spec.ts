import { type Locator, type Page, expect, test } from './test'
import { SPLIT_CHAT_PANE, SPLIT_SHELL_PANE, SPLIT_TAB, fakeHerdr } from './scenario.mjs'

// Every visible terminal stays connected and fitted to its cell. Focus routes
// input without replacing instances; leaving the tab restores original sizes.
test.skip(({ isMobile }) => isMobile, 'side-by-side cells are a computer layout')

// The fake panes start at their layout size and keep the size control gave them.
const original = (pane: string) => ({ cols: pane === SPLIT_CHAT_PANE ? 60 : 59, rows: 40, attached: false })
const paneSize = (pane: string) => fakeHerdr('e2e.pane_size', { pane_id: pane }) as Promise<{ cols: number, rows: number, attached: boolean }>

const shot = (page: Page, name: string, project: string) =>
  process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${project}-${name}.png` }) : Promise.resolve()

const cell = (page: Page, pane: string) => page.locator(`.cell-view[data-pane="${pane}"]`)

async function open(page: Page, width: number, height: number) {
  // DOM renderer: the terminal's text is in the page.
  await page.addInitScript(() => localStorage.setItem('terminalRenderer', 'html'))
  await page.setViewportSize({ width, height })
  await page.goto(`/#/t/${SPLIT_TAB}`)
  await expect(page.locator('.cell-view')).toHaveCount(2)
}

// The screen leaves less than one character (and the terminal's padding) free
// on each axis of its cell's body.
async function expectFilled(body: Locator, cols: number, rows: number) {
  const m = await body.evaluate((el) => {
    const s = el.querySelector('.xterm-screen') as HTMLElement
    return { boxW: el.clientWidth, boxH: el.clientHeight, w: s.offsetWidth, h: s.offsetHeight }
  })
  expect(m.w).toBeGreaterThan(m.boxW - 20 - m.w / cols - 1)
  expect(m.w).toBeLessThanOrEqual(m.boxW)
  expect(m.h).toBeGreaterThan(m.boxH - 12 - m.h / rows - 1)
  expect(m.h).toBeLessThanOrEqual(m.boxH)
  return m
}

test.beforeEach(async () => {
  for (const pane of [SPLIT_CHAT_PANE, SPLIT_SHELL_PANE]) await expect.poll(() => paneSize(pane), { timeout: 15_000 }).toEqual(original(pane))
})

test('focus preserves every visible terminal and its connection', { tag: ['@chromium-desktop', '@webkit-desktop'] }, async ({ page }) => {
  const connections: string[] = []
  const frames = new Map<string, number>()
  page.on('websocket', ws => {
    if (!ws.url().includes('/ws/term?')) return
    connections.push(ws.url())
    const pane = new URL(ws.url()).searchParams.get('pane')!
    ws.on('framereceived', () => frames.set(pane, (frames.get(pane) || 0) + 1))
  })
  await open(page, 1440, 900)
  const chat = cell(page, SPLIT_CHAT_PANE)
  const shell = cell(page, SPLIT_SHELL_PANE)
  await chat.getByRole('button', { name: 'Show terminal' }).click()
  await expect(chat.locator('#term .xterm-rows')).toContainText('fake terminal')
  await shell.locator('header').click()
  await expect(shell.locator('#term .xterm-rows')).toContainText('fake terminal')
  // Keep actual DOM identities: matching text after a remount is insufficient.
  const nodes = await page.locator('.cell-view #term .xterm').elementHandles()
  expect(nodes).toHaveLength(2)
  const count = connections.length
  const before = new Map(frames)
  for (let i = 0; i < 6; i++) {
    await chat.locator('header .agent-title').click()
    await shell.locator('header .agent-title').click()
  }
  for (const node of nodes) expect(await node.evaluate(el => el.isConnected)).toBe(true)
  expect(connections).toHaveLength(count)
  for (const pane of [SPLIT_CHAT_PANE, SPLIT_SHELL_PANE]) {
    expect((await paneSize(pane)).attached).toBe(true)
    await expect.poll(() => frames.get(pane) || 0).toBeGreaterThan((before.get(pane) || 0) + 2)
  }
  await chat.getByRole('button', { name: 'Show conversation' }).click()
  await expect(chat.locator('.chat')).toContainText('It runs in the pane on the right.')
  expect(await nodes[1]!.evaluate(el => el.isConnected)).toBe(true)
  await chat.getByRole('button', { name: 'Show terminal' }).click()
  await expect(chat.locator('#term .xterm-rows')).toContainText('fake terminal')
  expect(await nodes[1]!.evaluate(el => el.isConnected)).toBe(true)
})

for (const [width, height] of [[1440, 900], [2000, 1125]] as const) {
  test(`the terminal of the focused cell fills the cell (${width} px)`, { tag: '@chromium-desktop' }, async ({ page }, testInfo) => {
    await open(page, width, height)
    const chat = cell(page, SPLIT_CHAT_PANE)
    await expect(chat.locator('.chat').getByText('It runs in the pane on the right.')).toBeVisible()
    await shot(page, `split-terminal-${width}-conversation`, testInfo.project.name)

    await chat.getByRole('button', { name: 'Show terminal' }).click()
    await expect(chat.locator('#term .xterm-rows')).toContainText('fake terminal')
    await expect.poll(async () => (await paneSize(SPLIT_CHAT_PANE)).attached).toBe(true)
    const size = await paneSize(SPLIT_CHAT_PANE)
    await expect(chat.locator('#term .xterm-rows')).toContainText(`fake terminal ${size.cols}x${size.rows}`)
    const m = await expectFilled(chat.locator('#termWrap'), size.cols, size.rows)
    // The whole cell, not the reading column of a pane opened alone (760 px).
    if (width === 2000) expect(m.w).toBeGreaterThan(780)
    await shot(page, `split-terminal-${width}`, testInfo.project.name)
  })
}

test('the terminal follows its cell when the window is resized', { tag: '@chromium-desktop' }, async ({ page }) => {
  await open(page, 2000, 1125)
  const shell = cell(page, SPLIT_SHELL_PANE)
  await shell.click()
  await expect(shell.locator('#term .xterm-rows')).toContainText('fake terminal')
  await expect.poll(async () => (await paneSize(SPLIT_SHELL_PANE)).attached).toBe(true)
  const wide = await paneSize(SPLIT_SHELL_PANE)

  await page.setViewportSize({ width: 1440, height: 900 })
  await expect.poll(async () => (await paneSize(SPLIT_SHELL_PANE)).cols).toBeLessThan(wide.cols)
  const narrow = await paneSize(SPLIT_SHELL_PANE)
  expect(narrow.rows).toBeLessThan(wide.rows)
  await expect(shell.locator('#term .xterm-rows')).toContainText(`fake terminal ${narrow.cols}x${narrow.rows}`)
  await expectFilled(shell.locator('#termWrap'), narrow.cols, narrow.rows)
})

test('inactive terminals follow cell resizing and restore their size after leaving', { tag: '@chromium-desktop' }, async ({ page }) => {
  await open(page, 1440, 900)
  const shell = cell(page, SPLIT_SHELL_PANE)
  await expect(shell.locator('#term .xterm-rows')).toContainText('fake terminal')
  const fitted = await paneSize(SPLIT_SHELL_PANE)
  await cell(page, SPLIT_CHAT_PANE).locator('.chat').click()
  expect((await paneSize(SPLIT_SHELL_PANE)).attached).toBe(true)
  await page.setViewportSize({ width: 1200, height: 800 })
  await expect.poll(async () => (await paneSize(SPLIT_SHELL_PANE)).cols).toBeLessThan(fitted.cols)
  const again = await paneSize(SPLIT_SHELL_PANE)
  await expectFilled(shell.locator('#termWrap'), again.cols, again.rows)
  await page.goto('/#/')
  await expect.poll(() => paneSize(SPLIT_SHELL_PANE), { timeout: 10_000 }).toEqual(original(SPLIT_SHELL_PANE))
})

// What the terminal of a pane was sent as keyboard input.
function typedInto(page: Page, pane: string) {
  const typed: string[] = []
  page.on('websocket', ws => {
    if (!ws.url().includes('/ws/term?') || new URL(ws.url()).searchParams.get('pane') !== pane) return
    ws.on('framesent', (f) => {
      const m = JSON.parse(String(f.payload))
      if (m.type === 'terminal.input') typed.push(m.text)
    })
  })
  return typed
}

test('a click on the header of the active cell keeps the keyboard in its terminal', { tag: '@chromium-desktop' }, async ({ page }) => {
  const typed = typedInto(page, SPLIT_SHELL_PANE)
  await open(page, 1440, 900)
  const shell = cell(page, SPLIT_SHELL_PANE)
  await shell.locator('#term').click()
  await expect.poll(async () => (await paneSize(SPLIT_SHELL_PANE)).attached).toBe(true)
  await page.keyboard.type('a')
  await expect.poll(() => typed.join('')).toBe('a')
  // Already active: its header takes no focus, the terminal keeps the keyboard.
  await shell.locator('header .agent-title').click()
  await page.keyboard.type('b')
  await expect.poll(() => typed.join('')).toBe('ab')
  expect(await page.evaluate(pane => Boolean(document.activeElement?.closest(`.cell-view[data-pane="${pane}"] #term`)), SPLIT_SHELL_PANE)).toBe(true)
})

test('Ctrl+Alt+arrow without a neighbour that way sends nothing to the terminal', { tag: '@chromium-desktop' }, async ({ page }) => {
  const typed = typedInto(page, SPLIT_SHELL_PANE)
  await open(page, 1440, 900)
  const shell = cell(page, SPLIT_SHELL_PANE)
  await shell.locator('#term').click()
  await expect.poll(async () => (await paneSize(SPLIT_SHELL_PANE)).attached).toBe(true)
  // The last cell in reading order: nothing after it.
  await page.keyboard.press('Control+Alt+ArrowRight')
  await page.keyboard.press('Control+Alt+ArrowDown')
  await page.keyboard.type('a')
  await expect.poll(() => typed.join('')).toBe('a')
  await expect(shell).toHaveClass(/active/)
  // With a neighbour, the shortcut still moves the focus.
  await page.keyboard.press('Control+Alt+ArrowLeft')
  await expect(cell(page, SPLIT_CHAT_PANE)).toHaveClass(/active/)
  expect(typed.join('')).toBe('a')
})
