import { expect, test, type Page } from '@playwright/test'
import { startCore, STREAM } from './core'

// Frozen-copy journeys through the fake herdr-core socket (tests/e2e/core.ts):
// a real attach paints a neutral fixture into a real xterm, a trusted
// (Chromium CDP) or synthetic (WebKit) hold freezes it, and the spec watches
// everything the browser sends back. DATA/key/scroll must stay empty while
// the output stream and its CREDIT keep flowing.
// Native OS handles, real IME engines and iOS clipboard permissions stay
// physical-device boundaries; clipboard outcomes are mocked explicitly.

type Core = Awaited<ReturnType<typeof startCore>>

// Retained history so the herdr pane has real scrollback for the live-wheel
// positive control; the ANSI-colored/CJK paint stays on screen at the end.
const HISTORY = Array.from({ length: 60 }, (_, i) => `history line ${String(i + 1).padStart(2, '0')}`).join('\r\n') + '\r\n'
const PAINT = '\x1b[7m demo \x1b[0m \x1b[31mhost-a\x1b[0m \x1b[1;34m~/demo\x1b[0m plain tail\r\n'
  + '第二行 CJK 终端 mixed ' + 'wrap'.repeat(30) + ' end\r\n'
  + 'acme-shop build ok, ready for copy\r\n'

const tick = (page: Page, ms = 120) => page.clock.runFor(ms)

// Browser -> server /ws/term packets that count as user input. touch.cancel,
// credit, ping, visibility and terminal.resize are control traffic, not input.
const INPUT_TYPES = new Set(['terminal.input', 'keys', 'paste', 'terminal.scroll', 'terminal.mouse', 'take.control'])
const userPackets = (sent: Record<string, unknown>[]) => sent.filter(m => INPUT_TYPES.has(String(m.type)))
function watchSent(page: Page) {
  const sent: Record<string, unknown>[] = []
  page.on('websocket', (ws) => {
    if (!new URL(ws.url()).pathname.endsWith('/ws/term')) return
    ws.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') return
      try { sent.push(JSON.parse(payload)) } catch { /* keepalive bytes */ }
    })
  })
  return sent
}
const dataIn = (core: Core) => core.inbound.filter(f => f.kind === STREAM.data).map(f => f.data.toString())

async function openTerminal(page: Page, core: Core) {
  await page.addInitScript(() => {
    localStorage.setItem('terminalRenderer', 'html')
    localStorage.setItem('smoothTouchScrolling', '1')
  })
  await core.open(page)
  await page.getByRole('button', { name: /review-agent/ }).first().click()
  // Phone names the tab "Terminal"; the desktop header exposes "Show terminal"
  // (never "Show or hide terminal keys", which must stay untouched here).
  await page.getByRole('button', { name: /^(show )?terminal$/i }).first().click()
  await expect(page.locator('.xterm')).toBeVisible()
  await expect.poll(() => core.framed.filter(c => c.method === 'terminal.attach').length).toBeGreaterThan(0)
  await expectRows(page, /acme-shop/)
}

// xterm parses written frames behind a setTimeout: poll while the fake clock runs.
async function expectRows(page: Page, re: RegExp) {
  await expect.poll(async () => { await tick(page, 80); return await page.locator('.xterm-rows').textContent() }).toMatch(re)
}

// One finger on the gesture layer: a real CDP gesture on Chromium, the same
// touch-event path synthesized on WebKit (no OS-native claim there).
async function finger(page: Page, browserName: string) {
  const box = (await page.locator('#touch').boundingBox())!
  const x0 = box.x + box.width / 2
  const y0 = box.y + box.height / 2
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page)
    return {
      down: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] }),
      move: (x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }),
      up: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
    }
  }
  const fire = (type: string, x: number, y: number) => page.locator('#touch').evaluate((el, { type, x, y }) => {
    let ev: Event
    try {
      const t = new Touch({ identifier: 0, target: el, clientX: x, clientY: y })
      ev = new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t] })
    } catch {
      ev = new Event(type, { bubbles: true, cancelable: true })
      const ts = [{ clientX: x, clientY: y }]
      Object.defineProperties(ev, { touches: { value: type === 'touchend' ? [] : ts }, changedTouches: { value: ts } })
    }
    el.dispatchEvent(ev)
  }, { type, x, y })
  return { down: () => fire('touchstart', x0, y0), move: (x: number, y: number) => fire('touchmove', x, y), up: () => fire('touchend', x0, y0) }
}

async function holdCopy(page: Page, browserName: string) {
  const f = await finger(page, browserName)
  await f.down()
  await tick(page, 520)
  await expect(page.locator('.terminal-copy-layer')).toBeVisible()
  await f.up()
  return f
}

const vpBottom = (page: Page) => page.locator('.xterm-viewport')
  .evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 1)

