import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createTerminal, REPAINT_SETTLE_MS } from '~/composables/useTerminal'
import { terminalRenderer } from '~/composables/useHerdr'
import { kbOpen } from '~/composables/useViewport'

// Debounced WebGL atlas + viewport repaint after resize bursts (core, local,
// or WebGL canvas backing-store change) and once after layout settles when the
// phone keyboard opens or closes.
const state = vi.hoisted(() => ({
  terms: [] as FakeTerm[],
  webgls: [] as FakeWebglAddon[],
  fit: { cols: 47, rows: 40 } as { cols: number, rows: number } | undefined,
}))

class FakeTerm {
  cols = 80
  rows = 24
  options: Record<string, unknown> = { fontFamily: 'monospace', fontSize: 13, theme: {} }
  textarea = document.createElement('textarea')
  element = document.createElement('div')
  screen = document.createElement('div')
  modes = { mouseTrackingMode: 'none' }
  buffer = { active: { viewportY: 0, baseY: 0, length: 0, cursorY: 0 } }
  atlasClears = 0
  refreshes = 0
  constructor(init?: Record<string, unknown>) {
    if (init) Object.assign(this.options, init)
    state.terms.push(this)
    this.screen.className = 'xterm-screen'
    Object.defineProperty(this.screen, 'offsetHeight', { configurable: true, get: () => this.rows * 16 })
    this.element.append(this.screen, this.textarea)
  }
  open(host: HTMLElement) { host.append(this.element) }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows }
  focus() { this.textarea.focus() }
  write(_d: unknown, cb?: () => void) { cb?.() }
  loadAddon() {}
  dispose() {}
  refresh() { this.refreshes++ }
  clearTextureAtlas() { this.atlasClears++ }
  reset() {}
  parser = { registerCsiHandler: () => ({ dispose() {} }), registerEscHandler: () => ({ dispose() {} }) }
  registerMarker(offset = 0) {
    const b = this.buffer.active
    return { line: b.baseY + b.cursorY + offset, isDisposed: false, dispose() { this.isDisposed = true }, onDispose() { return { dispose() {} } } }
  }
  attachCustomWheelEventHandler() {}
  attachCustomKeyEventHandler() {}
  onData() {}
  onBinary() {}
  onScroll() {}
  scrollToLine() {}
}

class FakeWebglAddon {
  _renderer = {
    _canvas: { width: 470, height: 640 },
    dimensions: { device: { canvas: { width: 470, height: 640 } } },
    _setCanvasDevicePixelDimensions(w: number, h: number) {
      this._canvas.width = w
      this._canvas.height = h
    },
  }
  onContextLoss() { return { dispose() {} } }
  dispose() {}
  constructor() { state.webgls.push(this) }
}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerm }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: FakeWebglAddon }))
vi.mock('~/utils/terminalSize', async importOriginal => ({ ...(await importOriginal() as object), proposeTerminalSize: () => state.fit }))
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

function setup(renderer: 'html' | 'webgl' = 'html') {
  let ctl!: ReturnType<typeof createTerminal>
  const wrapper = mount(defineComponent({
    setup() {
      ctl = createTerminal('w1:p1', { setBanner: () => {}, hasBanner: () => false })
      return () => h('div')
    },
  }), { attachTo: document.body })
  terminalRenderer.value = renderer
  const open = async () => {
    const parent = document.createElement('div')
    const el = document.createElement('div')
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 640 })
    parent.append(el)
    document.body.append(parent)
    expect(await ctl.mount(el)).toBe(true)
    await nextTick()
    ctl.fitNow(false)
    ctl.connect(false)
    const ws = FakeSocket.all.at(-1)!
    ws.open()
    return { ws, term: state.terms.at(-1)! }
  }
  return { ctl, open, wrapper }
}

beforeEach(() => {
  state.terms.length = 0
  state.webgls.length = 0
  state.fit = { cols: 47, rows: 40 }
  FakeSocket.all.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  kbOpen.value = false
  terminalRenderer.value = 'html'
})

