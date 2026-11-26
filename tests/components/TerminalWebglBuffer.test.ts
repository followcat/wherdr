import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createTerminal } from '~/composables/useTerminal'
import { desk, terminalRenderStatus, terminalRenderer } from '~/composables/useHerdr'

// A grid can want a WebGL canvas the browser cannot give it a drawing buffer
// for: on a DPR 4 phone a 200×120 pane asked for 5600×7680, and Chrome clamped
// the buffer to 4918×6745. The add-on then draws as if it were full size and
// nothing reaches the screen — the prompt is there in the buffer, invisible.
// The view must fall back to xterm's DOM renderer for such a grid, and come
// back to WebGL once the grid shrinks enough (Fit to this screen).
const h1 = vi.hoisted(() => ({
  terms: [] as FakeTerm[],
  fit: { cols: 50, rows: 35 } as { cols: number, rows: number } | undefined,
  canvas: { width: 5600, height: 7680 },
  buffer: { width: 4918, height: 6745 },
  addons: [] as FakeWebgl[],
}))

class FakeWebgl {
  disposed = false
  // What the add-on's renderer exposes: the canvas it asked for and the
  // drawing buffer the browser actually granted.
  _renderer = {
    _canvas: { width: h1.canvas.width, height: h1.canvas.height },
    _gl: { drawingBufferWidth: h1.buffer.width, drawingBufferHeight: h1.buffer.height },
  }
  constructor() { h1.addons.push(this) }
  onContextLoss() {}
  clearTextureAtlas() {}
  dispose() { this.disposed = true }
}

class FakeTerm {
  cols = 80
  rows = 24
  options: Record<string, unknown> = { fontFamily: 'monospace', fontSize: 13, theme: {} }
  textarea = document.createElement('textarea')
  element = document.createElement('div')
  screen = document.createElement('div')
  modes = { mouseTrackingMode: 'none' }
  buffer = { active: { viewportY: 0, baseY: 0, length: 0, cursorY: 0 } }
  refreshes: [number, number][] = []
  _core = { _renderService: { dimensions: { css: { cell: { width: 7, height: 16 } } } } }
  constructor(init?: Record<string, unknown>) {
    if (init) Object.assign(this.options, init)
    h1.terms.push(this)
    this.screen.className = 'xterm-screen'
    Object.defineProperty(this.screen, 'offsetHeight', { configurable: true, get: () => this.rows * 16 })
    this.element.append(this.screen, this.textarea)
  }
  open(host: HTMLElement) { host.append(this.element) }
  resize(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    for (const a of h1.addons) {
      if (!a.disposed) {
        a._renderer._canvas.width = h1.canvas.width
        a._renderer._canvas.height = h1.canvas.height
        a._renderer._gl.drawingBufferWidth = h1.buffer.width
        a._renderer._gl.drawingBufferHeight = h1.buffer.height
      }
    }
  }
  focus() { this.textarea.focus() }
  write(_d: unknown, cb?: () => void) { cb?.() }
  loadAddon() {} dispose() {}
  refresh(start: number, end: number) { this.refreshes.push([start, end]) }
  clearTextureAtlas() {} reset() {}
  parser = { registerCsiHandler: () => ({ dispose() {} }), registerEscHandler: () => ({ dispose() {} }) }
  registerMarker(offset = 0) {
    const b = this.buffer.active
    return { line: b.baseY + b.cursorY + offset, isDisposed: false, dispose() { this.isDisposed = true }, onDispose() { return { dispose() {} } } }
  }
  attachCustomWheelEventHandler() {} attachCustomKeyEventHandler() {}
  onData() {} onBinary() {} onScroll() {}
  scrollToLine() {}
}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerm }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: FakeWebgl }))
vi.mock('~/utils/terminalSize', async importOriginal => ({ ...(await importOriginal() as object), proposeTerminalSize: () => h1.fit }))
vi.mock('~/utils/terminalMouse', () => ({ bindTerminalMouse: () => ({ dispose() {} }) }))
vi.mock('~/utils/terminalSelection', () => ({ bindTerminalSelection: () => () => {} }))
vi.mock('~/utils/terminalLinks', () => ({ bindTerminalLinks: () => ({ dispose() {} }) }))
vi.mock('~/utils/terminalOsc52', () => ({ OSC52_MAX_BYTES: 1000, bindTerminalOsc52: () => () => {} }))
vi.mock('~/utils/terminalFont', async importOriginal => ({ ...(await importOriginal() as object), TERM_FONT: 'monospace', onFontsLoaded: () => () => {} }))

class FakeSocket {
  static all: FakeSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  sent: Record<string, unknown>[] = []
  constructor(public url: string) { FakeSocket.all.push(this) }
  send(s: string) { this.sent.push(JSON.parse(s)) }
  close() { this.readyState = 3; this.onclose?.() }
  open() { this.readyState = 1; this.onopen?.() }
  receive(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }) }
}

function makeHost() {
  const parent = document.createElement('div')
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 640 })
  parent.append(el)
  document.body.append(parent)
  return el
}

