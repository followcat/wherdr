import { expect, test, type Page } from './test'
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
  await page.screenshot({ path: `.shots/${info.project.name}-phone-keys-closed.png` })
  const closed = (await page.locator('.swipe-area').boundingBox())!.height
  await toggle.click()
  await expect(bar).toBeVisible()
  expect(await page.locator('.xterm-helper-textarea:focus').count()).toBe(0)
  const strip = bar.getByRole('toolbar', { name: 'Common keys and modifiers' })
  expect(await strip.getByRole('button').evaluateAll(buttons => buttons.map(b => b.getAttribute('aria-label')))).toEqual(['Show or hide the phone keyboard', 'Ctrl', 'Esc', 'Tab', 'Left arrow', 'Up arrow', 'Down arrow', 'Right arrow', 'Enter', 'Ctrl+C', 'Backspace', 'Home', 'End', 'PgUp', 'PgDn', 'Delete', 'Insert', 'Alt', 'Shift', 'Y', 'N', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)])
  expect((await page.locator('.swipe-area').boundingBox())!.height).toBeLessThan(closed)
  const [keyToggle, send] = await Promise.all([toggle.boundingBox(), page.locator('.prompt-send').boundingBox()])
  expect(keyToggle!.y + keyToggle!.height).toBeLessThanOrEqual(send!.y)
  expect(Math.abs(keyToggle!.x + keyToggle!.width / 2 - send!.x - send!.width / 2)).toBeLessThan(12)
  const [firstKey, prompt] = await Promise.all([strip.getByRole('button').first().boundingBox(), page.locator('.prompt').boundingBox()])
  const gap = prompt!.y - (firstKey!.y + firstKey!.height)
  expect(gap).toBeGreaterThanOrEqual(4); expect(gap).toBeLessThanOrEqual(6)
  const input = page.waitForRequest(r => r.url().endsWith('/api/input') && r.method() === 'POST')
  await strip.getByRole('button', { name: 'Esc', exact: true }).click()
  expect((await input).postDataJSON()).toMatchObject({ pane_id: OMP_CHAT_PANE, keys: ['esc'] })
  const keyboard = bar.getByRole('button', { name: 'Show or hide the phone keyboard', exact: true })
  await keyboard.click()
  await expect(page.locator('.composer textarea')).toBeFocused()
  await keyboard.click()
  await expect(page.locator('.composer textarea')).not.toBeFocused()
  for (const [name, keys] of [
    ['Home', ['esc', '[', 'shift+h']], ['End', ['esc', '[', 'shift+f']],
    ['PgUp', ['esc', '[', '5', '~']], ['PgDn', ['esc', '[', '6', '~']],
    ['Insert', ['esc', '[', '2', '~']], ['Delete', ['esc', '[', '3', '~']],
  ] as const) {
    const request = page.waitForRequest(r => r.url().endsWith('/api/input') && r.method() === 'POST')
    await bar.getByRole('button', { name, exact: true }).click()
    expect((await request).postDataJSON()).toEqual({ pane_id: OMP_CHAT_PANE, keys: [...keys] })
  }
  await bar.getByRole('button', { name: 'Ctrl', exact: true }).click()
  const modified = page.waitForRequest(r => r.url().endsWith('/api/input') && r.method() === 'POST')
  await bar.getByRole('button', { name: 'Home', exact: true }).click()
  expect((await modified).postDataJSON()).toEqual({ pane_id: OMP_CHAT_PANE, keys: ['esc', '[', '1', ';', '5', 'shift+h'] })
  await expect(bar.getByRole('button', { name: 'Ctrl', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('#term')).toHaveCount(0)
  await strip.evaluate(el => { el.scrollLeft = 0 })
  await page.screenshot({ path: `.shots/${info.project.name}-conversation-keys-complete.png` })
  const geometry = await strip.getByRole('button').evaluateAll(buttons => buttons.map(b => {
    const r = b.getBoundingClientRect(), hit = getComputedStyle(b, '::after')
    return { x: r.x, y: r.y, w: r.width, h: r.height, hitW: r.width - 2 - parseFloat(hit.left) - parseFloat(hit.right), hitH: r.height - 2 - parseFloat(hit.top) - parseFloat(hit.bottom) }
  }))
  for (const [i, g] of geometry.entries()) {
    expect(g.w).toBeGreaterThanOrEqual(38); expect(g.h).toBe(36)
    expect(g.hitW).toBeGreaterThanOrEqual(44); expect(g.hitH).toBeGreaterThanOrEqual(44)
    expect(g.y).toBe(geometry[0]!.y)
    if (i) {
      const previous = geometry[i - 1]!
      expect(previous.x + previous.w + (previous.hitW - previous.w) / 2).toBeLessThanOrEqual(g.x - (g.hitW - g.w) / 2)
    }
  }
  await page.locator('.mode-btn').click()
  await expect(page.locator('#term .xterm-rows')).toBeVisible()
  await expect(bar).toBeVisible()
  const screen = await page.locator('#term .xterm-screen').boundingBox()
  const keys = await bar.boundingBox()
  expect(screen!.y + screen!.height).toBeLessThanOrEqual(keys!.y)
  await page.screenshot({ path: `.shots/${info.project.name}-phone-keys-open.png` })
  const packets: { type: string, keys?: string[], text?: string }[] = []
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    if (socket.url().includes('/ws/term?') && typeof payload === 'string') packets.push(JSON.parse(payload))
  }))
  // Reconnect once so the packet observer sees this terminal's socket.
  await page.reload()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#term .xterm-rows')).toBeVisible()
  await page.screenshot({ path: `.shots/${info.project.name}-phone-terminal-closed.png` })
  await toggle.click()
  await strip.getByRole('button', { name: 'Shift', exact: true }).click()
  await strip.getByRole('button', { name: 'Left arrow', exact: true }).click()
  await expect.poll(() => packets.flatMap(p => p.keys || [])).toContain('shift+left')
  await strip.getByRole('button', { name: 'Shift', exact: true }).click()
  await strip.getByRole('button', { name: 'Tab', exact: true }).click()
  await expect.poll(() => packets.flatMap(p => p.keys || [])).toContain('shift+tab')
  await expect(bar.getByRole('button', { name: 'PgUp', exact: true })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'F12', exact: true })).toBeAttached()
  for (const [name, bytes] of [['Home', '\x1b[H'], ['End', '\x1b[F'], ['PgUp', '\x1b[5~'], ['PgDn', '\x1b[6~'], ['Insert', '\x1b[2~'], ['Delete', '\x1b[3~']]) {
    await bar.getByRole('button', { name, exact: true }).click()
    await expect.poll(() => packets.filter(p => p.type === 'terminal.input').map(p => p.text)).toContain(bytes)
  }
  await expect(bar.getByRole('button', { name: 'Tab', exact: true })).toHaveCount(1)
  await expect(bar.getByRole('button', { name: 'Shift + Tab', exact: true })).toHaveCount(0)
  for (const key of ['Left arrow', 'Up arrow', 'Down arrow', 'Right arrow', 'Enter', 'Backspace']) {
    const icon = strip.getByRole('button', { name: key, exact: true }).locator('svg')
    await expect(icon).toBeAttached()
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
  pane.label = 'phone-scrolling-多个智能体的长标题'
  pane.agent = 'claude'
  pane.status = 'blocked'
  let update = () => {}
  await page.routeWebSocket('**/ws/events', ws => { update = () => ws.send(JSON.stringify(state)); update() })
  await page.reload()
  const identity = page.locator('.phone-identity')
  await expect(identity.locator('.phone-identity-kind')).toHaveText('Claude')
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
  await expect(page.locator('#agent .agent-top')).toHaveCSS('height', '44px')
  await expect(identity.locator('.pill i')).toHaveCSS('width', '7px')
  await expect(identity.locator('.pill i')).toHaveCSS('border-radius', '0px')
  await expect(identity.locator('[class*=circle]')).toHaveCount(0)
  await identity.click()
  const details = page.locator('.phone-identity-details')
  await expect(page.locator('.hw-sheet-close')).toHaveCount(0)
  await expect(details.locator('.phone-identity-summary')).toHaveCSS('white-space', 'nowrap')
  await page.screenshot({ path: `.shots/${info.project.name}-phone-panes.png` })
  await expect(details.getByText('Panes in this tab', { exact: true })).toBeVisible()
  await expect(details.getByRole('button', { name: /^Tab overview/ })).toBeVisible()
  await expect(details.locator('.menu > button').last()).toContainText('Close entire space…')
  await details.getByRole('button').filter({ hasText: '2/2' }).click()
  await expect(page).toHaveURL(new RegExp(`${SPLIT_SHELL_PANE}$`))
  await expect(identity.locator('.phone-identity-position')).toHaveText('2/2')
  await expect(identity.locator('.phone-identity-kind')).toHaveCount(0)
  await expect(identity.locator('.phone-identity-meta')).toHaveText('Shell')
  expect(await page.locator('textarea:focus,input:focus').count()).toBe(0)
})