describe('debounced terminal repaint', () => {
  it('coalesces a burst of core resizes into one repaint after the settle window', async () => {
    const { ctl, open, wrapper } = setup('webgl')
    try {
      const { ws, term } = await open()
      vi.useFakeTimers()
      // Clear any mount-time refresh counts before measuring the resize burst.
      vi.advanceTimersByTime(REPAINT_SETTLE_MS + 10)
      term.atlasClears = 0
      term.refreshes = 0

      ws.receive({ type: 'web.capabilities', core: true })
      ws.receive({ type: 'terminal.control', on: true })
      for (const rows of [36, 32, 28, 24]) {
        ws.receive({ type: 'terminal.frame', width: 60, height: rows, bytes: '' })
        vi.advanceTimersByTime(40)
        expect(term.atlasClears).toBe(0)
      }
      expect(term).toMatchObject({ cols: 60, rows: 24 })
      vi.advanceTimersByTime(REPAINT_SETTLE_MS - 41)
      expect(term.atlasClears).toBe(0)
      vi.advanceTimersByTime(2)
      expect(term.atlasClears).toBe(1)
      expect(term.refreshes).toBe(1)
    } finally { ctl.dispose(); wrapper.unmount() }
  })

  it('coalesces local fit resizes and WebGL canvas size changes into one settled repaint', async () => {
    const { ctl, open, wrapper } = setup('webgl')
    try {
      const { term } = await open()
      vi.useFakeTimers()
      vi.advanceTimersByTime(REPAINT_SETTLE_MS + 10)
      term.atlasClears = 0
      term.refreshes = 0

      // Local fit burst (non-core stream).
      for (const cols of [50, 54, 58]) {
        state.fit = { cols, rows: 30 }
        ctl.fitNow(true)
        vi.advanceTimersByTime(50)
        expect(term.atlasClears).toBe(0)
      }
      // Canvas backing-store resize inside the same settle window resets the debounce.
      const r = state.webgls[0]!._renderer
      r.dimensions.device.canvas = { width: 580, height: 480 }
      r._setCanvasDevicePixelDimensions(580, 480)
      vi.advanceTimersByTime(REPAINT_SETTLE_MS - 1)
      expect(term.atlasClears).toBe(0)
      vi.advanceTimersByTime(1)
      expect(term.atlasClears).toBe(1)
      expect(term.refreshes).toBe(1)
    } finally { ctl.dispose(); wrapper.unmount() }
  })

  it('repaints exactly once after a drag-like burst of resizes every 50 ms ends', async () => {
    const { ctl, open, wrapper } = setup('webgl')
    try {
      const { term } = await open()
      vi.useFakeTimers()
      vi.advanceTimersByTime(REPAINT_SETTLE_MS + 10)
      term.atlasClears = 0
      term.refreshes = 0

      // A divider drag fits every 50 ms (TerminalView's throttle).
      for (const cols of [48, 50, 52, 54, 56, 58]) {
        state.fit = { cols, rows: 30 }
        ctl.fitNow(true)
        vi.advanceTimersByTime(50)
        expect(term.atlasClears).toBe(0)
      }
      // One settle window after the last fit, one repaint (the loop already
      // waited 50 ms after that last fit).
      vi.advanceTimersByTime(REPAINT_SETTLE_MS - 51)
      expect(term.atlasClears).toBe(0)
      vi.advanceTimersByTime(1)
      expect(term.atlasClears).toBe(1)
      expect(term.refreshes).toBe(1)
      // Nothing more later.
      vi.advanceTimersByTime(REPAINT_SETTLE_MS * 3)
      expect(term.atlasClears).toBe(1)
    } finally { ctl.dispose(); wrapper.unmount() }
  })

  it('repaints once after layout settles when kbOpen opens or closes without a grid resize', async () => {
    const { ctl, open, wrapper } = setup('webgl')
    try {
      const { term } = await open()
      vi.useFakeTimers()
      vi.advanceTimersByTime(REPAINT_SETTLE_MS + 10)
      term.atlasClears = 0
      term.refreshes = 0

      kbOpen.value = true
      await nextTick()
      expect(term.atlasClears).toBe(0)
      vi.advanceTimersByTime(20)
      expect(term.atlasClears).toBe(1)
      expect(term.refreshes).toBe(1)

      kbOpen.value = false
      await nextTick()
      expect(term.atlasClears).toBe(1)
      vi.advanceTimersByTime(20)
      expect(term.atlasClears).toBe(2)
      expect(term.refreshes).toBe(2)
    } finally { ctl.dispose(); wrapper.unmount() }
  })
})
