import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createTerminal } from '~/composables/useTerminal'
import { terminalRenderer } from '~/composables/useHerdr'

// Watching a grid taller than the clipped host: the visible window's top is a
// buffer row reachable either through xterm's viewport (scrollback positions)
// or through the follow transform (the clipped bottom of the grid). These
// tests drive the real createTerminal against a FakeTerm that models only the
// public scroll contract: viewportY clamped to [0, baseY], onScroll fired
// synchronously from scrollLines/scrollToLine (xterm's real timing), and a
// DOM .xterm-viewport scroll event standing in for native scrollbar seeks
// (xterm suppresses the public event for those). The socket carries the real
// capabilities/control/frame lifecycle so watching mode is genuine.
const terms = vi.hoisted(() => [] as FakeTerm[])

// A public IMarker stand-in: an absolute buffer-row anchor that follows its
// row through trims (line decreases) and is disposed when the row is gone —
// exactly what the installed xterm does (verified in a Node probe).
class FakeMarker {
  isDisposed = false
  private _d: (() => void) | null = null
  constructor(public line: number) {}
  dispose() { if (!this.isDisposed) { this.isDisposed = true; this._d?.() } }
  onDispose(fn: () => void) { this._d = fn; return { dispose: () => {} } }
}

interface FakeBuf {
  viewportY: number
  baseY: number
  length: number
  cursorY: number
  lines: { text: string }[]
  markers: FakeMarker[]
  getLine: (y: number) => { text: string } | undefined
}

const newBuffer = (): FakeBuf => {
  const b: FakeBuf = {
    viewportY: 0, baseY: 0, length: 0, cursorY: 0,
    lines: [], markers: [],
    getLine: (y: number) => b.lines[y],
  }
  return b
}