// Real input-path scroll of the live terminal. Chromium gets a hardware wheel;
// mobile WebKit cannot wheel at all, so the same app path is driven by a touch
// drag on the gesture surface (drag up shows newer lines, like the real pane).
async function scrollLive(page: Page, browserName: string, down: boolean) {
  if (browserName === 'chromium') {
    const b = (await page.locator('#touch').boundingBox())!
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await page.mouse.wheel(0, down ? 600 : -600)
    return
  }
  const f = await finger(page, browserName)
  const b = (await page.locator('#touch').boundingBox())!
  await f.down()
  await f.move(b.x + b.width / 2, b.y + b.height / 2 + (down ? -180 : 180))
  await tick(page, 120)
  await f.up()
}
// Keep scrolling until the tail is visible again after a scroll-back.
async function restoreTail(page: Page, browserName: string) {
  for (let i = 0; i < 4 && !(await vpBottom(page)); i++) {
    await scrollLive(page, browserName, true)
    await tick(page, 120)
  }
  await expect.poll(async () => { await tick(page, 60); return vpBottom(page) }).toBe(true)
  await expectRows(page, /acme-shop/)
}

// Native Range inside the frozen layer, like a long-press text selection.
// Remembers the anchor/focus nodes so identity (not just text) survives later.
async function selectFrozen(page: Page, needle: string) {
  return page.locator('.terminal-copy-text').evaluate((el, needle) => {
    const range = document.createRange()
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode() as Text | null
    while (node && !node.textContent?.includes(needle)) node = walker.nextNode() as Text | null
    if (!node) return ''
    range.setStart(node, Math.max(0, node.textContent!.indexOf(needle)))
    range.setEnd(node, node.textContent!.indexOf(needle) + needle.length)
    const sel = getSelection()!
    sel.removeAllRanges(); sel.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    const w = window as { __selAnchor?: Node; __selFocus?: Node }
    w.__selAnchor = sel.anchorNode!; w.__selFocus = sel.focusNode!
    return sel.toString()
  }, needle)
}
const selectionIntact = (page: Page, text: string) => page.evaluate((text) => {
  const sel = getSelection()!
  const w = window as { __selAnchor?: Node; __selFocus?: Node }
  return sel.toString() === text && sel.anchorNode === w.__selAnchor && sel.focusNode === w.__selFocus
}, text)

