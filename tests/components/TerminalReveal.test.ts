import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { createTerminal } from '~/composables/useTerminal'
import { smoothTouchScrolling, terminalRenderer } from '~/composables/useHerdr'
import { REVEAL_QUIET_MS } from '~/utils/terminalReveal'

// The first thing shown after an attach is the final screen at the live tail:
// the core's replay arrives as several frames with no end marker, so the
// terminal stays covered until xterm has written them all and the stream has
// been quiet for the gate's period. FakeTerm models only the public xterm
// contract needed here: writes are parsed when the test says so (`flush`), and
// a parsed chunk scrolls the buffer as xterm does.
const terms: FakeTerm[] = []
const ROWPX = 10

class FakeMarker {
  isDisposed = false
  constructor(public line: number) {}
  dispose() { this.isDisposed = true }
  onDispose() { return { dispose: () => {} } }
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
  markerList: FakeMarker[] = []
  // Writes xterm has received but not parsed yet, with their callbacks.
  private writes: { lines: number, done?: () => void }[] = []
  buffer = {
    active: {
      viewportY: 0, baseY: 0, length: 60, cursorY: 59,
      lines: [] as { text: string }[],
      markers: [] as FakeMarker[],
      getLine: (y: number) => (this.buffer.active as { lines: { text: string }[] }).lines[y],
    },
  }
  onScrollCb: ((y: number) => void) | null = null
  constructor() {
    terms.push(this)
    this.screen.className = 'xterm-screen'
    this.viewportEl.className = 'xterm-viewport'
    this.element.append(this.viewportEl, this.screen, this.textarea)
  }
  scrollLines(d = 0) {
    const b = this.buffer.active
    const y = Math.max(0, Math.min(b.viewportY + d, b.baseY))
    if (y !== b.viewportY) { b.viewportY = y; this.onScrollCb?.(y) }
  }
  scrollToLine(y: number) { this.scrollLines(y - this.buffer.active.viewportY) }
  registerMarker(offset = 0) {
    const b = this.buffer.active
    const m = new FakeMarker(b.baseY + b.cursorY + offset)
    b.markers.push(m)
    return m
  }
  write(data: string | Uint8Array, done?: () => void) {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
    const lines = text.split('\n').length - 1
    this.writes.push({ lines, done })
  }
  // xterm's parse: the queued writes scroll the buffer, then their callbacks run.
  flush() {
    const b = this.buffer.active
    const queued = this.writes.splice(0)
    for (const w of queued) {
      if (w.lines) {
        b.baseY += w.lines
        b.length += w.lines
        b.cursorY = this.rows - 1
        b.viewportY = b.baseY
        this.onScrollCb?.(b.viewportY)
      }
      w.done?.()
    }
  }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows }
  loadAddon() {} open() {} focus() {} dispose() {} refresh() {} clearTextureAtlas() {}
  reset() { Object.assign(this.buffer.active, { viewportY: 0, baseY: 0, length: this.rows, cursorY: this.rows - 1 }) }
  parser = { registerCsiHandler: () => ({ dispose() {} }), registerEscHandler: () => ({ dispose() {} }) }
  attachCustomWheelEventHandler() {} attachCustomKeyEventHandler() {}
  onData() {} onBinary() {}
  onScroll(fn: (y: number) => void) { this.onScrollCb = fn }
}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerm }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { return null } } }))
vi.mock('~/utils/terminalMouse', () => ({ bindTerminalMouse: () => ({ dispose() {} }), terminalCell: () => null }))
vi.mock('~/utils/terminalSelection', () => ({ bindTerminalSelection: () => () => {} }))
vi.mock('~/utils/terminalLinks', () => ({ bindTerminalLinks: () => ({ dispose() {} }) }))
vi.mock('~/utils/terminalOsc52', () => ({ OSC52_MAX_BYTES: 1000, bindTerminalOsc52: () => () => {} }))
vi.mock('~/utils/terminalFont', async importOriginal => ({ ...(await importOriginal() as object), TERM_FONT: 'monospace', onFontsLoaded: () => () => {} }))

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

// 60 grid rows at 300px host rows' 10px cell: a watching viewer shows 30 of
// them and lifts the rest, so the tail is baseY + 30.
async function setup(control = false) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  Object.defineProperty(host, 'clientHeight', { value: 300, configurable: true })
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
  term.buffer.active.cursorY = term.rows - 1
  ctl.connect(false)
  const ws = FakeSocket.all.at(-1)!
  ws.open()
  ws.receive({ type: 'web.capabilities', core: true })
  ws.receive({ type: 'terminal.control', on: control })
  return { ctl, term, ws, host, wrapper }
}

// The visible window's top as a buffer row: xterm's viewport plus the lift.
const liftRows = (term: FakeTerm) => {
  const m = /translateY\(-([\d.]+)px\)/.exec(term.screen.style.transform || '')
  return m ? Number(m[1]) / ROWPX : 0
}
const windowTop = (term: FakeTerm) => term.buffer.active.viewportY + liftRows(term)

