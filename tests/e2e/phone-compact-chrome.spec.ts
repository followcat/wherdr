import { expect, test } from './test'
import { OMP_CHAT_PANE } from './scenario.mjs'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('terminalRenderer', 'html'))
  await page.goto(`/#/a/${OMP_CHAT_PANE}`)
})

test('phone keys default closed, preserve mobile keys, and work in conversation and terminal', { tag: '@webkit-phone' }, async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('phone'), 'Phone-only chrome')
  const toggle = page.getByRole('button', { name: 'Show or hide terminal keys', exact: true })
  const bar = page.getByRole('group', { name: 'Terminal function keys', exact: true })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(bar).toHaveCount(0)
  const closed = (await page.locator('.swipe-area').boundingBox())!.height
  await toggle.click()
  await expect(bar).toBeVisible()
  expect(await page.locator('.xterm-helper-textarea:focus').count()).toBe(0)
  const strip = bar.getByRole('toolbar', { name: 'Common keys and modifiers' })
  expect(await strip.getByRole('button').allTextContents()).toEqual(['Esc', '⇧', 'Tab', '←', '↑', '↓', '→', '⏎', ''])
  expect((await page.locator('.swipe-area').boundingBox())!.height).toBeLessThan(closed)
  const [keyToggle, send] = await Promise.all([toggle.boundingBox(), page.locator('.prompt-send').boundingBox()])
  expect(keyToggle!.y + keyToggle!.height).toBeLessThanOrEqual(send!.y)
  expect(Math.abs(keyToggle!.x + keyToggle!.width / 2 - send!.x - send!.width / 2)).toBeLessThan(12)
  const input = page.waitForRequest(r => r.url().endsWith('/api/input') && r.method() === 'POST')
  await strip.getByRole('button', { name: 'Esc', exact: true }).click()
  expect((await input).postDataJSON()).toMatchObject({ pane_id: OMP_CHAT_PANE, keys: ['esc'] })
  await page.locator('.mode-btn').click()
  await expect(page.locator('#term .xterm-rows')).toBeVisible()
  await expect(bar).toBeVisible()
  const packets: { type: string, keys?: string[] }[] = []
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    if (socket.url().includes('/ws/term?') && typeof payload === 'string') packets.push(JSON.parse(payload))
  }))
  // Reconnect once so the packet observer sees this terminal's socket.
  await page.reload()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await strip.getByRole('button', { name: 'Shift', exact: true }).click()
  await strip.getByRole('button', { name: '←', exact: true }).click()
  await expect.poll(() => packets.flatMap(p => p.keys || [])).toContain('shift+left')
  await strip.getByRole('button', { name: 'Show or hide function keys' }).click()
  await expect(bar.getByRole('button', { name: 'PgUp', exact: true })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'F12', exact: true })).toBeAttached()
  await strip.getByRole('button', { name: 'Shift', exact: true }).click()
  await toggle.click()
  await toggle.click()
  await expect(strip.getByRole('button', { name: 'Shift', exact: true })).toHaveAttribute('aria-pressed', 'false')
})

test('long phone headers fit on one row at 320, 390 and 430 px', { tag: '@webkit-phone' }, async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('phone'), 'Phone-only chrome')
  const state = await (await page.request.get('/api/state')).json()
  const pane = state.panes.find((p: { id: string }) => p.id === OMP_CHAT_PANE)
  state.workspaces.find((w: { id: string }) => w.id === pane.workspace).label = 'A very long project and workspace name for the compact header'
  pane.status = 'blocked'
  await page.routeWebSocket('**/ws/events', ws => ws.send(JSON.stringify(state)))
  await page.reload()
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 })
    const boxes = await page.locator('#agent .agent-top').evaluate(el => {
      const selectors = ['.back', '.space-tab-picker', '.agent-head', '.agent-actions']
      return { width: document.documentElement.clientWidth, boxes: selectors.map(s => {
        const r = el.querySelector(s)!.getBoundingClientRect()
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }
      }) }
    })
    expect(Math.max(...boxes.boxes.map(b => b.y))).toBeLessThan(Math.min(...boxes.boxes.map(b => b.bottom)))
    for (const box of boxes.boxes) { expect(box.x).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(boxes.width) }
    const title = page.locator('#agent .agent-title')
    await expect(title).toHaveCSS('text-overflow', 'ellipsis')
    await expect(page.locator('#agent > .space-tabs')).toHaveCount(0)
  }
  await page.getByRole('button', { name: /^Tabs:/ }).click()
  await expect(page.getByText('Rename tab', { exact: true })).toBeVisible()
  await expect(page.getByText('New tab', { exact: true })).toBeVisible()
})

test('desktop retains its header tabs and terminal key bar', { tag: ['@chromium-desktop', '@webkit-desktop'] }, async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('desktop'), 'Desktop layout')
  await expect(page.locator('#agent')).not.toHaveClass(/phone-chrome/)
  await expect(page.getByRole('button', { name: 'Show or hide terminal keys' })).toHaveCount(0)
  await page.locator('.view-tabs').getByRole('tab', { name: 'Terminal', exact: true }).click()
  await expect(page.getByRole('toolbar', { name: 'Keys', exact: true })).toBeVisible()
})