async function openWebgl() {
  let ctl!: ReturnType<typeof createTerminal>
  const wrapper = mount(defineComponent({
    setup() {
      ctl = createTerminal('w1:p1', { setBanner: () => {}, hasBanner: () => false })
      return () => h('div')
    },
  }), { attachTo: document.body })
  expect(await ctl.mount(makeHost())).toBe(true)
  return { ctl, wrapper, term: h1.terms[0]! }
}

beforeEach(() => {
  h1.terms.length = 0
  h1.addons.length = 0
  h1.canvas = { width: 5600, height: 7680 }
  h1.buffer = { width: 4918, height: 6745 }
  h1.fit = { cols: 50, rows: 35 }
  FakeSocket.all.length = 0
  desk.value = false
  terminalRenderer.value = 'webgl'
  terminalRenderStatus.value = null
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('devicePixelRatio', 4)
})
afterEach(() => {
  vi.unstubAllGlobals()
  desk.value = false
  terminalRenderer.value = 'html'
})

it('falls back to the DOM renderer when the drawing buffer is clamped', async () => {
  const { ctl, wrapper, term } = await openWebgl()
  try {
    // The add-on loaded, found its buffer smaller than its canvas, and the
    // view dropped it: the grid is drawn by xterm's DOM renderer instead.
    expect(h1.addons).toHaveLength(1)
    expect(h1.addons[0]!.disposed).toBe(true)
    expect(terminalRenderStatus.value).toBe('html-fallback')
    expect(term.refreshes.length).toBeGreaterThan(0)
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('brings WebGL back once the grid shrinks under the safe size', async () => {
  const { ctl, wrapper, term } = await openWebgl()
  try {
    expect(terminalRenderStatus.value).toBe('html-fallback')
    // Fit to this screen: the pane becomes this screen's grid, and its canvas
    // fits the buffer the browser grants.
    h1.canvas = { width: 1400, height: 1920 }
    h1.buffer = { width: 1400, height: 1920 }
    h1.fit = { cols: 50, rows: 30 }
    term.cols = 50
    term.rows = 30
    await nextTick()
    ctl.fitNow(true)
    await vi.waitFor(() => expect(terminalRenderStatus.value).toBe('webgl'))
    expect(h1.addons).toHaveLength(2)
    expect(h1.addons[1]!.disposed).toBe(false)
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('drops WebGL when a core frame resizes over the safe pixel cap and restores it after shrink', async () => {
  h1.canvas = { width: 1400, height: 1920 }
  h1.buffer = { width: 1400, height: 1920 }
  h1.fit = { cols: 50, rows: 30 }
  const { ctl, wrapper, term } = await openWebgl()
  try {
    expect(terminalRenderStatus.value).toBe('webgl')
    expect(h1.addons).toHaveLength(1)
    expect(h1.addons[0]!.disposed).toBe(false)

    ctl.connect(false)
    const ws = FakeSocket.all.at(-1)!
    ws.open()
    ws.receive({ type: 'web.capabilities', core: true })
    ws.receive({ type: 'terminal.control', on: false })

    // Core sends a 200×120 grid: even if the buffer is not clamped, its pixel
    // count (5600×7680) exceeds MAX_WEBGL_PIXELS, so WebGL is dropped.
    h1.canvas = { width: 5600, height: 7680 }
    h1.buffer = { width: 5600, height: 7680 }
    term.refreshes.length = 0
    ws.receive({ type: 'terminal.frame', width: 200, height: 120, bytes: '' })
    expect(h1.addons[0]!.disposed).toBe(true)
    expect(terminalRenderStatus.value).toBe('html-fallback')
    expect(term.refreshes).toContainEqual([0, 119])

    // Shrinking slightly while still above MAX_WEBGL_PIXELS does not re-create the add-on.
    ws.receive({ type: 'terminal.frame', width: 180, height: 100, bytes: '' })
    expect(h1.addons).toHaveLength(1)

    // Fit to this screen shrinks the core grid back under the cap.
    h1.canvas = { width: 1400, height: 1920 }
    h1.buffer = { width: 1400, height: 1920 }
    ws.receive({ type: 'terminal.control', on: true })
    ws.receive({ type: 'terminal.frame', width: 50, height: 30, bytes: '' })
    await vi.waitFor(() => expect(terminalRenderStatus.value).toBe('webgl'))
    expect(h1.addons).toHaveLength(2)
    expect(h1.addons[1]!.disposed).toBe(false)
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('resets dropped state on remount', async () => {
  const { ctl, wrapper } = await openWebgl()
  try {
    expect(terminalRenderStatus.value).toBe('html-fallback')
    ctl.dispose()
    h1.canvas = { width: 1400, height: 1920 }
    h1.buffer = { width: 1400, height: 1920 }
    h1.fit = { cols: 50, rows: 30 }
    expect(await ctl.mount(makeHost())).toBe(true)
    expect(terminalRenderStatus.value).toBe('webgl')
    expect(h1.addons).toHaveLength(2)
    expect(h1.addons[1]!.disposed).toBe(false)
  } finally { ctl.dispose(); wrapper.unmount() }
})