const paint = (lines: number) => btoa('history line\r\n'.repeat(lines))
const frame = (ws: FakeSocket, lines: number, credit = 100) =>
  ws.receive({ type: 'terminal.frame', encoding: 'ansi', width: 200, height: 60, bytes: lines ? paint(lines) : '', credit })

beforeEach(() => {
  terms.length = 0
  FakeSocket.all.length = 0
  smoothTouchScrolling.value = false
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function open(control = false) {
  const { ctl, term, ws, host, wrapper } = await setup(control)
  ws.receive({ type: 'terminal.frame', encoding: 'ansi', full: true, width: 200, height: 60, bytes: '' })
  return { ctl, term, ws, host, wrapper }
}

it('holds the cover until the replay is written, then shows the tail', async () => {
  const { ctl, term, ws, host, wrapper } = await open()
  try {
    // Three pieces, each arriving inside the quiet period of the previous write.
    for (const [i, lines] of [120, 130, 50].entries()) {
      frame(ws, lines, 10 + i)
      term.flush()
      await vi.advanceTimersByTimeAsync(REVEAL_QUIET_MS - 20)
      // Nothing between the pieces is shown, and nothing reacts to them: no
      // copy capture, no scroll, no parked-position anchor.
      expect(ctl.loading.value).toBe(true)
      expect(ctl.captureScreen()).toBeNull()
      expect(ctl.scroll(2)).toBe(false)
      expect(term.buffer.active.markers).toEqual([])
    }
    // The last write is 130 ms old: still covered.
    await vi.advanceTimersByTimeAsync(19)
    expect(ctl.loading.value).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    // Revealed exactly once, at the live tail: 300 history rows, a 60-row
    // grid and a 30-row host put the window top 30 rows above baseY.
    expect(ctl.loading.value).toBe(false)
    expect(term.buffer.active.baseY).toBe(300)
    expect(term.buffer.active.viewportY).toBe(300)
    expect(windowTop(term)).toBe(330)
    // Every piece still credited the server while covered.
    expect(ws.messages().filter(m => m.type === 'credit')).toEqual([
      { type: 'credit', bytes: 10 },
      { type: 'credit', bytes: 11 },
      { type: 'credit', bytes: 12 },
    ])
  } finally {
    ctl.dispose(); host.remove(); wrapper.unmount()
  }
})

it('reveals at the upper bound when the program keeps printing', async () => {
  const { ctl, term, ws, host, wrapper } = await open()
  try {
    // A steady stream keeps postponing the quiet period.
    for (let i = 0; i < 19; i++) {
      frame(ws, 10, 1)
      term.flush()
      await vi.advanceTimersByTimeAsync(100)
    }
    // 1900 ms of the gate's upper bound: still covered, though the stream never paused.
    expect(ctl.loading.value).toBe(true)
    frame(ws, 10, 1)
    term.flush()
    await vi.advanceTimersByTimeAsync(100)
    // The bound shows the terminal mid-stream instead of holding it forever.
    expect(ctl.loading.value).toBe(false)
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
  } finally {
    ctl.dispose(); host.remove(); wrapper.unmount()
  }
})

it('covers the terminal again on a second full frame', async () => {
  const { ctl, term, ws, host, wrapper } = await open()
  try {
    frame(ws, 300, 10)
    term.flush()
    await vi.advanceTimersByTimeAsync(REVEAL_QUIET_MS)
    expect(ctl.loading.value).toBe(false)
    // A re-attach repaints from scratch behind the cover, and the first frame
    // shown afterwards is again the final one at the tail.
    ws.receive({ type: 'terminal.frame', encoding: 'ansi', full: true, width: 200, height: 60, bytes: '', credit: 1 })
    term.flush()
    expect(ctl.loading.value).toBe(true)
    frame(ws, 40, 11)
    term.flush()
    await vi.advanceTimersByTimeAsync(REVEAL_QUIET_MS)
    expect(ctl.loading.value).toBe(false)
    expect(windowTop(term)).toBe(term.buffer.active.baseY + 30)
  } finally {
    ctl.dispose(); host.remove(); wrapper.unmount()
  }
})

it('ignores scrolling while covered and keeps control mode on the plain tail', async () => {
  const { ctl, term, ws, host, wrapper } = await open(true)
  try {
    frame(ws, 120, 10)
    term.flush()
    // A finger over the cover must not move the replay's window.
    expect(ctl.scroll(5)).toBe(false)
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
    await vi.advanceTimersByTimeAsync(REVEAL_QUIET_MS)
    expect(ctl.loading.value).toBe(false)
    // Owning the size: the tail is baseY, no lift.
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
    expect(windowTop(term)).toBe(term.buffer.active.baseY)
    expect(ctl.scroll(3)).toBe(true)
  } finally {
    ctl.dispose(); host.remove(); wrapper.unmount()
  }
})
