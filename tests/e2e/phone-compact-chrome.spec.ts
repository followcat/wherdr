import { expect, test } from './test'
import { OMP_CHAT_PANE, SPLIT_CHAT_PANE, SPLIT_SHELL_PANE } from './scenario.mjs'

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
  expect(await strip.getByRole('button').evaluateAll(buttons => buttons.map(b => b.getAttribute('aria-label')))).toEqual(['Esc', 'Shift', 'Tab', '←', '↑', '↓', '→', 'Enter', 'Show or hide function keys'])
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
  await strip.getByRole('button', { name: 'Shift', exact: true }).click()
  await strip.getByRole('button', { name: 'Tab', exact: true }).click()
  await expect.poll(() => packets.flatMap(p => p.keys || [])).toContain('shift+tab')
  await strip.getByRole('button', { name: 'Show or hide function keys' }).click()
  await expect(bar.getByRole('button', { name: 'PgUp', exact: true })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'F12', exact: true })).toBeAttached()
  await expect(bar.getByRole('button', { name: 'Tab', exact: true })).toHaveCount(1)
  await expect(bar.getByRole('button', { name: 'Shift + Tab', exact: true })).toHaveCount(0)
  for (const key of ['Shift', '←', '↑', '↓', '→', 'Enter']) {
    const icon = strip.getByRole('button', { name: key, exact: true }).locator('svg')
    await expect(icon).toBeVisible()
    await expect(icon.locator('path').first()).toBeAttached()
  }
  await strip.getByRole('button', { name: 'Shift', exact: true }).click()
  await toggle.click()
  await toggle.click()
  await expect(strip.getByRole('button', { name: 'Shift', exact: true })).toHaveAttribute('aria-pressed', 'false')
})

test('phone identity preserves agent and touch targets at 320, 360 and 412 px, including large text', { tag: '@webkit-phone' }, async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('phone'), 'Phone-only chrome')
  const state = await (await page.request.get('/api/state')).json()
  const pane = state.panes.find((p: { id: string }) => p.id === OMP_CHAT_PANE)
  state.workspaces.find((w: { id: string }) => w.id === pane.workspace).label = 'phone'
  state.tabs.find((tab: { id: string }) => tab.id === pane.tab).label = 'phone-scrolling-多个智能体的长标题'
  pane.label = null
  pane.agent = 'devin'
  pane.status = 'blocked'
  let update = () => {}
  await page.routeWebSocket('**/ws/events', ws => { update = () => ws.send(JSON.stringify(state)); update() })
  await page.reload()
  const identity = page.locator('.phone-identity')
  await expect(identity.locator('.phone-identity-kind')).toHaveText('Devin')
  await expect(identity.locator('.phone-identity-title')).toHaveText('phone-scrolling-多个智能体的长标题')
  for (const width of [320, 360, 412]) {
    await page.setViewportSize({ width, height: 844 })
    for (const scale of [1, 1.3]) {
    await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px` }, scale)
    const boxes = await page.locator('#agent .agent-top').evaluate(el => {
      const selectors = ['.back', '.phone-identity', '.mode-btn', '.agent-actions > button:last-child']
      const kind = el.querySelector('.phone-identity-kind')!
      return { width: document.documentElement.clientWidth, kindFits: kind.scrollWidth <= kind.clientWidth, boxes: selectors.map(s => {
        const r = el.querySelector(s)!.getBoundingClientRect()
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
      }) }
    })
    expect(Math.max(...boxes.boxes.map(b => b.y))).toBeLessThan(Math.min(...boxes.boxes.map(b => b.bottom)))
    expect(boxes.kindFits).toBe(true)
    for (const [i, box] of boxes.boxes.entries()) {
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(boxes.width)
      expect(box.height).toBeGreaterThanOrEqual(44)
      if (i !== 1) expect(box.width).toBeGreaterThanOrEqual(44)
      if (i) expect(box.x).toBeGreaterThanOrEqual(boxes.boxes[i - 1]!.right)
    }
    await expect(identity.locator('.phone-identity-title')).toHaveCSS('text-overflow', 'ellipsis')
    await expect(page.locator('#agent > .space-tabs')).toHaveCount(0)
    }
  }
  const before = await identity.locator('.phone-identity-title').boundingBox()
  pane.status = 'working'; update()
  await expect(identity).toHaveAccessibleName(/Working/)
  expect(await identity.locator('.phone-identity-title').boundingBox()).toEqual(before)
  // A sibling tab changes neither the selected identity nor its routing.
  const original = state.tabs.find((tab: { id: string }) => tab.id === pane.tab)
  state.tabs.push({ ...original, id: 'w3:t2', label: 'phone-review', number: 2, layout: null })
  state.panes.push({ ...pane, id: 'w3:p2', tab: 'w3:t2', label: 'Review Login' })
  update()
  await expect(identity.locator('.phone-identity-title')).toHaveText('phone-scrolling-多个智能体的长标题')
  await identity.click()
  const details = page.locator('.phone-identity-details')
  await expect(details).toContainText('phone-scrolling-多个智能体的长标题')
  await expect(details).toContainText('Devin')
  await expect(details.getByRole('button', { name: /^phone-review/ })).toBeVisible()
  await expect(page.getByText('Rename tab', { exact: true })).toBeVisible()
  await expect(page.getByText('New tab', { exact: true })).toBeVisible()
  await details.getByRole('button', { name: /^phone-review/ }).click()
  await expect(page).toHaveURL(/w3:p2$/)
  await expect(identity.locator('.phone-identity-title')).toHaveText('Review Login')
})

test('phone identity opens panes before tabs and switches in reading order without opening the keyboard', { tag: '@webkit-phone' }, async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('phone'), 'Phone-only chrome')
  await page.goto(`/#/a/${SPLIT_CHAT_PANE}`)
  const identity = page.locator('.phone-identity')
  await expect(identity.locator('.phone-identity-position')).toHaveText('1/2')
  await identity.click()
  const details = page.locator('.phone-identity-details')
  await expect(details.getByText('Panes in this tab', { exact: true })).toBeVisible()
  await expect(details.getByRole('button', { name: 'Tab overview', exact: true })).toBeVisible()
  await details.getByRole('button').filter({ hasText: '2/2' }).click()
  await expect(page).toHaveURL(new RegExp(`${SPLIT_SHELL_PANE}$`))
  await expect(identity.locator('.phone-identity-position')).toHaveText('2/2')
  await expect(identity.locator('.phone-identity-kind')).toHaveText('Shell')
  expect(await page.locator('textarea:focus,input:focus').count()).toBe(0)
})

test('desktop retains its header tabs and terminal key bar', { tag: ['@chromium-desktop', '@webkit-desktop'] }, async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('desktop'), 'Desktop layout')
  await expect(page.locator('#agent')).not.toHaveClass(/phone-chrome/)
  await expect(page.getByRole('button', { name: 'Show or hide terminal keys' })).toHaveCount(0)
  await page.locator('.view-tabs').getByRole('tab', { name: 'Terminal', exact: true }).click()
  await expect(page.getByRole('toolbar', { name: 'Keys', exact: true })).toBeVisible()
})
