import { expect, test, type Page } from './test'
import { OMP_CHAT_PANE as pane, fakeHerdr } from './scenario.mjs'

const state = () => fakeHerdr('e2e.touch_scroll', { pane_id: pane }) as Promise<{ offset: number, events: { lines: number }[] }>
async function touch(page: Page, type: string, y: number, startY?: number) {
  return page.locator('#touch').evaluate((el, { type, y, startY }) => {
    const r = el.getBoundingClientRect()
    const dispatch = (kind: string, at: number) => {
      const point = { identifier: 1, target: el, clientX: r.left + r.width / 2, clientY: r.top + at }
      // WebKit forbids constructing Touch. Use real DOM listeners with the
      // same touch lists; xterm, geometry and transport remain browser code.
      const event = new Event(kind, { bubbles: true, cancelable: true })
      Object.defineProperties(event, { touches: { value: kind === 'touchend' || kind === 'touchcancel' ? [] : [point] }, changedTouches: { value: [point] } })
      el.dispatchEvent(event)
    }
    if (startY !== undefined) dispatch('touchstart', startY)
    dispatch(type, y)
    const screen = el.parentElement?.querySelector('.xterm-screen') as HTMLElement
    return screen?.style.transform || ''
  }, { type, y, startY })
}

async function terminal(page: Page, enabled: boolean, offset = 0) {
  await page.addInitScript(enabled => {
    localStorage.setItem('terminalRenderer', 'html')
    localStorage.setItem('smoothTouchScrolling', enabled ? '1' : '0')
  }, enabled)
  await page.goto(`/#/a/${pane}`)
  const tabs = page.locator('.view-tabs')
  if (await tabs.count()) await tabs.getByRole('tab', { name: 'Terminal' }).click()
  else await page.locator('button[aria-label="Terminal"]').first().click()
  await expect(page.locator('#term .xterm-rows')).toContainText(`History offset ${offset}`)
}

test.beforeEach(async () => {
  await expect.poll(async () => (await fakeHerdr('e2e.pane_size', { pane_id: pane }) as { attached: boolean }).attached).toBe(false)
  // Exercise the mouse-capable transport used by opaque applications. The
  // default fake version predates this capability and bypasses that route.
  await fakeHerdr('e2e.terminal_version', { version: '0.9.5' })
})

test.afterEach(async () => {
  await fakeHerdr('e2e.touch_scroll', { pane_id: pane, clear: true })
  await fakeHerdr('e2e.interaction_screen', { pane_id: pane, text: null })
  await fakeHerdr('e2e.terminal_version', { version: '0.9.1' })
})

test('an opaque TUI receives a real swipe, and the next tap stops it without clicking', async ({ page, isMobile, browserName }) => {
  test.skip(!isMobile || browserName !== 'chromium', 'Real touch swipes use Chromium CDP on the phone profile')
  await fakeHerdr('e2e.touch_scroll', { pane_id: pane, reset: true, mouse: true, offset: 20 })
  const packets: Record<string, unknown>[] = []
  page.on('websocket', socket => {
    if (socket.url().includes('/ws/term?')) socket.on('framesent', ({ payload }) => {
      if (typeof payload === 'string') packets.push(JSON.parse(payload))
    })
  })
  await terminal(page, true, 20)
  const box = (await page.locator('#touch').boundingBox())!
  const x = box.x + box.width / 2, y = box.y + box.height / 3
  // Hit-test before dispatching any events: a native history overlay must not
  // intercept this application's gesture with a guessed transcript document.
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, { x, y })).toBe('touch')
  const grid = await page.locator('.xterm-screen').boundingBox()
  const input = await page.context().newCDPSession(page)
  await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  for (const dy of [20, 40, 60, 80]) {
    await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + dy }] })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    expect(await page.locator('.xterm-screen').boundingBox()).toEqual(grid)
  }
  await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await expect.poll(async () => (await state()).offset).toBeGreaterThan(20)
  const before = packets.filter(p => p.type === 'touch.cancel').length
  await page.touchscreen.tap(x, y + 80)
  await expect.poll(() => packets.filter(p => p.type === 'touch.cancel').length).toBeGreaterThan(before)
  await expect(page.locator('.xterm-helper-textarea')).not.toBeFocused()
  expect(packets.filter(p => p.type === 'terminal.mouse')).toEqual([])
  await expect.poll(() => page.locator('.xterm-screen').evaluate(el => (el as HTMLElement).style.transform)).toBe('')
  await expect(page.locator('.lt-doc')).toHaveCount(0)
  await input.detach()
})

