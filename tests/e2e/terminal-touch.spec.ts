import { expect, test, type Page } from '@playwright/test'
import { startCore, STREAM, type Call } from './core'

// Local-scroll journeys through the fake herdr-core socket (tests/e2e/core.ts):
// the attach delivers retained history ("Scrollback lines to show first (main
// screen only)", v0.1.17 schema), a trusted (Chromium CDP) or synthetic
// (WebKit) finger drags through it inside xterm's own buffer, and the spec
// watches everything the browser sends back. Scrolling must move only the
// local viewport: no DATA, no terminal.scroll, no input and no lease traffic —
// a programmatic blur under DECSET1004 must not let xterm's ESC[O reach the
// wire either. Keyboard dismissal shares the same swallowed blur() path; the
// drag and the off-cursor tap cover it here.

type Core = Awaited<ReturnType<typeof startCore>>

// What a real attach looks like on the stream: retained history lines first,
// then a full-screen repaint. Lines written each with a trailing \r\n scroll
// once per line past `rows - 1`, so `ABOVE + rows - 1` written lines push
// exactly ABOVE rows into scrollback; ED2+home then repaints the visible
// screen in place. firstPaint receives the attach call, so the paint is sized
// to the very rows the client requested.
const ABOVE = 60
const firstPaint = (attach: Call) => {
  const rows = Number(attach.params?.rows) || 24
  const push = Array.from({ length: ABOVE + rows - 1 }, (_, i) => `history line ${String(i + 1).padStart(3, '0')}`).join('\r\n') + '\r\n'
  const screen = Array.from({ length: rows - 1 }, (_, i) => `acme-shop screen row ${String(i + 1).padStart(2, '0')}`).join('\r\n') + '\r\nscreen ready'
  return push + '\x1b[2J\x1b[H' + screen
}

const tick = (page: Page, ms = 120) => page.clock.runFor(ms)

// Browser -> server /ws/term packets: nothing a scroll may legitimately send.
const SILENT_TYPES = new Set(['terminal.input', 'keys', 'paste', 'terminal.scroll', 'terminal.mouse', 'take.control', 'terminal.resize', 'scroll.ack', 'touch.cancel'])
const silentPackets = (sent: Record<string, unknown>[]) => sent.filter(m => SILENT_TYPES.has(String(m.type)))
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
// DATA frames are the only wire effect a scroll could wrongly produce; credit
// and resize frames are unrelated and must not dilute the baseline.
const dataIn = (core: Core) => core.inbound.filter(f => f.kind === STREAM.data).map(f => f.data.toString())

async function openTerminal(page: Page, core: Core, paint: RegExp = /acme-shop/) {
  await page.addInitScript(() => {
    localStorage.setItem('terminalRenderer', 'html')
    localStorage.setItem('smoothTouchScrolling', '1')
  })
  await core.open(page)
  await page.getByRole('button', { name: /review-agent/ }).first().click()
  await page.getByRole('button', { name: /^(show )?terminal$/i }).first().click()
  await expect(page.locator('.xterm')).toBeVisible()
  await expect.poll(() => core.framed.filter(c => c.method === 'terminal.attach').length).toBeGreaterThan(0)
  await expectRows(page, paint)
}

// xterm parses written frames behind a setTimeout: poll while the fake clock runs.
async function expectRows(page: Page, re: RegExp) {
  await expect.poll(async () => { await tick(page, 80); return await page.locator('.xterm-rows').textContent() }).toMatch(re)
}

// Delivered history, measured inside xterm's own viewport: the scrollable
// pixels above the live screen, in rows. This is what the attach actually
// delivered — distinct from the 1000 the attach requested.
const rowPx = (page: Page) => page.locator('.xterm-rows > div').first().evaluate(el => el.getBoundingClientRect().height || 1)
async function scrollbackRows(page: Page) {
  const vp = page.locator('.xterm-viewport')
  const rowH = await rowPx(page)
  return Math.round(await vp.evaluate(el => el.scrollHeight - el.clientHeight) / rowH)
}
const viewportY = async (page: Page) => Math.round(await page.locator('.xterm-viewport').evaluate(el => el.scrollTop) / await rowPx(page))
const firstRow = (page: Page) => page.locator('.xterm-rows').evaluate(el => (el.firstElementChild as HTMLElement | null)?.innerText || '')

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