test('hold freezes one screen, gates focus-report and input, keeps CREDIT and exits cleanly', async ({ page, browserName }, testInfo) => {
  const core = await startCore(() => undefined, undefined, { firstPaint: HISTORY + PAINT })
  const sent = watchSent(page)
  try {
    await page.clock.install()
    await openTerminal(page, core)
    // DECSET 1004 enables xterm's focus reporting: the manual focus->blur pair
    // is the positive control proving the ESC[I/ESC[O path reaches the wire.
    // Counts are deltas — attach traffic can legitimately report state too.
    core.output('\x1b[?1004h')
    await tick(page)
    const ta = page.locator('.xterm-helper-textarea')
    const count = (s: string) => dataIn(core).filter(d => d === s).length
    const i0 = count('\x1b[I'), o0 = count('\x1b[O')
    await ta.focus()
    await expect.poll(() => count('\x1b[I')).toBeGreaterThan(i0)
    await ta.blur()
    await expect.poll(() => count('\x1b[O')).toBeGreaterThan(o0)
    // Keybar and composer visible before entry, inert while copying.
    await page.getByRole('button', { name: 'Show or hide terminal keys', exact: true }).click()
    await expect(page.locator('.keybar')).toBeVisible()
    // An active composition kills the hold without entering copy.
    await ta.dispatchEvent('compositionstart')
    const early = await finger(page, browserName)
    await early.down()
    await tick(page, 600)
    await expect(page.locator('.terminal-copy-layer')).toHaveCount(0)
    await early.up()
    // The cancelled composition emits no data; after xterm's deferred
    // finalization settles, the very next hold copies — before any commit.
    await ta.dispatchEvent('compositionend')
    await tick(page)
    await holdCopy(page, browserName)
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.locator('.terminal-copy-layer')).toHaveCount(0)
    // An empty compositionend.data with a real textarea commit sends the exact
    // text once — the first-data guard stays alive through all of this.
    await ta.dispatchEvent('compositionstart')
    await ta.evaluate((el: HTMLTextAreaElement) => { el.value = '好' })
    await ta.dispatchEvent('compositionend')
    await tick(page)
    await expect.poll(() => dataIn(core).filter(d => d === '好').length).toBe(1)
    // Live-scroll positive control: the pane has retained history (HISTORY
    // lines above the paint), so scrolling back moves the local xterm
    // viewport — painted movement, not a wire packet.
    const vp = page.locator('.xterm-viewport')
    const firstRow = () => page.locator('.xterm-rows').evaluate(el => (el.firstElementChild as HTMLElement | null)?.innerText || '')
    const v0 = await vp.evaluate(el => el.scrollTop)
    const row0 = await firstRow()
    await scrollLive(page, browserName, false)
    await expect.poll(async () => { await tick(page, 60); return vp.evaluate(el => el.scrollTop) }).toBeLessThan(v0)
    expect(await firstRow()).not.toBe(row0)
    // Restore the tail before freezing: the snapshot must hold the painted tail.
    await restoreTail(page, browserName)
    // Refocus the textarea: the entry blur is now a real blur that would emit
    // ESC[O if the input gate were not already closed.
    const i1 = count('\x1b[I')
    await ta.focus()
    await expect.poll(() => count('\x1b[I')).toBeGreaterThan(i1)
    sent.length = 0
    core.inbound.length = 0
    // Enter copy with a focused, focus-reporting terminal.
    await holdCopy(page, browserName)
    const text = page.locator('.terminal-copy-text')
    const frozen = await text.textContent()
    expect(frozen).toContain('第二行')
    expect(frozen).toContain('acme-shop')
    // The wrapped run is joined back in the frozen text.
    expect(frozen).toContain('wrap'.repeat(30))
    // Styled spans carried over (red host-a), never as HTML.
    await expect(page.locator('.terminal-copy-text span[style*="color"]')).not.toHaveCount(0)
    await expect(page.locator('.composer')).toHaveAttribute('inert', '')
    await expect(page.locator('.keybar')).toHaveAttribute('inert', '')
    await expect(page.locator('.phone-keybar-controls')).toHaveAttribute('inert', '')
    for (const box of await page.locator('.terminal-copy-tools button').evaluateAll(els => els.map(el => el.getBoundingClientRect())))
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44)
    // Native Range over the frozen text: keep the node identity, not just text.
    const selected = await selectFrozen(page, '第二行')
    expect(selected).toBe('第二行')
    await page.screenshot({ path: testInfo.outputPath(`03-copy-${browserName}-phone.png`) })
    // Live output and a resize keep flowing into the live terminal underneath.
    core.output('post-freeze live line\r\n')
    await page.setViewportSize({ width: 360, height: 480 })
    await expectRows(page, /post-freeze live line/)
    // Frozen text and the selection — nodes and string — survive untouched.
    expect(await text.textContent()).toBe(frozen)
    expect(await selectionIntact(page, selected)).toBe(true)
    // The frozen pre now overflows the shrunken layer: a real wheel inside the
    // snapshot natively scrolls THAT box, while the live xterm viewport —
    // the actual scrollbar position — does not move at all. Mobile WebKit has
    // no wheel, so there the JS routing is exercised and the box's native
    // scrollability is shown directly (native pan is a device check).
    const scrollBox = page.locator('.terminal-copy-scroll')
    expect(await scrollBox.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0)
    const s0 = await scrollBox.evaluate(el => el.scrollTop)
    const v1 = await vp.evaluate(el => el.scrollTop)
    const liveRow = await firstRow()
    if (browserName === 'chromium') {
      const layerBox = (await page.locator('.terminal-copy-layer').boundingBox())!
      await page.mouse.move(layerBox.x + layerBox.width / 2, layerBox.y + layerBox.height / 2)
      await page.mouse.wheel(0, 240)
      await page.waitForFunction(s0 => (document.querySelector('.terminal-copy-scroll') as HTMLElement).scrollTop > s0, s0)
    } else {
      await scrollBox.dispatchEvent('wheel', { deltaY: 240, deltaMode: 0 })
      await scrollBox.evaluate(el => { el.scrollTop = 120 })
    }
    expect(await scrollBox.evaluate(el => el.scrollTop)).toBeGreaterThan(s0)
    expect(await vp.evaluate(el => el.scrollTop)).toBe(v1)
    expect(await firstRow()).toBe(liveRow)
    // CREDIT keeps flowing back for the new frames; no user input escaped and
    // the gated blur never emitted ESC[O.
    expect(core.inbound.filter(x => x.kind === STREAM.credit).length).toBeGreaterThan(0)
    expect(userPackets(sent)).toEqual([])
    expect(dataIn(core)).toEqual([])
    expect(core.framed.filter(c => c.method === 'terminal.keys')).toEqual([])
    // Scoped Copy writes only the selection (clipboard mocked explicitly).
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => { (window as { __copied?: string }).__copied = s } } })
    })
    await page.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
    expect(await page.evaluate(() => (window as { __copied?: string }).__copied)).toBe(selected)
    // Done exits without refocusing the terminal or sending a key.
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.locator('.terminal-copy-layer')).toHaveCount(0)
    await expect(ta).not.toBeFocused()
    await expect(page.locator('.keybar')).not.toHaveAttribute('inert')
    expect(userPackets(sent)).toEqual([])
    expect(dataIn(core)).toEqual([])
  } finally {
    await core.stop()
  }
})