for (const enabled of [false, true]) {
  test(`a native sub-row drag cannot reopen the keyboard with beta ${enabled ? 'on' : 'off'}`, async ({ page, isMobile, browserName }) => {
    test.skip(!isMobile || browserName !== 'chromium', 'Native drag uses phone CDP')
    await fakeHerdr('e2e.touch_scroll', { pane_id: pane, reset: true, mouse: true })
    await terminal(page, enabled)
    const field = page.locator('.xterm-helper-textarea')
    // Android Back hides the IME without blurring this still-focused field.
    await field.focus()
    await expect(field).toBeFocused()
    const box = (await page.locator('#touch').boundingBox())!
    const x = box.x + box.width / 2, y = box.y + box.height * .8
    const grid = await page.locator('.xterm-screen').boundingBox()
    const input = await page.context().newCDPSession(page)
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 7 }] })
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(field).not.toBeFocused()
    expect(await page.locator('.xterm-screen').boundingBox()).toEqual(grid)
    expect(await page.locator('.xterm-screen').evaluate(el => (el as HTMLElement).style.transform)).toBe('')
    await touch(page, 'touchstart', 100)
    await touch(page, 'touchend', 107)
    await expect(field).not.toBeFocused()
    await input.detach()
  })
}

test('dismissing the phone keyboard releases terminal focus before the next scroll', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Keyboard dismissal uses the phone viewport')
  await fakeHerdr('e2e.touch_scroll', { pane_id: pane, reset: true, mouse: true })
  await terminal(page, true)
  const field = page.locator('.xterm-helper-textarea')
  await page.locator('#touch').tap()
  await expect(field).toBeFocused()
  const viewport = page.viewportSize()!
  await page.setViewportSize({ ...viewport, height: viewport.height - 200 })
  await expect(page.locator('body')).toHaveClass(/\bkb\b/)
  await page.setViewportSize(viewport)
  await expect(page.locator('body')).not.toHaveClass(/\bkb\b/)
  await expect(field).not.toBeFocused()
  await touch(page, 'touchmove', 130, 100)
  await touch(page, 'touchend', 130)
  await expect(field).not.toBeFocused()
})

test('a phone terminal link to this app stays in its existing window', async ({ page, context, isMobile, baseURL }) => {
  test.skip(!isMobile, 'The phone opens internal links in place')
  await fakeHerdr('e2e.touch_scroll', { pane_id: pane, reset: true, mouse: true })
  await terminal(page, true)
  await fakeHerdr('e2e.touch_scroll', { pane_id: pane, clear: true })
  const url = baseURL + '/'
  await page.evaluate(() => { document.documentElement.dataset.terminalLinkDocument = 'keep' })
  await fakeHerdr('e2e.interaction_screen', { pane_id: pane, text: '\x1b]8;;' + url + '\x07Open settings\x1b]8;;\x07' })
  await expect(page.locator('.xterm-rows')).toContainText('Open settings')
  const pages = context.pages().length
  const screen = page.locator('.xterm-screen')
  const box = (await screen.boundingBox())!
  const rows = await page.locator('.xterm-rows > *').count()
  await page.touchscreen.tap(box.x + 16, box.y + box.height / rows / 2)
  await expect(page).toHaveURL(/#\/$/)
  expect(await page.locator('html').getAttribute('data-terminal-link-document')).toBe('keep')
  expect(context.pages()).toHaveLength(pages)
  await fakeHerdr('e2e.interaction_screen', { pane_id: pane, text: null })
})

test('a short drag responds once without reversing on tiny finger backtracking', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Fine touch movement uses the phone layout')
  await fakeHerdr('e2e.touch_scroll', { pane_id: pane, reset: true, mouse: true, offset: 20 })
  await terminal(page, true, 20)
  await page.evaluate(() => document.fonts.ready)
  await touch(page, 'touchmove', 110, 100)
  await expect.poll(async () => (await state()).offset).toBe(21)
  for (const y of [109, 110, 111]) await touch(page, 'touchmove', y)
  const result = await state()
  expect(result.offset).toBe(21)
  expect(result.events).toHaveLength(1)
  await touch(page, 'touchend', 111)
})

