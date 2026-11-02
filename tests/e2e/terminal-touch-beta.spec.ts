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
    if (screen?.style.transform) {
      const clip = el.parentElement!.querySelector('#term')!.getBoundingClientRect()
      const grid = screen.getBoundingClientRect()
      const x = Math.max(clip.left, grid.left) + 5
      // Hit-test the actual overflow strip while prediction is active. This
      // fails if the grid paints outside #term even with an immobile frame.
      const y = grid.top < clip.top - 2 ? clip.top - 2 : grid.bottom > clip.bottom + 2 ? clip.bottom + 2 : null
      if (y !== null && document.elementsFromPoint(x, y).some(node => node === screen || screen.contains(node)))
        throw new Error('Predicted terminal grid escapes its clipping boundary')
      if (getComputedStyle(el.parentElement!.querySelector('#term')!).overflowY !== 'hidden')
        throw new Error('Terminal prediction requires a clipped grid')
    }
    return screen?.style.transform || ''
  }, { type, y, startY })
}

async function terminal(page: Page, enabled: boolean, offset = 0) {
  await page.addInitScript(enabled => {
    localStorage.setItem('terminalRenderer', 'html')
    if (enabled) localStorage.setItem('smoothTouchScrolling', '1')
  }, enabled)
  await page.goto(`/#/a/${pane}`)
  const tabs = page.locator('.view-toggle')
  if (await tabs.count()) await tabs.click()
  else await page.locator('button[aria-label="Terminal"]').first().click()
  await expect(page.locator('#term .xterm-rows')).toContainText(`History offset ${offset}`)
}

test.beforeEach(async () => {
  await expect.poll(async () => (await fakeHerdr('e2e.pane_size', { pane_id: pane }) as { attached: boolean }).attached).toBe(false)
})

test.afterEach(async () => {
  await fakeHerdr('e2e.touch_scroll', { pane_id: pane, clear: true })
  await fakeHerdr('e2e.interaction_screen', { pane_id: pane, text: null })
})

for (const enabled of [false, true]) {
  // Cross-product variants: TerminalTouchBeta.test.ts ('defaults to off and sends only legacy row scrolls',
  // 'predicts only the grid'); SocketWake.test.ts ('shares wake probes while preserving touch beta');
  // terminalTouchRelay.test.ts ('acks only commands preceding the frame, preserving each queued cell and epoch').
  // Plain history and mouse applications each keep a real browser/transport journey.
  test.describe(enabled ? 'mouse app' : 'plain history', () => {
    const mouse = enabled
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
      // Reload is a browser contract; preference variants live in the component test.
      if (enabled) {
        await page.reload()
        await expect(page.locator('#term .xterm-rows')).toContainText('History offset 0')
      }
      const bounds = await page.locator('#termWrap').boundingBox()
      if (enabled) await expect(page.locator('#termWrap')).toHaveClass(/smooth-touch/)
      // Inspect prediction in the gesture's own event turn, before a frame or
      // the expiry timer is allowed to retire it on a busy worker.
      const transform = await touch(page, 'touchmove', 90, 50)
      expect(await page.locator('#termWrap').boundingBox()).toEqual(bounds)
      if (enabled) expect(transform).toContain('translate3d')
      else expect(transform).toBe('')
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
  })
}