// Each action has one place: the identity sheet manages panes and tabs, Options
// keeps the conversation, the agent and its tools.
const PANE_TAB_ACTIONS = ['Rename pane', 'Split right', 'Split down', 'Move to…', 'Rename tab', 'New tab', 'Tab overview', 'Close this conversation']
const sheetItems = (page: Page) => page.locator('.hw-sheet .menu > button .menu-text > span:first-child, .hw-sheet .menu > button:not(:has(.menu-text))').allInnerTexts()

test('phone pane sheet and Options split pane management from agent actions, without duplicates', { tag: '@webkit-phone' }, async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('phone'), 'Phone-only chrome')
  for (const [paneId, split] of [[OMP_CHAT_PANE, false], [SPLIT_CHAT_PANE, true]] as const) {
    await page.goto(`/#/a/${paneId}`)
    const identity = page.locator('.phone-identity')
    await expect(identity.locator('.phone-identity-chevron')).toBeVisible()
    await expect(identity.locator('.phone-identity-position')).toHaveCount(split ? 1 : 0)
    await expect(identity.locator('.phone-identity-toggle .phone-identity-position')).toHaveCount(split ? 1 : 0)
    // The chevron has the same button box and icon size as the terminal button next to it.
    // Also on narrow phones (below 380 px), where the header buttons keep 44 px.
    const box = async (sel: string) => (await page.locator(sel).boundingBox())!
    const viewport = page.viewportSize()!
    for (const width of [viewport.width, 320]) {
      await page.setViewportSize({ width, height: viewport.height })
      const [toggle, term, chevron, termIcon] = await Promise.all([
        box('.phone-identity-toggle'), box('.agent-actions .mode-btn'), box('.phone-identity-chevron'), box('.agent-actions .mode-btn .iconify'),
      ])
      // A lone pane: the very same box. Several panes: the position (1/2) shares it, so it is wider.
      if (split) expect(toggle.height).toBe(term.height)
      else expect([toggle.width, toggle.height]).toEqual([term.width, term.height])
      expect(toggle.width).toBeGreaterThanOrEqual(44)
      expect(toggle.height).toBeGreaterThanOrEqual(44)
      expect(toggle.y).toBe(term.y)
      expect([chevron.width, chevron.height]).toEqual([termIcon.width, termIcon.height])
    }
    await page.setViewportSize(viewport)
    await identity.click()
    await expect(identity.locator('.phone-identity-toggle')).toHaveClass(/\bon\b/)
    await expect(page.locator('.hw-sheet .menu-group').filter({ hasText: 'Current pane' })).toBeVisible()
    const sheet = (await sheetItems(page)).map(x => x.trim())
    await page.screenshot({ path: `.shots/${info.project.name}-pane-sheet-${split ? 'split' : 'single'}.png`, fullPage: true })
    await page.keyboard.press('Escape')
    await expect(page.locator('.hw-sheet')).toHaveCount(0)
    for (const label of PANE_TAB_ACTIONS.filter(x => split || x !== 'Tab overview')) expect(sheet).toContain(label)
    expect(sheet).not.toContain('Close tab')
    expect(sheet.filter(x => x === 'Copy pane ID')).toHaveLength(1)
    await expect(page.locator('.menu-group').filter({ hasText: 'Panes in this tab' })).toHaveCount(0)

    await page.getByRole('button', { name: 'Options', exact: true }).click()
    await expect(page.locator('.hw-sheet').getByText('Reconnect', { exact: true })).toBeVisible()
    const options = (await sheetItems(page)).map(x => x.trim())
    await page.screenshot({ path: `.shots/${info.project.name}-options-${split ? 'split' : 'single'}.png`, fullPage: true })
    await page.keyboard.press('Escape')
    for (const label of ['Search', 'View changes', 'Browse files', 'Reconnect', 'Settings']) expect(options).toContain(label)
    expect(options.some(x => /^(Mute|Unmute|Notif)/.test(x))).toBe(true)
    expect(options.filter(x => sheet.includes(x))).toEqual([])
    for (const label of [...PANE_TAB_ACTIONS, 'Copy pane ID', 'Close tab', 'Close entire space…']) expect(options).not.toContain(label)
    expect(options.some(x => x.startsWith('Close'))).toBe(false)
  }
})