// The attach asks core for the same retained history on every screen variant:
// the requested amount (source contract: coreTerm.ts HISTORY = 1000).
function expectAttachHistory(core: Core) {
  const attach = core.framed.find(c => c.method === 'terminal.attach')
  expect(attach?.params?.history).toBe(1000)
  expect(Number.isInteger(attach?.params?.cols)).toBe(true)
  expect(Number.isInteger(attach?.params?.rows)).toBe(true)
}
// Both inventory and subscription must carry the fixture's screen variant.
// served also records the one-shot events.subscribe answered with discover —
// the framed subscription result is the one carrying a terminals snapshot.
function expectServedScreen(core: Core, screen: string) {
  const list = core.served.find(s => s.method === 'terminal.list')
  const sub = core.served.find(s => s.method === 'events.subscribe' && Array.isArray((s.result as { terminals?: unknown[] })?.terminals))
  expect((list?.result as { terminals?: { screen?: string }[] })?.terminals?.[0]?.screen).toBe(screen)
  expect((sub?.result as { terminals?: { screen?: string }[] })?.terminals?.[0]?.screen).toBe(screen)
}

test('attach delivers history, a drag scrolls it locally and emits no input, focus-report or lease traffic', async ({ page, browserName }, testInfo) => {
  const core = await startCore(() => undefined, undefined, { firstPaint })
  const sent = watchSent(page)
  try {
    await page.clock.install()
    await openTerminal(page, core)
    expectAttachHistory(core)
    expectServedScreen(core, 'exact')
    // The attach requested 1000 lines; the core retained 60 above the screen.
    // The delivered bound is measured in the viewport, not assumed.
    expect(await scrollbackRows(page)).toBe(ABOVE)
    expect(await viewportY(page)).toBe(ABOVE)
    // DECSET1004 turns on xterm focus reporting: a real ESC[I first proves
    // the report path reaches the wire (intentional focus is input intent).
    // Enabling the mode itself reports the current state once — that report
    // is protocol traffic, so counters are frozen only after it settles.
    core.output('\x1b[?1004h')
    await tick(page)
    const ta = page.locator('.xterm-helper-textarea')
    const count = (s: string) => dataIn(core).filter(d => d === s).length
    await ta.focus()
    await expect.poll(() => count('\x1b[I')).toBe(1)
    const o0 = count('\x1b[O')

    // Drag down into the attach's history: the local viewport moves, the
    // passive blurs along the way emit nothing.
    sent.length = 0
    let d0 = dataIn(core).length
    const v0 = await viewportY(page)
    const f = await finger(page, browserName)
    const box = (await page.locator('#touch').boundingBox())!
    const x = box.x + box.width / 2
    await f.down()
    for (let i = 1; i <= 4; i++) { await f.move(x, box.y + box.height / 2 + i * 60); await tick(page, 40) }
    await f.up()
    await expect.poll(async () => { await tick(page, 60); return viewportY(page) }).toBeLessThan(v0)
    await expectRows(page, /history line/)
    expect(dataIn(core).length).toBe(d0)
    expect(silentPackets(sent)).toEqual([])
    expect(count('\x1b[O')).toBe(o0)

    // Fresh intentional proof, then a new baseline: the second ESC[I is
    // legitimate user input and must not be confused with passive traffic.
    await ta.focus()
    await expect.poll(() => count('\x1b[I')).toBe(2)
    sent.length = 0
    d0 = dataIn(core).length
    // A tap off the cursor row only blurs — and even that programmatic blur
    // stays silent under DECSET1004.
    await f.down()
    await f.up()
    await tick(page, 80)
    expect(dataIn(core).length).toBe(d0)
    expect(silentPackets(sent)).toEqual([])
    expect(count('\x1b[O')).toBe(o0)
    await expect(ta).not.toBeFocused()

    // The delivered block's top is the oldest retained line. xterm renders the
    // new scrollTop on a later frame — drive the clock until it settles.
    await page.locator('.xterm-viewport').evaluate(el => { el.scrollTop = 0 })
    await expect.poll(async () => { await tick(page, 40); return firstRow(page) }).toMatch(/history line 001/)
    await page.screenshot({ path: testInfo.outputPath(`05-scroll-${testInfo.project.name}.png`) })

    // Input itself is untouched: an IME commit still lands exactly once and
    // an intentional refocus reports ESC[I again.
    await ta.focus()
    await expect.poll(() => count('\x1b[I')).toBe(3)
    await ta.dispatchEvent('compositionstart')
    await ta.evaluate((el: HTMLTextAreaElement) => { el.value = '好' })
    await ta.dispatchEvent('compositionend')
    await tick(page)
    await expect.poll(() => dataIn(core).filter(d => d === '好').length).toBe(1)
  } finally {
    await core.stop()
  }
})