test('copy refusal keeps the native selection, system Copy yields frozen text, a drag never enters', async ({ page, browserName }) => {
  const core = await startCore(() => undefined, undefined, { firstPaint: HISTORY + PAINT })
  const sent = watchSent(page)
  try {
    await page.clock.install()
    await openTerminal(page, core)
    // A trusted (or synthesized) drag past the slop never opens copy and its
    // release does not focus the terminal either.
    const drag = await finger(page, browserName)
    await drag.down()
    for (let i = 1; i <= 4; i++) await drag.move(80 + i * 24, 300 + i * 18)
    await tick(page, 600)
    await drag.up()
    await tick(page)
    await expect(page.locator('.terminal-copy-layer')).toHaveCount(0)
    await expect(page.locator('.xterm-helper-textarea')).not.toBeFocused()
    // The drag legitimately scrolled the live viewport back into HISTORY;
    // restore the tail so the snapshot holds the painted lines.
    await restoreTail(page, browserName)
    // Enter copy, then refuse both clipboard paths.
    await holdCopy(page, browserName)
    const text = page.locator('.terminal-copy-text')
    const frozen = (await text.textContent())!
    const selected = await selectFrozen(page, 'acme-shop')
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied') } } })
      ;(document as { execCommand?: (c: string) => boolean }).execCommand = () => false
    })
    await page.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Copy failed')
    // The selection survives the refusal: the system Copy menu stays usable
    // and yields only the frozen layer's text — never the live grid.
    expect(await selectionIntact(page, selected)).toBe(true)
    const viaCopyEvent = await page.evaluate(() => {
      const clipboardData = new DataTransfer()
      document.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }))
      return clipboardData.getData('text/plain')
    })
    expect(viaCopyEvent).toContain(selected)
    // Whole-page Select all still yields only the frozen document.
    const wholePage = await page.evaluate(() => {
      getSelection()!.selectAllChildren(document.body)
      document.dispatchEvent(new Event('selectionchange'))
      const clipboardData = new DataTransfer()
      document.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }))
      return clipboardData.getData('text/plain')
    })
    // The scoped text is trimmed (trimSelection); the raw pre textContent keeps
    // the trailing empty rows, so compare the meaningful text.
    expect(wholePage.trim()).toBe(frozen.trim())
    // Escape exits the layer: it is not a Stop key and focuses nothing.
    sent.length = 0
    await page.keyboard.press('Escape')
    await expect(page.locator('.terminal-copy-layer')).toHaveCount(0)
    await expect(page.locator('.xterm-helper-textarea')).not.toBeFocused()
    expect(userPackets(sent)).toEqual([])
    expect(core.framed.filter(c => c.method === 'terminal.keys')).toEqual([])
    // Leaving the pane while a second copy session is open tears it down.
    await holdCopy(page, browserName)
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page.locator('.terminal-copy-layer')).toHaveCount(0)
  } finally {
    await core.stop()
  }
})

test('the 1440x900 surface keeps native xterm selection and shows no copy layer', async ({ browser }, testInfo) => {
  // newContext inherits the phone project's hasTouch: opt out, or the coarse
  // pointer media query keeps #touch interactive and the mouse never reaches xterm.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false })
  const page = await context.newPage()
  const core = await startCore(() => undefined, undefined, { firstPaint: HISTORY + PAINT })
  try {
    await page.clock.install()
    await openTerminal(page, core)
    // A mouse never belongs to the touch layer: selection reaches xterm.
    expect(await page.locator('#touch').evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none')
    // Drag across a row that actually carries text (rows right of the short
    // history lines are blank cells, which must not be the selection proof).
    const box = (await page.locator('.xterm-rows div', { hasText: 'acme-shop' }).first().boundingBox())!
    const cy = box.y + box.height / 2
    await page.mouse.move(box.x + 1, cy)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 4, cy, { steps: 5 })
    await page.mouse.up()
    // The press reached xterm (it focuses its textarea); the fake clock also
    // gates requestAnimationFrame, so let the selection paint.
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    await expect.poll(async () => { await tick(page, 60); return page.locator('.xterm-selection div').count() }).toBeGreaterThan(0)
    // The xterm copy event proves the selection holds real, non-blank text.
    const copied = await page.locator('.xterm').evaluate(el => {
      const clipboardData = new DataTransfer()
      el.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }))
      return clipboardData.getData('text/plain')
    })
    expect(copied).toContain('acme-shop')
    await expect(page.locator('.terminal-copy-layer')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('03-copy-desktop.png') })
  } finally {
    await context.close()
    await core.stop()
  }
})
