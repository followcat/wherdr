import { expect, test, type Page } from './test'
import { fakeHerdr, OMP_CHAT_PANE as pane } from './scenario.mjs'

async function start(page: Page) {
  await fakeHerdr('e2e.terminal_version', { version: '0.9.5' })
  await fakeHerdr('e2e.touch_scroll', { pane_id: pane, reset: true, mouse: true, offset: 20 })
  await page.addInitScript(() => {
    localStorage.setItem('terminalRenderer', 'html')
    localStorage.setItem('smoothTouchScrolling', '1')
  })
  await page.goto(`/#/a/${pane}`)
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await expect(page.locator('#term .xterm-rows')).toContainText('History offset 20')
}
async function hold(page: Page) {
  const box = (await page.locator('#touch').boundingBox())!
  const input = await page.context().newCDPSession(page)
  await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 70, y: box.y + 90 }] })
  await expect(page.locator('.terminal-copy-layer')).toBeVisible()
  await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}
async function selectRows(page: Page) {
  return page.locator('.terminal-copy-text').evaluate(el => {
    const range = document.createRange()
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()!
    while (node && !node.textContent?.includes('History offset 20')) node = walker.nextNode()!
    range.setStart(node, 0)
    range.setEnd(node, 'History offset 20'.length)
    const selection = getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return selection.toString()
  })
}

test.afterEach(async () => {
  await fakeHerdr('e2e.touch_scroll', { pane_id: pane, clear: true })
  await fakeHerdr('e2e.terminal_version', { version: '0.9.1' })
})

test('phone copy freezes once, copies the scoped selection and exits without input', async ({ page, isMobile, browserName }) => {
  test.skip(!isMobile || browserName !== 'chromium', 'Trusted hold uses Chromium CDP')
  const packets: Record<string, unknown>[] = []
  page.on('websocket', socket => {
    if (socket.url().includes('/ws/term?')) socket.on('framesent', ({ payload }) => {
      if (typeof payload === 'string') packets.push(JSON.parse(payload))
    })
  })
  await start(page)
  const before = await page.locator('#termWrap').boundingBox()
  await page.getByRole('button', { name: 'Show or hide terminal keys', exact: true }).click()
  await hold(page)
  const text = page.locator('.terminal-copy-text')
  const frozen = await text.textContent()
  await expect(page.locator('.terminal-copy-tools button')).toHaveCount(2)
  await expect(page.locator('.terminal-copy-tools')).not.toContainText(/all/i)
  await expect(page.locator('.composer')).toHaveAttribute('inert', '')
  await expect(page.getByRole('group', { name: 'Terminal function keys', exact: true })).toHaveAttribute('inert', '')
  expect(await page.locator('.terminal-copy-tools button').evaluateAll(els => els.every(el => el.getBoundingClientRect().height >= 44))).toBe(true)
  expect(await page.locator('.terminal-copy-tools button span').first().evaluate(el => el.getBoundingClientRect().height)).toBe(28)
  await page.locator('.terminal-copy-text').evaluate(el => { (window as any).__frozenNode = el.firstChild })
  const selected = await selectRows(page)
  await fakeHerdr('e2e.touch_scroll', { pane_id: pane, offset: 25 })
  await expect(page.locator('#term .xterm-rows')).toContainText('History offset 25')
  await page.setViewportSize({ width: 360, height: 600 })
  expect(await text.textContent()).toBe(frozen)
  expect(await text.evaluate(el => el.firstChild === (window as any).__frozenNode)).toBe(true)
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(selected)
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => { (window as any).__copied = s } } }))
  await page.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).__copied)).toBe(selected)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.locator('.terminal-copy-layer')).toHaveCount(0)
  await expect(page.locator('.xterm-helper-textarea')).not.toBeFocused()
  await expect(page.getByRole('group', { name: 'Terminal function keys', exact: true })).not.toHaveAttribute('inert', '')
  expect(packets.filter(p => p.type === 'terminal.mouse' || p.type === 'terminal.input' || p.type === 'terminal.scroll')).toEqual([])
  expect(packets.some(p => p.type === 'touch.cancel')).toBe(true)
  expect(before?.width).toBeGreaterThan(0)
})

test('copy failure preserves native selection; Escape closes without sending a key', async ({ page, isMobile, browserName }) => {
  test.skip(!isMobile || browserName !== 'chromium', 'Trusted hold uses Chromium CDP')
  await start(page)
  await hold(page)
  const selected = await selectRows(page)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied') } } })
    document.execCommand = () => false
  })
  await page.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Copy failed')
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(selected)
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.terminal-copy-layer')).toHaveCount(0)
  await expect(page.locator('.xterm-helper-textarea')).not.toBeFocused()
})

test('system Select all copies only frozen text, excluding the header and underlying grid', async ({ page, isMobile, browserName }) => {
  test.skip(!isMobile || browserName !== 'chromium', 'Trusted hold uses Chromium CDP')
  await start(page)
  await hold(page)
  const frozen = (await page.locator('.terminal-copy-text').textContent())!
  await page.evaluate(() => {
    getSelection()!.selectAllChildren(document.body)
    document.dispatchEvent(new Event('selectionchange'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => { (window as any).__copied = s } } })
  })
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeEnabled()
  const native = await page.evaluate(() => {
    const clipboardData = new DataTransfer()
    document.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }))
    return clipboardData.getData('text/plain')
  })
  expect(native).toBe(frozen)
  await page.getByRole('button', { name: 'Copy', exact: true }).click()
  expect(await page.evaluate(() => (window as any).__copied)).toBe(frozen)
})