test('a drag continues after the phone viewport resizes', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Viewport resizing exercises the phone layout')
  await fakeHerdr('e2e.touch_scroll', { pane_id: pane, reset: true, mouse: true, offset: 20 })
  await terminal(page, true, 20)
  await touch(page, 'touchmove', 120, 80)
  await expect.poll(async () => (await state()).offset).toBeGreaterThan(20)
  const beforeHeight = await page.locator('#touch').evaluate(el => el.clientHeight)
  const beforeRows = (await fakeHerdr('e2e.pane_size', { pane_id: pane }) as { rows: number }).rows
  const viewport = page.viewportSize()!
  await page.setViewportSize({ ...viewport, height: viewport.height - 100 })
  await expect.poll(() => page.locator('#touch').evaluate(el => el.clientHeight)).toBeLessThan(beforeHeight)
  // Wait for the resize to cross the transport before continuing the same
  // touch. Keyboard resize must not turn the remaining motion into a tap.
  await expect.poll(async () => (await fakeHerdr('e2e.pane_size', { pane_id: pane }) as { rows: number }).rows).toBeLessThan(beforeRows)
  const offset = (await state()).offset
  await touch(page, 'touchmove', 180)
  await expect.poll(async () => (await state()).offset).toBeGreaterThan(offset)
  await touch(page, 'touchend', 180)
  await expect(page.locator('.xterm-helper-textarea')).not.toBeFocused()
})

test('a deliberate native tap focuses an opaque TUI once', { tag: '@webkit-phone' }, async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Native touch input uses the phone profile')
  await fakeHerdr('e2e.touch_scroll', { pane_id: pane, reset: true, mouse: true })
  await terminal(page, true)
  await page.locator('#touch').tap()
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
  const s = await fakeHerdr('e2e.terminal_mouse', { pane_id: pane }) as { events: { pane_id: string, event: { action: string } }[] }
  expect(s.events.filter(e => e.pane_id === pane && e.event.action === 'down')).toHaveLength(1)
  expect(s.events.filter(e => e.pane_id === pane && e.event.action === 'up')).toHaveLength(1)
})