class FakeTerm {
  cols = 200
  rows = 60
  options: Record<string, unknown> = { fontFamily: 'monospace', fontSize: 13, theme: {} }
  textarea = document.createElement('textarea')
  element = document.createElement('div')
  screen = document.createElement('div')
  viewportEl = document.createElement('div')
  modes = { mouseTrackingMode: 'none' }
  buffer = { active: newBuffer() }
  // Infinite by default (xterm's scrollback option): tests set a finite one
  // to exercise trimming at capacity.
  scrollbackRows = Infinity
  // xterm's user-scroll lock: scrolls up set it, reaching the bottom edge
  // clears it — while set, trims keep the displayed row instead of ydisp.
  isUserScrolling = false
  onScrollCb: ((y: number) => void) | null = null
  constructor() {
    terms.push(this)
    this.screen.className = 'xterm-screen'
    this.viewportEl.className = 'xterm-viewport'
    this.element.append(this.viewportEl, this.screen, this.textarea)
  }
  // BufferService.scrollLines' flag semantics: a scroll up means user
  // scrolling; reaching the bottom edge ends it.
  private scrollFlag(d: number, from: number) {
    if (d < 0) this.isUserScrolling = true
    else if (from + d >= this.buffer.active.baseY) this.isUserScrolling = false
  }
  scrollLines = (d: number) => {
    const b = this.buffer.active
    if (d < 0 && b.viewportY === 0) return
    this.scrollFlag(d, b.viewportY)
    const y = Math.max(0, Math.min(b.viewportY + d, b.baseY))
    if (y !== b.viewportY) { b.viewportY = y; this.onScrollCb?.(y) }
  }
  scrollToLine = (y: number) => { this.scrollLines(y - this.buffer.active.viewportY) }
  // A native scrollbar seek: same flag rules as scrollLines but xterm
  // suppresses the public event — only the DOM scroll fires.
  seekViewport(y: number) {
    const b = this.buffer.active
    const d = Math.max(0, Math.min(y, b.baseY)) - b.viewportY
    this.scrollFlag(d, b.viewportY)
    b.viewportY += d
    this.viewportEl.dispatchEvent(new Event('scroll'))
  }
  // Public marker API: registers at the cursor's buffer row plus an offset.
  registerMarker = (offset = 0) => {
    const b = this.buffer.active
    const m = new FakeMarker(b.baseY + b.cursorY + offset)
    ;(b.markers ??= []).push(m)
    return m
  }
  // Output scrolling the grid, one line at a time like BufferService.scroll:
  // below capacity ybase grows; at capacity the oldest row is trimmed instead,
  // markers and a user-scrolled ydisp track the shifted rows, and a
  // non-user-scrolled viewport is pinned to the bottom. onScroll fires once
  // per scrolling line even when the position did not change.
  pushOutput(n = 1, text = 'out') {
    const b = this.buffer.active
    const cap = this.rows + this.scrollbackRows
    for (let i = 0; i < n; i++) {
      if (b.length >= cap) {
        b.lines?.shift()
        for (const m of b.markers ?? []) { m.line--; if (m.line < 0) m.dispose() }
        if (this.isUserScrolling) b.viewportY = Math.max(b.viewportY - 1, 0)
      } else {
        b.baseY++
        b.length++
      }
      if (!this.isUserScrolling) b.viewportY = b.baseY
      ;(b.lines ??= []).push({ text: `${text} ${i}` })
      this.onScrollCb?.(b.viewportY)
    }
  }
  // An in-place row deletion (ESC[M): the deleted row's markers die while
  // rows below shift up — no top-trim, no scroll event. The trailing output
  // line that scrolls is what fires onScroll, at unchanged baseY/viewportY.
  deleteRow(y: number) {
    const b = this.buffer.active
    b.lines?.splice(y, 1)
    b.lines?.push({ text: '' })
    for (const m of b.markers ?? []) {
      if (m.line === y) m.dispose()
      else if (m.line > y) m.line--
    }
  }
  // The DOM scroll event a scrollTop sync produces after ANY change, ours
  // included: viewportY is already current when it fires.
  echoViewport() { this.viewportEl.dispatchEvent(new Event('scroll')) }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows }
  loadAddon() {} open() {} focus() {} dispose() {} refresh() {} reset() {}
  attachCustomWheelEventHandler() {} attachCustomKeyEventHandler() {}
  onData() {} onBinary() {}
  onScroll(fn: (y: number) => void) { this.onScrollCb = fn }
  write(_d: unknown, cb?: () => void) { cb?.() }
}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerm }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { return null } } }))
vi.mock('~/utils/terminalMouse', () => ({ bindTerminalMouse: () => ({ dispose() {} }) }))
vi.mock('~/utils/terminalSelection', () => ({ bindTerminalSelection: () => () => {} }))
vi.mock('~/utils/terminalLinks', () => ({ bindTerminalLinks: () => ({ dispose() {} }) }))
vi.mock('~/utils/terminalOsc52', () => ({ OSC52_MAX_BYTES: 1000, bindTerminalOsc52: () => () => {} }))
vi.mock('~/utils/terminalFont', () => ({ TERM_FONT: 'monospace', onFontsLoaded: () => () => {} }))

class FakeSocket {
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  static all: FakeSocket[] = []
  constructor(public url: string) { FakeSocket.all.push(this) }
  send(s: string) { this.sent.push(s) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.onopen?.() }
  receive(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }) }
  messages() { return this.sent.map(s => JSON.parse(s) as Record<string, unknown>) }
}

// The clipped host shows 30 of the 60 grid rows at 300px, or a fractional
// 30.4 at 304px — phone hosts are fractional in practice. Small fixtures pass
// `rows` for a fast saturated buffer (scrollback 5, grid 4, host 2).
const ROWPX = 10
async function setup(buffer: { viewportY: number, baseY: number, length: number, cursorY: number }, hostPx = 300, rows = 60) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  Object.defineProperty(host, 'clientHeight', { value: hostPx, configurable: true })
  let ctl!: ReturnType<typeof createTerminal>
  const wrapper = mount(defineComponent({
    setup() {
      ctl = createTerminal('w1:p1', { setBanner: vi.fn(), hasBanner: () => false })
      return () => h('div')
    },
  }), { attachTo: document.body })
  terminalRenderer.value = 'html'
  expect(await ctl.mount(host)).toBe(true)
  const term = terms[0]!
  term.rows = rows
  Object.defineProperty(term.screen, 'offsetHeight', { value: rows * ROWPX, configurable: true })
  Object.assign(term.buffer.active, buffer)
  ctl.connect(false)
  const ws = FakeSocket.all.at(-1)!
  ws.open()
  ws.receive({ type: 'web.capabilities', core: true })
  ws.receive({ type: 'terminal.control', on: false })
  return { ctl, term, ws, host, wrapper }
}

