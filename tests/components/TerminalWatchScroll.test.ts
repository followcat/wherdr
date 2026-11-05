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

class FakeTerm {
  cols = 200
  rows = 60
  options: Record<string, unknown> = { fontFamily: 'monospace', fontSize: 13, theme: {} }
  textarea = document.createElement('textarea')
  element = document.createElement('div')
  screen = document.createElement('div')
  viewportEl = document.createElement('div')
  modes = { mouseTrackingMode: 'none' }
  buffer = {
    active: {
      viewportY: 0, baseY: 0, length: 0, cursorY: 0,
      getLine: () => undefined,
    },
  }
  onScrollCb: ((y: number) => void) | null = null
  constructor() {
    terms.push(this)
    this.screen.className = 'xterm-screen'
    this.viewportEl.className = 'xterm-viewport'
    this.element.append(this.viewportEl, this.screen, this.textarea)
  }
  scrollLines = (d: number) => {
    const b = this.buffer.active
    const y = Math.max(0, Math.min(b.viewportY + d, b.baseY))
    if (y !== b.viewportY) { b.viewportY = y; this.onScrollCb?.(y) }
  }
  scrollToLine = (y: number) => { this.scrollLines(y - this.buffer.active.viewportY) }
  // A native scrollbar seek: xterm's own handler has already mapped the new
  // scrollTop to a viewport position before our listener runs.
  seekViewport(y: number) {
    this.buffer.active.viewportY = Math.max(0, Math.min(y, this.buffer.active.baseY))
    this.viewportEl.dispatchEvent(new Event('scroll'))
  }
  // Output scrolling the grid: ybase grows, and when the viewport sat at the
  // bottom edge ydisp tracks it (xterm's real auto-advance) — firing onScroll.
  pushOutput(n = 1) {
    const b = this.buffer.active
    const wasBottom = b.viewportY === b.baseY
    b.baseY += n
    b.length += n
    if (wasBottom && b.viewportY !== b.baseY) {
      b.viewportY = b.baseY
      this.onScrollCb?.(b.viewportY)
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
// 30.4 at 304px — phone hosts are fractional in practice.
const ROWPX = 10
async function setup(buffer: { viewportY: number, baseY: number, length: number, cursorY: number }, hostPx = 300) {
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
  Object.defineProperty(term.screen, 'offsetHeight', { value: term.rows * ROWPX, configurable: true })
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
    // The application switches to its alternate screen: buffer.active is a
    // new object whose baseY 0 / viewportY 0 read numerically as "output at
    // the bottom edge" — only the buffer's identity says the domain changed.
    term.buffer.active = { viewportY: 0, baseY: 0, length: 60, cursorY: 59, getLine: () => undefined }
    frame(ws)
    await nextTick()
    expect(windowTop(term)).toBe(30)
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
    ws.receive({ type: 'terminal.frame', full: true, bytes: btoa('x'), credit: 10 })
    await nextTick()
    expect(windowTop(term)).toBe(32)
  } finally {
    ctl.dispose()
    host.remove()
    wrapper.unmount()
  }
})