test('an inexact screen requests the same attach history and scrolls identically', async ({ page, browserName }) => {
  // screen:'inexact' marks a terminal whose older history may be missing
  // (v0.1.17 schema): the viewer still asks for 1000 lines and scrolls what
  // the attach delivered — identically to an exact screen.
  const core = await startCore(() => undefined, undefined, { firstPaint, terminal: { screen: 'inexact' } })
  const sent = watchSent(page)
  try {
    await page.clock.install()
    await openTerminal(page, core)
    expectAttachHistory(core)
    expectServedScreen(core, 'inexact')
    expect(await scrollbackRows(page)).toBe(ABOVE)
    sent.length = 0
    const d0 = dataIn(core).length
    const v0 = await viewportY(page)
    const f = await finger(page, browserName)
    const box = (await page.locator('#touch').boundingBox())!
    const x = box.x + box.width / 2
    await f.down()
    for (let i = 1; i <= 4; i++) { await f.move(x, box.y + box.height / 2 + i * 60); await tick(page, 40) }
    await f.up()
    await expect.poll(async () => { await tick(page, 60); return viewportY(page) }).toBeLessThan(v0)
    await expectRows(page, /history line/)
    expect(dataIn(core).length).toBe(d0)
    expect(silentPackets(sent)).toEqual([])
  } finally {
    await core.stop()
  }
})

test('an attach to an already-alternate screen requests history and gets none', async ({ page, browserName }) => {
  // The schema scopes attach history to the main screen: a fresh attach to an
  // app already on its alternate buffer delivers no scrollback at all. The
  // request is still 1000 — the attach call has no alt_screen branch — the
  // drag has nothing to scroll and stays silent.
  const core = await startCore(() => undefined, undefined, {
    firstPaint: (attach: Call) => {
      const rows = Number(attach.params?.rows) || 24
      const screen = Array.from({ length: rows - 1 }, (_, i) => `alt screen row ${String(i + 1).padStart(2, '0')}`).join('\r\n') + '\r\nalt app ready'
      return '\x1b[?1049h' + screen
    },
  })
  const sent = watchSent(page)
  try {
    await page.clock.install()
    await openTerminal(page, core, /alt screen row/)
    expectAttachHistory(core)
    expect(await scrollbackRows(page)).toBe(0)
    sent.length = 0
    const d0 = dataIn(core).length
    const f = await finger(page, browserName)
    const box = (await page.locator('#touch').boundingBox())!
    const x = box.x + box.width / 2
    await f.down()
    for (let i = 1; i <= 4; i++) { await f.move(x, box.y + box.height / 2 + i * 60); await tick(page, 40) }
    await f.up()
    await tick(page, 300)
    expect(await scrollbackRows(page)).toBe(0)
    await expectRows(page, /alt screen row|alt app ready/)
    expect(dataIn(core).length).toBe(d0)
    expect(silentPackets(sent)).toEqual([])
  } finally {
    await core.stop()
  }
})