// Give each edge a fresh session so a previous momentum tail cannot mutate
// its initial fixture.
for (const edge of [0, 80]) {
  test(`beta prediction stays inside its frame at the ${edge ? 'upper' : 'lower'} edge`, { tag: '@webkit-phone' }, async ({ page, isMobile }, info) => {
    test.skip(!isMobile, 'Touch gestures use the phone viewport')
    await fakeHerdr('e2e.touch_scroll', { pane_id: pane, reset: true, mouse: edge === 80, offset: edge })
    await terminal(page, true, edge)
    const frame = await page.locator('#termWrap').boundingBox()
    const field = await page.locator('.composer').boundingBox()
    const transform = await touch(page, 'touchmove', edge ? 120 : 40, 80)
    expect(transform).toContain('translate3d')
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

// Preference default, label and persistence: tests/components/TerminalTouchPreference.test.ts,
// 'defaults to off and persists the switch across remounts'.

// Android engines keep tap-to-type; iOS WebKit does not (terminal-tap-keyboard.spec.ts).
// Beta variants: TerminalTouchBeta.test.ts, 'allows a normal tap to focus the terminal',
// 'keeps the keyboard closed for links'; terminalLinks.test.ts, 'terminal link destinations'.
test.describe('beta touch contracts', () => {
  const enabled = true
  test(`a normal terminal tap opens the keyboard on Chromium with beta ${enabled ? 'on' : 'off'}`, async ({ page, isMobile, browserName }) => {
    test.skip(!isMobile || browserName !== 'chromium', 'Touch gestures use the phone viewport; WebKit keeps the keyboard closed')
    await fakeHerdr('e2e.touch_scroll', { pane_id: pane, reset: true, mouse: false })
    await terminal(page, enabled)
    await page.locator('#touch').tap()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
  })
})

// Beta variants: TerminalTouchBeta.test.ts, 'allows a normal tap to focus the terminal',
// 'keeps the keyboard closed for links'; terminalLinks.test.ts, 'terminal link destinations'.
test.describe('beta touch contracts', () => {
  const enabled = true
  test(`a phone link back to the app keeps its window, touch beta ${enabled ? 'on' : 'off'}`, { tag: '@webkit-phone' }, async ({ page, context, isMobile, baseURL }) => {
    test.skip(!isMobile, 'Phone links open in place')
    await fakeHerdr('e2e.touch_scroll', { pane_id: pane, reset: true, mouse: true })
    await terminal(page, enabled)
    await fakeHerdr('e2e.touch_scroll', { pane_id: pane, clear: true })
    await page.evaluate(() => {
      document.documentElement.dataset.terminalLinkDocument = 'keep'
      document.documentElement.dataset.terminalLinkFocus = '0'
      document.addEventListener('focusin', event => {
        if ((event.target as Element).classList.contains('xterm-helper-textarea'))
          document.documentElement.dataset.terminalLinkFocus = '1'
      })
    })
    const url = baseURL + '/'
    await fakeHerdr('e2e.interaction_screen', { pane_id: pane, text: '\x1b]8;;' + url + '\x07Open app\x1b]8;;\x07' })
    await expect(page.locator('.xterm-rows')).toContainText('Open app')
    const pages = context.pages().length
    const box = (await page.locator('.xterm-screen').boundingBox())!
    const rows = await page.locator('.xterm-rows > *').count()
    await page.touchscreen.tap(box.x + 16, box.y + box.height / rows / 2)
    await expect(page).toHaveURL(/#\/$/)
    expect(await page.locator('html').getAttribute('data-terminal-link-document')).toBe('keep')
    expect(context.pages()).toHaveLength(pages)
    await expect(page.locator('html')).toHaveAttribute('data-terminal-link-focus', '0')
  })
})

// Beta variants: TerminalTouchBeta.test.ts, 'allows a normal tap to focus the terminal',
// 'keeps the keyboard closed for links'; terminalLinks.test.ts, 'terminal link destinations'.
test.describe('beta touch contracts', () => {
  const enabled = true
  test(`an external terminal link opens separately without the keyboard, touch beta ${enabled ? 'on' : 'off'}`, { tag: '@webkit-phone' }, async ({ page, context, isMobile }) => {
    test.skip(!isMobile, 'Touch gestures use the phone viewport')
    await context.route('https://example.org/**', route => route.fulfill({ body: 'External page' }))
    await fakeHerdr('e2e.touch_scroll', { pane_id: pane, reset: true, mouse: true })
    await terminal(page, enabled)
    await fakeHerdr('e2e.touch_scroll', { pane_id: pane, clear: true })
    await fakeHerdr('e2e.interaction_screen', { pane_id: pane, text: '\x1b]8;;https://example.org/\x07External link\x1b]8;;\x07' })
    await expect(page.locator('.xterm-rows')).toContainText('External link')
    const box = (await page.locator('.xterm-screen').boundingBox())!
    const rows = await page.locator('.xterm-rows > *').count()
    await page.evaluate(() => {
      document.documentElement.dataset.externalLinkFocus = '0'
      document.addEventListener('focusin', event => {
        if ((event.target as Element).classList.contains('xterm-helper-textarea'))
          document.documentElement.dataset.externalLinkFocus = '1'
      })
    })
    const opened = page.waitForEvent('popup')
    await page.touchscreen.tap(box.x + 16, box.y + box.height / rows / 2)
    const popup = await opened
    await expect(popup).toHaveURL('https://example.org/')
    await expect(page.locator('.xterm-helper-textarea')).not.toBeFocused()
    await expect(page.locator('html')).toHaveAttribute('data-external-link-focus', '0')
    await popup.close()
  })
})
