// Antigravity's repaints on the core stream: DEC Mode 2026 frames reach xterm
// whole, the clear before a frame rides in the same write, flow-control credit
// returns at once for held chunks, and the view stays pinned to the tail (no
// history refetch, no jump mid-frame while watching).
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createTerminal } from '~/composables/useTerminal'
import { terminalRenderer } from '~/composables/useHerdr'

const terms = vi.hoisted(() => [] as FakeTerm[])

const newBuffer = () => ({
  viewportY: 0,
  baseY: 0,
  length: 0,
  cursorY: 0,
  markers: [] as unknown[],
})

const decoder = new TextDecoder()

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
  onScrollCb: ((y: number) => void) | null = null
  writes: string[] = []
  private pending: (() => void)[] = []
  constructor(init?: Record<string, unknown>) {
    if (init) Object.assign(this.options, init)
    terms.push(this)
    this.screen.className = 'xterm-screen'
    this.viewportEl.className = 'xterm-viewport'
    this.element.append(this.viewportEl, this.screen, this.textarea)
  }
  // Non-empty bytes handed to xterm, in order.
  dataWrites() { return this.writes.filter(Boolean) }
  write(data: unknown, cb?: () => void) {
    const text = typeof data === 'string' ? data : decoder.decode(data as Uint8Array)
    if (text) this.writes.push(text)
    if (cb) this.pending.push(cb)
  }
  flushWrites() {
    const waiting = this.pending
    this.pending = []
    for (const cb of waiting) cb()
  }
  parser = { registerCsiHandler: () => ({ dispose() {} }), registerEscHandler: () => ({ dispose() {} }) }
  scrollToLine(y: number) { this.buffer.active.viewportY = y; this.onScrollCb?.(y) }
  loadAddon() {} open() {} focus() {} dispose() {} clearTextureAtlas() {} refresh() {} reset() {}
  attachCustomWheelEventHandler() {} attachCustomKeyEventHandler() {}
  onData() {} onBinary() {}
  onScroll(fn: (y: number) => void) { this.onScrollCb = fn }
  registerMarker() { return { line: 0, isDisposed: false, dispose() {}, onDispose() { return { dispose() {} } } } }
}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerm }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { return null } } }))
vi.mock('~/utils/terminalMouse', () => ({ bindTerminalMouse: () => ({ dispose() {} }) }))
vi.mock('~/utils/terminalSelection', () => ({ bindTerminalSelection: () => () => {} }))
vi.mock('~/utils/terminalLinks', () => ({ bindTerminalLinks: () => ({ dispose() {} }) }))
vi.mock('~/utils/terminalOsc52', () => ({ OSC52_MAX_BYTES: 1000, bindTerminalOsc52: () => () => {} }))
vi.mock('~/utils/terminalFont', async (importOriginal) => ({ ...(await importOriginal() as object), TERM_FONT: 'monospace', onFontsLoaded: () => () => {} }))

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
  frame(bytes: string, extra: Record<string, unknown> = {}) {
    this.receive({ type: 'terminal.frame', width: 200, height: 60, bytes: btoa(bytes), ...extra })
  }
}

const PREFIX = '\x1b[?2026'
const OPEN = `${PREFIX}h`
const CLOSE = `${PREFIX}l`
const CLEAR = '\x1b[2J\x1b[3J\x1b[H'
const ROWPX = 10

const liftRows = (term: FakeTerm) => {
  const m = /translateY\(-([\d.]+)px\)/.exec(term.screen.style.transform || '')
  return m ? Number(m[1]) / ROWPX : 0
}
const windowTop = (term: FakeTerm) => term.buffer.active.viewportY + liftRows(term)
const histories = (ws: FakeSocket) => ws.messages().filter(m => m.type === 'terminal.history')
const credits = (ws: FakeSocket) => ws.messages().filter(m => m.type === 'credit').map(m => m.bytes)

async function setup(control = true) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  Object.defineProperty(host, 'clientHeight', { value: 300, configurable: true })
  let ctl!: ReturnType<typeof createTerminal>
  const wrapper = mount(defineComponent({
    setup() {
      ctl = createTerminal('w1:p1', { setBanner: () => false, hasBanner: () => false })
      return () => h('div')
    },
  }), { attachTo: document.body })
  terminalRenderer.value = 'html'
  expect(await ctl.mount(host)).toBe(true)
  const term = terms.at(-1)!
  term.rows = 60
  Object.defineProperty(term.screen, 'offsetHeight', { value: 60 * ROWPX, configurable: true })
  Object.assign(term.buffer.active, { viewportY: 40, baseY: 40, length: 100, cursorY: 59 })
  ctl.connect(false)
  const ws = FakeSocket.all.at(-1)!
  ws.open()
  ws.receive({ type: 'web.capabilities', core: true })
  ws.receive({ type: 'terminal.control', on: control })
  return { ctl, term, ws, host, wrapper }
}