for (const enabled of [false, true]) {
  for (const mouse of [false, true]) {
    test(`touch beta ${enabled ? 'on' : 'off'}, ${mouse ? 'mouse app' : 'plain history'}: fixed frame and scroll contract`, { tag: '@webkit-phone' }, async ({ page, isMobile }, info) => {
      test.skip(!isMobile, 'Touch gestures use the phone viewport')
      await fakeHerdr('e2e.touch_scroll', { pane_id: pane, reset: true, mouse })
      const packets: Record<string, unknown>[] = [], incoming: Record<string, unknown>[] = []
      page.on('websocket', socket => {
        if (!socket.url().includes('/ws/term?')) return
        socket.on('framesent', ({ payload }) => { if (typeof payload === 'string') packets.push(JSON.parse(payload)) })
        socket.on('framereceived', ({ payload }) => { if (typeof payload === 'string') incoming.push(JSON.parse(payload)) })
      })
      await terminal(page, enabled)
      const bounds = await page.locator('#termWrap').boundingBox()
      if (enabled) await expect(page.locator('#termWrap')).toHaveClass(/smooth-touch/)
      // The grid must remain fixed before and after remote frames arrive.
      const transform = await touch(page, 'touchmove', 90, 50)
      expect(await page.locator('#termWrap').boundingBox()).toEqual(bounds)
      expect(transform).toBe('')
      await expect.poll(async () => (await state()).offset).toBeGreaterThan(0)
      await touch(page, 'touchend', 90)
      await expect.poll(() => page.locator('.xterm-screen').evaluate(el => (el as HTMLElement).style.transform)).toBe('')
      const scrolls = packets.filter(p => p.type === 'terminal.scroll')
      expect(scrolls.length).toBeGreaterThan(0)
      if (enabled) {
        expect(scrolls.every(p => p.source === 'touch')).toBe(true)
        expect(incoming.some(p => p.type === 'scroll.ack')).toBe(true)
      }
      else {
        expect(scrolls.every(p => Object.keys(p).sort().join(',') === 'direction,lines,type')).toBe(true)
        expect(packets.some(p => p.type === 'touch.cancel')).toBe(false)
        expect(incoming.some(p => p.type === 'scroll.ack')).toBe(false)
      }
      expect((await state()).events.every(e => enabled ? e.lines === 1 : e.lines >= 1)).toBe(true)
      expect(await page.locator('#termWrap').boundingBox()).toEqual(bounds)
      await page.screenshot({ path: `.shots/terminal-touch-${enabled ? 'on' : 'off'}-${mouse ? 'mouse' : 'history'}-${info.project.name}.png` })
      // Cancelling a second gesture, then switching views, leaves no ghost grid.
      await touch(page, 'touchstart', 90)
      await touch(page, 'touchmove', 50)
      await touch(page, 'touchcancel', 50)
      if (enabled) await expect.poll(() => page.locator('.xterm-screen').evaluate(el => (el as HTMLElement).style.transform)).toBe('')
      await touch(page, 'touchstart', 60)
      await touch(page, 'touchmove', 100)
      await page.goto('/#/settings?section=terminal')
      await expect(page.locator('#termWrap')).toHaveCount(0)
      await expect(page.getByText('Smooth touch scrolling (beta)', { exact: true })).toBeVisible()
    })
  }
}

// Give each edge a fresh session so a previous momentum tail cannot mutate
// its initial fixture.
for (const edge of [0, 80]) {
  test(`the grid stays stationary at the ${edge ? 'upper' : 'lower'} edge`, { tag: '@webkit-phone' }, async ({ page, isMobile }, info) => {
    test.skip(!isMobile, 'Touch gestures use the phone viewport')
    await fakeHerdr('e2e.touch_scroll', { pane_id: pane, reset: true, mouse: edge === 80, offset: edge })
    await terminal(page, true, edge)
    const frame = await page.locator('#termWrap').boundingBox()
    const field = await page.locator('.composer').boundingBox()
    const transform = await touch(page, 'touchmove', edge ? 120 : 40, 80)
    expect(transform).toBe('')
    expect(await page.locator('#termWrap').boundingBox()).toEqual(frame)
    expect(await page.locator('.composer').boundingBox()).toEqual(field)
    await touch(page, 'touchend', edge ? 120 : 40)
    await expect.poll(() => page.locator('.xterm-screen').evaluate(el => (el as HTMLElement).style.transform)).toBe('')
    expect((await state()).offset).toBe(edge)
    expect(await page.locator('#termWrap').boundingBox()).toEqual(frame)
    expect(await page.locator('.composer').boundingBox()).toEqual(field)
    await page.screenshot({ path: `.shots/terminal-touch-edge-${edge}-${info.project.name}.png` })
  })
}

test('the beta preference follows the device default and survives a reload', { tag: '@webkit-phone' }, async ({ page }) => {
  await page.goto('/#/settings?section=terminal')
  const initial = await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)
  const row = page.locator('.settings-toggle').filter({ hasText: 'Smooth touch scrolling (beta)' })
  const toggle = row.getByRole('switch')
  await expect(toggle).toHaveAttribute('aria-checked', String(initial))
  await expect(row).toContainText('Experimental')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(!initial))
  await page.reload()
  await expect(toggle).toHaveAttribute('aria-checked', String(!initial))
})

for (const enabled of [false, true]) {
  test(`a normal terminal tap opens the keyboard with beta ${enabled ? 'on' : 'off'}`, { tag: '@webkit-phone' }, async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Touch gestures use the phone viewport')
    await fakeHerdr('e2e.touch_scroll', { pane_id: pane, reset: true, mouse: false })
    await terminal(page, enabled)
    await page.locator('#touch').tap()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
  })
}