test('a full-screen app that takes the mouse gets a drag as its wheel', async ({ page, browserName }) => {
  // Same alternate screen as above, but the app asked for SGR mouse reports:
  // its history is its own, so the drag has to reach it.
  const core = await startCore(() => undefined, undefined, {
    firstPaint: (attach: Call) => {
      const rows = Number(attach.params?.rows) || 24
      const screen = Array.from({ length: rows - 1 }, (_, i) => `alt screen row ${String(i + 1).padStart(2, '0')}`).join('\r\n') + '\r\nalt app ready'
      return '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h' + screen
    },
  })
  try {
    await page.clock.install()
    await openTerminal(page, core, /alt screen row/)
    const d0 = dataIn(core).length
    const f = await finger(page, browserName)
    const box = (await page.locator('#touch').boundingBox())!
    const x = box.x + box.width / 2
    await f.down()
    for (let i = 1; i <= 4; i++) { await f.move(x, box.y + box.height / 2 + i * 60); await tick(page, 40) }
    await f.up()
    await tick(page, 300)
    // A finger moving down looks back: wheel up, and nothing else on the wire.
    await expect.poll(() => dataIn(core).slice(d0).join('')).toMatch(/^(\x1b\[<64;\d+;\d+M)+$/)
  } finally {
    await core.stop()
  }
})

test('a watching viewer pans a wide grid horizontally without giving up the follow transform or the size lease', async ({ page, browserName }, testInfo) => {
  // Another viewer owns this terminal's size: the size event flips this
  // client into watching mode (terminal.control off), followCursor's
  // translateY keeps the cursor row on screen, and the wider-than-viewport
  // grid pans horizontally on the gesture layer. No DATA, no take.control,
  // no RESIZE frame — the observe lease holds through the whole pan.
  const core = await startCore(() => undefined, undefined, { firstPaint })
  const sent = watchSent(page)
  try {
    await page.clock.install()
    await openTerminal(page, core)
    const xterm = page.locator('.xterm')
    const screen = page.locator('.xterm-screen')
    // A narrow fake size event: another viewer resized the terminal wider
    // and taller than this screen. The server follows it and stops imposing.
    core.event('{"method":"event","params":{"type":"size","data":{"cols":200,"rows":60}}}\n')
    await tick(page)
    const rows60 = Array.from({ length: 60 }, (_, i) => `watcher row ${String(i + 1).padStart(2, '0')}`).join('\r\n')
    core.output(rows60 + '\r\nwatcher cursor line')
    await expectRows(page, /watcher cursor line/)
    // Watching mode evidence: the screen is translated so the cursor row
    // stays visible — and the grid overflows horizontally.
    await expect.poll(async () => (await screen.getAttribute('style')) || '').toContain('translateY(-')
    await expect.poll(async () => xterm.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
    sent.length = 0
    const d0 = dataIn(core).length
    const resizeFrames = () => core.inbound.filter(f => f.kind === STREAM.resize).length
    const r0 = resizeFrames()
    const left0 = await xterm.evaluate(el => el.scrollLeft)
    const transform = (await screen.getAttribute('style')) || ''
    const f = await finger(page, browserName)
    const box = (await page.locator('#touch').boundingBox())!
    const y = box.y + box.height / 2
    await f.down()
    for (let i = 1; i <= 4; i++) { await f.move(box.x + box.width / 2 - i * 30, y); await tick(page, 40) }
    await f.up()
    await tick(page, 200)
    // The pan moved the horizontal scroll position; the watcher transform
    // and the lease survived it untouched.
    expect(await xterm.evaluate(el => el.scrollLeft)).toBeGreaterThan(left0)
    expect((await screen.getAttribute('style')) || '').toBe(transform)
    expect(dataIn(core).length).toBe(d0)
    expect(resizeFrames()).toBe(r0)
    expect(silentPackets(sent)).toEqual([])

    // Vertical boundary: the cursor row sits fully inside the clipped host
    // while live (the follow translation's job), and scrolling to viewportY 0
    // must put the oldest retained row fully inside it too — rendered text
    // alone says nothing, only its rect against the host clip does. #term is
    // the clipped host box (.xterm itself can be as tall as the 60-row grid).
    const termBox = (await page.locator('#term').boundingBox())!
    const wrapBox = (await page.locator('#termWrap').boundingBox())!
    const clip = { top: Math.max(termBox.y, wrapBox.y), bottom: Math.min(termBox.y + termBox.height, wrapBox.y + wrapBox.height) }
    const rowAt = async (re: RegExp) => {
      const row = page.locator('.xterm-rows > div').filter({ hasText: re }).first()
      return await row.boundingBox()
    }
    const inside = (b: { y: number, height: number } | null) => Boolean(b && b.y >= clip.top - 2 && b.y + b.height <= clip.bottom + 2)
    expect(inside(await rowAt(/watcher cursor line/))).toBe(true)

    // The native scrollbar path (not just ctl.scroll) must refresh the
    // transform as the viewport moves: scrollTop 0 reaches the oldest row.
    // scrollLeft goes home first so the line reads in the screenshot.
    await xterm.evaluate(el => { el.scrollLeft = 0 })
    await page.locator('.xterm-viewport').evaluate(el => { el.scrollTop = 0 })
    await expect.poll(async () => { await tick(page, 40); return firstRow(page) }).toMatch(/history line 0/)
    const oldest = firstRow(page)
    await page.screenshot({ path: testInfo.outputPath(`05-watch-${testInfo.project.name}.png`) })
    expect(inside(await rowAt(new RegExp(await oldest)))).toBe(true)

    // Output and a resize repaint while viewing history must neither re-clip
    // it nor seize the lease. The cols jump widens the grid: scrollWidth
    // growing proves the resize actually landed before the clip check.
    const w0 = await xterm.evaluate(el => el.scrollWidth)
    core.output('\r\nwatcher extra line')
    core.event('{"method":"event","params":{"type":"size","data":{"cols":220,"rows":60}}}\n')
    await expect.poll(async () => { await tick(page, 40); return xterm.evaluate(el => el.scrollWidth) }).toBeGreaterThan(w0)
    expect(inside(await rowAt(new RegExp(await oldest)))).toBe(true)
    expect(resizeFrames()).toBe(r0)
    expect(silentPackets(sent)).toEqual([])

    // Back at the live bottom the cursor follow translation returns.
    await page.locator('.xterm-viewport').evaluate(el => { el.scrollTop = el.scrollHeight })
    await expect.poll(async () => (await screen.getAttribute('style')) || '').toContain('translateY(-')
    await expectRows(page, /watcher extra line/)
    expect(inside(await rowAt(/watcher extra line|watcher cursor line/))).toBe(true)

    // Short history: erase the scrollback and repaint so exactly one row sits
    // above the 60-row grid — 61 lines with 60 newlines, baseY 1. Buffer row
    // b carries `watcher line b+1`, so the window top is the row index of the
    // first line inside the clip. A one-line delta through the app's own
    // wheel accumulator must move it exactly one row — buffer row 30, between
    // the viewport's domain and the lifted grid, used to be skipped entirely.
    const short = Array.from({ length: 60 }, (_, i) => `watcher line ${String(i + 1).padStart(2, '0')}`).join('\r\n')
    core.output('\x1b[3J\x1b[2J\x1b[H' + short + '\r\nwatcher tail line')
    await expectRows(page, /watcher tail line/)
    await expect.poll(async () => (await screen.getAttribute('style')) || '').toContain('translateY(-')
    await expect.poll(async () => { await tick(page, 40); return scrollbackRows(page) }).toBe(1)
    // The topmost buffer row whose rect lands inside the host clip: the first
    // rendered row whose bottom edge made it past the top boundary.
    const topIndex = async () => {
      const text = await xterm.evaluate((el, top) => {
        const rows = el.querySelector('.xterm-rows')
        if (!rows) return ''
        for (const d of Array.from(rows.children) as HTMLElement[]) {
          if (d.getBoundingClientRect().bottom > top + 1) return d.textContent || ''
        }
        return ''
      }, clip.top)
      const m = /watcher line (\d+)/.exec(text)
      return m ? Number(m[1]) - 1 : -1
    }
    const rowH = await rowPx(page)
    // The lifted domain exists whenever the clip shows under ~32 rows —
    // measure it rather than assume it (Chromium ~30, WebKit ~31.4).
    const hostRows = (clip.bottom - clip.top) / rowH
    expect(hostRows).toBeGreaterThan(28)
    expect(hostRows).toBeLessThan(32)
    // A row-sized synthetic wheel delta through the app's accumulator — the
    // same scroll() path touch drags use (page.mouse.wheel is not portable
    // to WebKit). ceil(rowH) always converts to exactly one line.
    const wheel = async (rows: number) => {
      await page.locator('#termWrap').dispatchEvent('wheel', { deltaY: rows * Math.ceil(rowH), deltaMode: 0, bubbles: true, cancelable: true })
      await tick(page, 40)
    }
    // Up one line per event: every attempt must move the top exactly one row
    // (a stall or a jump is a defect), until the oldest row clamps it. Buffer
    // row 30 is the row the old cap skipped — it sits in the lifted zone only
    // on clips short enough to pin above it, so require it when it does.
    const tops: number[] = [await topIndex()]
    expect(tops[0]).toBeGreaterThanOrEqual(28)
    for (let i = 0; i < 40 && tops.at(-1) !== 0; i++) { await wheel(-1); tops.push(await topIndex()) }
    await wheel(-1); tops.push(await topIndex())
    await wheel(-1); tops.push(await topIndex())
    for (let i = 1; i < tops.length; i++) expect(tops[i]).toBe(tops[i - 1]! === 0 ? 0 : tops[i - 1]! - 1)
    if (tops[0]! >= 30) expect(tops).toContain(30)
    expect(tops.at(-1)).toBe(0)
    expect(silentPackets(sent)).toEqual([])
    expect(dataIn(core).length).toBe(d0)
    expect(resizeFrames()).toBe(r0)

    // Back down to the middle of the lifted region — the viewport sits at
    // its bottom edge while the transform carries the window — and parked
    // there while a line of output lands, the reading row must hold: it is
    // a buffer coordinate, not a bottom-edge pin.
    for (let i = 0; i < 40 && (await topIndex()) < 15; i++) await wheel(1)
    const parked = await topIndex()
    expect(parked).toBe(15)
    expect(await viewportY(page)).toBe(1)
    expect((await screen.getAttribute('style')) || '').toContain('translateY(-')
    core.output('\r\nwatcher extra 2')
    await expectRows(page, /watcher extra 2/)
    expect(await topIndex()).toBe(parked)
    await page.screenshot({ path: testInfo.outputPath(`05-watch-short-${testInfo.project.name}.png`) })
    expect(silentPackets(sent)).toEqual([])
    expect(dataIn(core).length).toBe(d0)
    expect(resizeFrames()).toBe(r0)

    // Continuing down: one row per attempt to the live tail, whose bottom
    // rows come back inside the clip on the cursor's own pin.
    const tailIdx = Math.floor(2 + 60 - hostRows)
    const downs: number[] = [await topIndex()]
    for (let i = 0; i < 40 && downs.at(-1) !== tailIdx; i++) { await wheel(1); downs.push(await topIndex()) }
    for (let i = 1; i < downs.length; i++) expect(downs[i]).toBe(downs[i - 1]! === tailIdx ? tailIdx : downs[i - 1]! + 1)
    expect(downs.at(-1)).toBe(tailIdx)
    // The downs walk stops at floor(tail): a fractional live tail can sit a
    // row lower. Wheel the remainder so the pin is exact — the newest cursor
    // row must sit inside the clip before the fill begins.
    await wheel(2)
    expect(inside(await rowAt(/watcher extra 2|watcher tail line/))).toBe(true)
    expect(silentPackets(sent)).toEqual([])

    // Fractional history park: the live tail carries hostRows' fraction, so
    // wheeling floor(tail) rows up leaves the window top part-way down the
    // oldest row (view 0.x — native viewport 0 plus a sub-row transform
    // lift). Base-only output must not snap that to the integer viewport
    // edge; the parked row's rect is the honest measure. The new line lands
    // below the rendered window, so scrollback growth — not row text — is
    // the parse-completion signal.
    await wheel(-Math.floor(2 + 60 - hostRows))
    expect(await viewportY(page)).toBe(0)
    const fracLift = Number(/translateY\(-([\d.]+)px\)/.exec((await screen.getAttribute('style')) || '')?.[1] ?? -1)
    expect(fracLift).toBeGreaterThan(0)
    expect(fracLift).toBeLessThan(await rowPx(page))
    const fracRow = page.locator('.xterm-rows > div').first()
    const fracBox = (await fracRow.boundingBox())!
    core.output('\r\nwatcher extra 3')
    await expect.poll(async () => { await tick(page, 40); return scrollbackRows(page) }).toBe(3)
    const fracBox2 = (await page.locator('.xterm-rows > div').first().boundingBox())!
    expect(fracBox2.y).toBeCloseTo(fracBox.y, 0)
    expect(silentPackets(sent)).toEqual([])
    // Back to the live pin for the fill.
    await wheel(Math.floor(2 + 60 - hostRows) + 4)
    expect(inside(await rowAt(/watcher extra 3|watcher extra 2|watcher tail line/))).toBe(true)

    // Full scrollback: one burst pushes past the 5000-row cap so every later
    // newline trims the oldest row while baseY/viewportY stay pinned. A row
    // parked in the lifted region must keep its text AND its rect — the old
    // numeric view drifted one row per trim. One bounded payload, not a loop.
    // The ~76KB burst parses through many WriteBuffer slices — each yield
    // needs a poll round-trip — so this wait gets a longer window.
    const fill = Array.from({ length: 5060 }, (_, i) => `fill line ${String(i + 1).padStart(4, '0')}`).join('\r\n')
    core.output(fill + '\r\nfill tail line')
    await expect.poll(async () => { await tick(page, 80); return await page.locator('.xterm-rows').textContent() }, { timeout: 45000 }).toMatch(/fill tail line/)
    await expect.poll(async () => { await tick(page, 60); return scrollbackRows(page) }).toBe(5000)
    expect(await viewportY(page)).toBe(5000)
    const cap = await scrollbackRows(page)
    // Park ~15 rows off the live tail inside the lifted region: the viewport
    // stays at its bottom edge while the transform carries the window.
    for (let i = 0; i < 15; i++) await wheel(-1)
    expect(await viewportY(page)).toBe(5000)
    const parkedText = await xterm.evaluate((el, top) => {
      const rows = el.querySelector('.xterm-rows')
      if (!rows) return ''
      for (const d of Array.from(rows.children) as HTMLElement[]) {
        if (d.getBoundingClientRect().bottom > top + 1) return d.textContent || ''
      }
      return ''
    }, clip.top)
    // The parked position is a lift: the top row carries fill text, not the
    // tail — an empty read would let hasText match every row.
    expect(parkedText).toMatch(/fill line \d{4}/)
    const parkedRow = page.locator('.xterm-rows > div').filter({ hasText: parkedText }).first()
    const parkedBox = (await parkedRow.boundingBox())!
    expect((await screen.getAttribute('style')) || '').toContain('translateY(-')
    // One newline, then a coalesced three: two trim rounds must not move the
    // parked text or its row rectangle, and the cap holds.
    core.output('\r\nfill extra 1')
    await expectRows(page, /fill extra 1/)
    const stillBox = (await page.locator('.xterm-rows > div').filter({ hasText: parkedText }).first().boundingBox())!
    expect(stillBox.y).toBeCloseTo(parkedBox.y, 0)
    core.output('\r\nfill extra 2\r\nfill extra 3\r\nfill extra 4')
    await expectRows(page, /fill extra 4/)
    const finalBox = (await page.locator('.xterm-rows > div').filter({ hasText: parkedText }).first().boundingBox())!
    expect(finalBox.y).toBeCloseTo(parkedBox.y, 0)
    expect(await scrollbackRows(page)).toBe(cap)
    await page.screenshot({ path: testInfo.outputPath(`05-watch-full-${testInfo.project.name}.png`) })
    expect(dataIn(core).length).toBe(d0)
    expect(resizeFrames()).toBe(r0)
    expect(silentPackets(sent)).toEqual([])
  } finally {
    await core.stop()
  }
})