beforeEach(() => {
  terms.length = 0
  FakeSocket.all.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

it('writes an agy clear-and-repaint to xterm once, at the close marker, and credits held chunks', async () => {
  const { ctl, term, ws, host, wrapper } = await setup()
  try {
    // An attach paint, covered until its replay is quiet.
    ws.receive({ type: 'terminal.frame', full: true, width: 200, height: 60, bytes: '' })
    // A resize repaint: the clear arrives at the end of its own chunk.
    ws.frame(CLEAR, { credit: CLEAR.length })
    expect(term.dataWrites()).toEqual([])
    expect(credits(ws)).toContain(CLEAR.length)

    // The synchronized frame, split over several chunks with the usual credits.
    const body = Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n')
    const parts = [`${OPEN}${body.slice(0, 400)}`, body.slice(400, 900), `${body.slice(900)}\n${CLOSE}`]
    for (const part of parts.slice(0, 2)) {
      ws.frame(part, { credit: part.length })
      expect(term.dataWrites()).toEqual([])
      expect(credits(ws)).toContain(part.length)
    }

    // Only the close marker releases the whole repaint, clear included.
    ws.frame(parts[2]!, { credit: parts[2]!.length })
    expect(term.dataWrites()).toEqual([`${CLEAR}${OPEN}${body}\n${CLOSE}`])
    expect(histories(ws)).toEqual([])
    // The closing chunk's credit waits for the write callback.
    expect(credits(ws)).not.toContain(parts[2]!.length)
    // A repaint's own intermediate viewport jump (the clear's baseY 0) while the
    // write is in flight is not the reader seeking: no history refetch, no unpin.
    Object.assign(term.buffer.active, { viewportY: 0, baseY: 0 })
    term.viewportEl.dispatchEvent(new Event('scroll'))
    term.onScrollCb?.(0)
    expect(histories(ws)).toEqual([])
    Object.assign(term.buffer.active, { viewportY: 40, baseY: 40, cursorY: 59 })
    term.flushWrites()
    await nextTick()
    expect(credits(ws)).toContain(parts[2]!.length)
    // The view is back on the live tail: the terminal owns its size here, so
    // the tail is baseY itself.
    expect(windowTop(term)).toBe(40)
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
    expect(histories(ws)).toEqual([])
    // The trailing DOM scroll of the write, still at the tail: never an unpin.
    term.buffer.active.viewportY = term.buffer.active.baseY
    term.viewportEl.dispatchEvent(new Event('scroll'))
    expect(windowTop(term)).toBe(40)
    expect(histories(ws)).toEqual([])
  } finally {
    ctl.dispose()
    host.remove()
    wrapper.unmount()
  }
})

it('returns credit for chunks held past the 256 KiB server window', async () => {
  const { ctl, term, ws, host, wrapper } = await setup()
  try {
    ws.receive({ type: 'terminal.frame', full: true, width: 200, height: 60, bytes: '' })
    const chunk = 'A'.repeat(200 * 1024)
    ws.frame(`${OPEN}${chunk}`, { credit: 200 * 1024 })
    ws.frame(chunk, { credit: 200 * 1024 })
    expect(term.dataWrites()).toEqual([])
    const returned = credits(ws)
    expect(returned).toContain(200 * 1024)
    expect(returned.reduce((a, b) => a + Number(b), 0)).toBeGreaterThan(256 * 1024)
    ws.frame(CLOSE, { credit: CLOSE.length })
    expect(term.dataWrites()).toHaveLength(1)
    term.flushWrites()
  } finally {
    ctl.dispose()
    host.remove()
    wrapper.unmount()
  }
})

it('does not jump the watched window mid-frame: a cursor-up chunk stays held until the close', async () => {
  const { ctl, term, ws, host, wrapper } = await setup(false)
  try {
    ws.frame('settled', { credit: 7 })
    term.flushWrites()
    const tail = windowTop(term)
    expect(tail).toBe(70)

    ws.frame(`${OPEN}\x1b[30A`, { credit: 12 })
    // The cursor-up never reaches xterm, so the window cannot jump.
    expect(term.dataWrites()).toEqual(['settled'])
    expect(windowTop(term)).toBe(tail)

    ws.frame(`${'\n'.repeat(30)}${CLOSE}`, { credit: 31 })
    expect(term.dataWrites()).toHaveLength(2)
    // Still not moved: the write callback has not run.
    expect(windowTop(term)).toBe(tail)
    // Simulate xterm applying the 30 newlines while the write is in flight.
    Object.assign(term.buffer.active, { baseY: 70, viewportY: 70 })
    term.onScrollCb?.(70)
    term.flushWrites()
    await nextTick()
    // Placed once, at the new tail (baseY 70 + the 30-row host remainder).
    expect(windowTop(term)).toBe(100)
  } finally {
    ctl.dispose()
    host.remove()
    wrapper.unmount()
  }
})