test('phone pane sheet renames the pane and the tab of a lone pane', { tag: '@webkit-phone' }, async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('phone'), 'Phone-only chrome')
  const sent: Record<string, unknown>[] = []
  await page.route('**/api/rename', route => { sent.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }) })
  await page.route('**/api/space', route => { sent.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }) })
  const identity = page.locator('.phone-identity')
  await identity.click()
  await page.locator('.hw-sheet').getByRole('button', { name: 'Rename pane', exact: true }).click()
  await page.getByPlaceholder('Pane name (empty = automatic name)').fill('build notes')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => sent).toContainEqual({ pane_id: OMP_CHAT_PANE, label: 'build notes' })
  await expect(page.getByPlaceholder('Pane name (empty = automatic name)')).toHaveCount(0)
  await identity.click()
  await page.locator('.hw-sheet').getByRole('button', { name: 'Rename tab', exact: true }).click()
  await page.getByPlaceholder('Tab name').fill('review')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => sent).toContainEqual(expect.objectContaining({ op: 'tab.rename', label: 'review' }))
})

test('desktop retains its header tabs and terminal key bar', { tag: ['@chromium-desktop', '@webkit-desktop'] }, async ({ page }, info) => {
  test.skip(!info.project.name.endsWith('desktop'), 'Desktop layout')
  await expect(page.locator('#agent')).not.toHaveClass(/phone-chrome/)
  await expect(page.getByRole('button', { name: 'Show or hide terminal keys' })).toHaveCount(0)
  await page.locator('.view-toggle').click()
  await expect(page.getByRole('toolbar', { name: 'Keys', exact: true })).toBeVisible()
  // The desktop Options menu keeps pane management (there is no pane sheet).
  await page.locator('#agent .agent-actions').getByRole('button', { name: 'Options', exact: true }).click()
  for (const label of ['Rename pane', 'Split right', 'Move to…', 'Copy pane ID', 'Reconnect']) {
    await expect(page.getByRole('menuitem').filter({ hasText: label }).first()).toBeVisible()
  }
  await expect(page.getByRole('menuitem').filter({ hasText: /^Close this pane/ })).toBeVisible()
})