// The visible window's top as a buffer row: xterm's viewport position plus
// however many rows the follow transform lifts the rendered screen.
const liftRows = (term: FakeTerm) => {
  const m = /translateY\(-([\d.]+)px\)/.exec(term.screen.style.transform || '')
  return m ? Number(m[1]) / ROWPX : 0
}
const windowTop = (term: FakeTerm) => term.buffer.active.viewportY + liftRows(term)

const frame = (ws: FakeSocket, extra: Record<string, unknown> = {}) =>
  ws.receive({ type: 'terminal.frame', bytes: btoa('x'), credit: 10, ...extra })

beforeEach(() => {
  terms.length = 0
  FakeSocket.all.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

it.each([0, 1, 2])('a watching scroll reaches every row of a %d-scrollback buffer in one-row steps', async (baseY) => {
  const { ctl, term, ws, host, wrapper } = await setup({ viewportY: baseY, baseY, length: 60 + baseY, cursorY: 59 })
  try {
    // A written frame on a watching terminal refreshes the follow transform:
    // the live tail pins the cursor's bottom edge to the host bottom, i.e.
    // baseY + 30 rows of lift (this much already worked before the fix).
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(baseY + 30)
    // Up in one-line steps: the window top must walk every single buffer row
    // — never skip, never jump more than one. Row 30 of the 60-row grid sits
    // exactly at the history/grid boundary for baseY = 1.
    const tops: number[] = []
    for (let i = baseY + 30; i >= 0; i--) { tops.push(windowTop(term)); ctl.scroll(1) }
    expect(tops).toEqual(Array.from({ length: baseY + 31 }, (_, i) => baseY + 30 - i))
    // Back down the same way to the live tail.
    const downs: number[] = []
    for (let i = 0; i <= baseY + 30; i++) { downs.push(windowTop(term)); ctl.scroll(-1) }
    expect(downs).toEqual(Array.from({ length: baseY + 31 }, (_, i) => i))
    expect(windowTop(term)).toBe(baseY + 30)
  } finally {
    ctl.dispose()
    host.remove()
    wrapper.unmount()
  }
})

it.each([0, 1, 2])('a fractional host still moves the window exactly one row per step (baseY %d)', async (baseY) => {
  // 304px host at 10px rows: hostRows 30.4 — the tail and every step in and
  // out of history land between integer buffer rows, so the projection must
  // carry the fraction into the lift rather than drop it.
  const { ctl, term, ws, host, wrapper } = await setup({ viewportY: baseY, baseY, length: 60 + baseY, cursorY: 59 }, 304)
  try {
    frame(ws)
    await nextTick()
    const tail = baseY + (60 - 30.4)
    expect(windowTop(term)).toBeCloseTo(tail, 1)
    // Walk up one line at a time: the projected top must be the expected
    // position within pixel rounding (translateY is rounded to 1/100 px).
    const expected: number[] = []
    const tops: number[] = []
    for (let v = tail; v > 0; v -= 1) { expected.push(Math.max(0, v)); tops.push(windowTop(term)); ctl.scroll(1) }
    expected.push(0)
    tops.push(windowTop(term))
    for (let i = 0; i < tops.length; i++) expect(tops[i]).toBeCloseTo(expected[i]!, 1)
    // And the same in reverse, back to the live tail.
    for (let i = 0; i < expected.length - 1; i++) ctl.scroll(-1)
    expect(windowTop(term)).toBeCloseTo(tail, 1)
  } finally {
    ctl.dispose()
    host.remove()
    wrapper.unmount()
  }
})

it('keeps an owned delta when the trailing viewport event lands, and still honors native seeks', async () => {
  const { ctl, term, ws, host, wrapper } = await setup({ viewportY: 1, baseY: 1, length: 61, cursorY: 59 })
  try {
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(31)
    // An owned delta that crosses the viewport boundary: scrollToLine's
    // synchronous onScroll must not disturb the position we just set.
    ctl.scroll(31)
    expect(windowTop(term)).toBe(0)
    expect(term.buffer.active.viewportY).toBe(0)
    ctl.scroll(-1)
    expect(windowTop(term)).toBe(1)
    expect(term.buffer.active.viewportY).toBe(1)
    // The delayed DOM scroll event from that scrollToLine's scrollTop sync:
    // viewportY did not move again, so it changes nothing.
    term.echoViewport()
    expect(windowTop(term)).toBe(1)
    // An owned delta into the lifted region (viewportY stays baseY): a stray
    // same-position viewport event must not snap the window back into history.
    ctl.scroll(-5)
    expect(windowTop(term)).toBe(6)
    term.echoViewport()
    expect(windowTop(term)).toBe(6)
    // A native scrollbar seek is an absolute position in history space.
    term.seekViewport(0)
    expect(windowTop(term)).toBe(0)
    // Its bottom edge is the live tail again.
    term.seekViewport(1)
    expect(windowTop(term)).toBe(31)
  } finally {
    ctl.dispose()
    host.remove()
    wrapper.unmount()
  }
})

it('the scroll range spans the whole grid when the cursor sits above its bottom', async () => {
  const { ctl, term, ws, host, wrapper } = await setup({ viewportY: 1, baseY: 1, length: 61, cursorY: 20 })
  try {
    frame(ws)
    await nextTick()
    // The live pin is still cursor-based: 21 rows up in a 30-row host puts
    // the window top at the history edge — but the rendered grid below the
    // cursor is not dead space, it scrolls out to the grid's own bottom.
    expect(windowTop(term)).toBe(1)
    ctl.scroll(-30)
    expect(windowTop(term)).toBe(31)
    // Parked in the static lower rows, output must hold the reading row —
    // the position is a buffer coordinate, not a bottom-edge pin.
    term.pushOutput(1)
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(31)
    expect(term.buffer.active.baseY).toBe(2)
  } finally {
    ctl.dispose()
    host.remove()
    wrapper.unmount()
  }
})

it('an active-buffer swap re-pins the window instead of holding a stale lifted position', async () => {
  const { ctl, term, ws, host, wrapper } = await setup({ viewportY: 1, baseY: 1, length: 61, cursorY: 59 })
  try {
    frame(ws)
    await nextTick()
    ctl.scroll(16)
    expect(windowTop(term)).toBe(15)
    expect(liveMarkers(term)).toBe(1)
    const mainBuf = term.buffer.active
    // The application switches to its alternate screen: buffer.active is a
    // new object whose baseY 0 / viewportY 0 read numerically as "output at
    // the bottom edge" — only the buffer's identity says the domain changed.
    term.buffer.active = { viewportY: 0, baseY: 0, length: 60, cursorY: 59, lines: [], markers: [], getLine: () => undefined }
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(30)
    // The lifted anchor is dropped with the domain: the old buffer keeps no
    // live marker and the new buffer has none.
    expect(mainBuf.markers.filter(m => !m.isDisposed).length).toBe(0)
    expect(liveMarkers(term)).toBe(0)
    ctl.scroll(10)
    expect(windowTop(term)).toBe(20)
  } finally {
    ctl.dispose()
    host.remove()
    wrapper.unmount()
  }
})

it('output preserves the reading position, control returning drops the lift, a full repaint re-pins', async () => {
  const { ctl, term, ws, host, wrapper } = await setup({ viewportY: 1, baseY: 1, length: 61, cursorY: 59 })
  try {
    frame(ws)
    await nextTick()
    ctl.scroll(10)
    expect(windowTop(term)).toBe(21)
    expect(liveMarkers(term)).toBe(1)
    // Output while scrolled back inside history: xterm leaves the viewport
    // where it is — the reader's row does not move.
    term.pushOutput(1)
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(21)
    // Output while the reader sits in the LIFTED part of the grid: viewportY
    // is still the bottom edge, so xterm's auto-advance grows ybase and ydisp
    // together and fires onScroll. It is not a seek — the row must stay.
    ctl.scroll(8)
    expect(windowTop(term)).toBe(13)
    expect(term.buffer.active.viewportY).toBe(2)
    expect(liveMarkers(term)).toBe(1)
    term.pushOutput(2)
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(13)
    expect(term.buffer.active.baseY).toBe(4)
    // A lifted reader's scrollbar already sits at its bottom edge: the only
    // native round trip goes up into history (dropping the lift) and back to
    // the bottom edge, which re-pins the window to live output.
    term.seekViewport(0)
    expect(windowTop(term)).toBe(0)
    expect(liveMarkers(term)).toBe(0)
    term.seekViewport(4)
    expect(windowTop(term)).toBe(34)
    term.pushOutput(1)
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(35)
    // Taking control back: the remote grid refits to this host (30 rows),
    // the lifted domain collapses and the window returns to a plain tail.
    ws.receive({ type: 'terminal.control', on: true })
    Object.assign(term.buffer.active, { baseY: 5, viewportY: 5, cursorY: 29 })
    ws.receive({ type: 'terminal.frame', width: 200, height: 30, bytes: btoa('x'), credit: 10 })
    await nextTick()
    expect(term.rows).toBe(30)
    expect(liftRows(term)).toBe(0)
    expect(windowTop(term)).toBe(5)
    // Watching again with a full repaint: the window re-pins to live.
    ws.receive({ type: 'terminal.control', on: false })
    term.rows = 60
    Object.assign(term.buffer.active, { viewportY: 2, baseY: 2, length: 62, cursorY: 59 })
    ctl.scroll(10)
    expect(windowTop(term)).toBe(10)
    expect(liveMarkers(term)).toBe(1)
    ws.receive({ type: 'terminal.frame', full: true, bytes: btoa('x'), credit: 10 })
    await nextTick()
    expect(windowTop(term)).toBe(32)
    expect(liveMarkers(term)).toBe(0)
  } finally {
    ctl.dispose()
    host.remove()
    wrapper.unmount()
  }
})

const seedRows = (term: FakeTerm, n: number, prefix = 'row') => {
  term.buffer.active.lines = Array.from({ length: n }, (_, i) => ({ text: `${prefix} ${i}` }))
}
const topText = (term: FakeTerm) => term.buffer.active.getLine(Math.floor(windowTop(term)))?.text
// The owned anchor: at most one live marker on the active buffer, ever.
const liveMarkers = (term: FakeTerm) => (term.buffer.active.markers ?? []).filter(m => !m.isDisposed).length

it('keeps the parked text at full scrollback while trims shift its row', async () => {
  // The finding's exact shape: 5000 retained rows, a 60-row grid and a
  // 30-row host. Each scrolling newline trims the oldest row — every index
  // slides under the parked text while ybase/ydisp hold at 5000.
  const { ctl, term, ws, host, wrapper } = await setup({ viewportY: 5000, baseY: 5000, length: 5060, cursorY: 59 })
  term.scrollbackRows = 5000
  seedRows(term, 5060)
  try {
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(5030)
    // The live tail keeps following at capacity.
    term.pushOutput(2)
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(5030)
    expect(term.buffer.active.viewportY).toBe(5000)
    // Park inside the lifted grid: the window top is buffer row 5015. The
    // live-tail trims above already shifted seeded names off their index —
    // capture the parked row's actual content and track that identity.
    expect(liveMarkers(term)).toBe(0)
    ctl.scroll(15)
    expect(windowTop(term)).toBe(5015)
    expect(liveMarkers(term)).toBe(1)
    const parked = topText(term)
    // One scrolling newline trims one row: the same text must stay under the
    // window top as its index decreases.
    term.pushOutput(1)
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(5014)
    expect(topText(term)).toBe(parked)
    // A coalesced batch the same way.
    term.pushOutput(3)
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(5011)
    expect(topText(term)).toBe(parked)
    // A non-scrolling repaint at capacity is not a trim, and the trailing
    // DOM echo does not disturb the anchored position.
    frame(ws)
    await nextTick()
    term.echoViewport()
    expect(windowTop(term)).toBe(5011)
    expect(topText(term)).toBe(parked)
    // The reader's own scroll still wins: one step up lands on the next row
    // — re-anchored, still exactly one live marker. Back at the live tail
    // the anchor is dropped entirely.
    ctl.scroll(1)
    expect(windowTop(term)).toBe(5010)
    expect(liveMarkers(term)).toBe(1)
    ctl.scroll(-25)
    expect(liveMarkers(term)).toBe(0)
  } finally {
    ctl.dispose()
    host.remove()
    wrapper.unmount()
  }
})

it('keeps a parked fractional offset through output growth, batches and trims', async () => {
  // 304px host at 10px rows: hostRows 30.4 — the parked window top carries a
  // 0.6-row fraction. A scrolling newline that only grows ybase moves no
  // row: the position, fraction included, must not be snapped to viewportY.
  const { ctl, term, ws, host, wrapper } = await setup({ viewportY: 100, baseY: 100, length: 160, cursorY: 59 }, 304)
  try {
    frame(ws)
    await nextTick()
    ctl.scroll(100)
    expect(windowTop(term)).toBeCloseTo(29.6, 5)
    expect(term.buffer.active.viewportY).toBe(29)
    expect(liveMarkers(term)).toBe(1)
    // One line, then a coalesced batch: base-only growth leaves every row in
    // place — the parked 29.6 stays 29.6, not 29.
    term.pushOutput(1)
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBeCloseTo(29.6, 5)
    term.pushOutput(3)
    frame(ws)
    await nextTick()
    expect(term.buffer.active.baseY).toBe(104)
    expect(windowTop(term)).toBeCloseTo(29.6, 5)
    // A real native seek is absolute: it replaces the position, fraction
    // included, and its bottom edge re-pins the live tail.
    term.seekViewport(40)
    expect(windowTop(term)).toBe(40)
    term.seekViewport(104)
    expect(windowTop(term)).toBeCloseTo(104 + 60 - 30.4, 5)
    expect(liveMarkers(term)).toBe(0)
    // An owned scroll back into the fraction plus its trailing DOM echo
    // must not reinterpret the delta.
    ctl.scroll(100)
    expect(windowTop(term)).toBeCloseTo(33.6, 5)
    term.echoViewport()
    expect(windowTop(term)).toBeCloseTo(33.6, 5)
  } finally {
    ctl.dispose()
    host.remove()
    wrapper.unmount()
  }
})

it('keeps the parked fraction on its text at full scrollback, and clamps the lost oldest fraction to 0', async () => {
  // Saturated: every newline trims the oldest row. xterm tracks a parked
  // history viewport down one index per trim (user-scrolled ydisp) — an
  // output trim and a one-row native seek produce the same viewportY step,
  // so the marker's own line is what tells them apart.
  const { ctl, term, ws, host, wrapper } = await setup({ viewportY: 5000, baseY: 5000, length: 5060, cursorY: 59 }, 304)
  term.scrollbackRows = 5000
  try {
    frame(ws)
    await nextTick()
    ctl.scroll(5000)
    expect(windowTop(term)).toBeCloseTo(29.6, 5)
    expect(term.buffer.active.viewportY).toBe(29)
    // One trim: the anchored row slides to index 28, the viewport follows it
    // natively — the fraction survives on the same text.
    term.pushOutput(1)
    frame(ws)
    await nextTick()
    expect(term.buffer.active.viewportY).toBe(28)
    expect(windowTop(term)).toBeCloseTo(28.6, 5)
    // A one-row native seek yields the same viewportY step a trim does but
    // must NOT keep the fraction — the reader asked for an absolute row.
    term.seekViewport(27)
    expect(windowTop(term)).toBe(27)
    // Re-park fractionally (the tail carries the 0.6) and sit on the oldest
    // row: once it is trimmed away the position clamps exactly — 0, not a
    // lingering fraction.
    ctl.scroll(-6000)
    ctl.scroll(5000)
    expect(windowTop(term)).toBeCloseTo(29.6, 5)
    ctl.scroll(29)
    expect(windowTop(term)).toBeCloseTo(0.6, 5)
    expect(liveMarkers(term)).toBe(1)
    term.pushOutput(1)
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(0)
    expect(liveMarkers(term)).toBe(0)
    term.pushOutput(1)
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(0)
  } finally {
    ctl.dispose()
    host.remove()
    wrapper.unmount()
  }
})

it('keeps the nearest position when the parked row is deleted in place, not trimmed', async () => {
  // scrollback 5, 4-row grid, 2-row host — the Node repro's exact shape: a
  // marker on buffer row 6 dies when ESC[M deletes its line in place, then
  // a trailing newline scrolls and fires onScroll at the same baseY/vp.
  // Disposal is not always a top-trim: teleporting the reader to row 0
  // would be wrong — the index is still valid, so keep it and re-anchor.
  const { ctl, term, ws, host, wrapper } = await setup({ viewportY: 5, baseY: 5, length: 9, cursorY: 3 }, 20, 4)
  term.scrollbackRows = 5
  try {
    seedRows(term, 9, 'row')
    frame(ws)
    await nextTick()
    ctl.scroll(1)
    expect(windowTop(term)).toBe(6)
    expect(liveMarkers(term)).toBe(1)
    term.deleteRow(6)
    term.pushOutput(1)
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(6)
    expect(liveMarkers(term)).toBe(1)
  } finally {
    ctl.dispose()
    host.remove()
    wrapper.unmount()
  }
})

it('a history-parked row tracks trims through the viewport', async () => {
  const { ctl, term, ws, host, wrapper } = await setup({ viewportY: 5000, baseY: 5000, length: 5060, cursorY: 59 })
  term.scrollbackRows = 5000
  seedRows(term, 5060)
  try {
    frame(ws)
    await nextTick()
    // Scrolled back inside history: the row sits in xterm's own viewport
    // domain — its isUserScrolling tracking already decrements ydisp per
    // trim, and the resync must not double-count or lose the row.
    ctl.scroll(40)
    expect(windowTop(term)).toBe(4990)
    const parked = topText(term)
    term.pushOutput(2)
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(4988)
    expect(topText(term)).toBe(parked)
  } finally {
    ctl.dispose()
    host.remove()
    wrapper.unmount()
  }
})

it('a parked row survives the transition into capacity, then clamps to the oldest row once trimmed away', async () => {
  // Small saturated fixture: scrollback 5 + grid 4, a 2-row host.
  const { ctl, term, ws, host, wrapper } = await setup({ viewportY: 3, baseY: 3, length: 7, cursorY: 3 }, 20, 4)
  term.scrollbackRows = 5
  seedRows(term, 7)
  try {
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(5)
    // Park on the grid's top row (the baseY boundary counts as lifted).
    ctl.scroll(1)
    expect(windowTop(term)).toBe(4)
    expect(topText(term)).toBe('row 4')
    // Growing toward capacity: appends do not move the row's index.
    term.pushOutput(1)
    frame(ws)
    await nextTick()
    expect(term.buffer.active.baseY).toBe(4)
    expect(windowTop(term)).toBe(4)
    expect(topText(term)).toBe('row 4')
    // Reaching capacity: baseY tops out and trims start — the parked text
    // slides into history one index per trim and the window follows it.
    term.pushOutput(2)
    frame(ws)
    await nextTick()
    expect(term.buffer.active.baseY).toBe(5)
    expect(term.buffer.active.length).toBe(9)
    expect(windowTop(term)).toBe(3)
    expect(topText(term)).toBe('row 4')
    term.pushOutput(3)
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(0)
    expect(topText(term)).toBe('row 4')
    // The row itself is trimmed away: clamp to the oldest position — the
    // window must not wrap or hold a row that no longer exists.
    term.pushOutput(1)
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(0)
    expect(topText(term)).toBe('row 5')
  } finally {
    ctl.dispose()
    host.remove()
    wrapper.unmount()
  }
})
