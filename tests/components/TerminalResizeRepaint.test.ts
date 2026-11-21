import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createTerminal } from '~/composables/useTerminal'
import { terminalRenderer } from '~/composables/useHerdr'
import { kbOpen } from '~/composables/useViewport'

// A resize reallocates the WebGL canvas; on some GPUs the glyph atlas then
// shows noise until rebuilt. Every resize repaints instead of trusting it.
const h1 = vi.hoisted(() => ({ terms: [] as FakeTerm[], fit: { cols: 47, rows: 40 } as { cols: number, rows: number } | undefined }))

class FakeTerm {
  cols = 80
  rows = 24
  options: Record<string, unknown> = { fontFamily: 'monospace', fontSize: 13, theme: {} }
  textarea = document.createElement('textarea')
  element = document.createElement('div')
  modes = { mouseTrackingMode: 'none' }
  buffer = { active: { viewportY: 0, baseY: 0, length: 0, cursorY: 0 } }
  atlasClears = 0
  refreshes = 0
  constructor(init?: Record<string, unknown>) {
    if (init) Object.assign(this.options, init)
    h1.terms.push(this)
    this.element.append(this.textarea)
  }
  open(host: HTMLElement) { host.append(this.element) }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows }
  focus() { this.textarea.focus() }
  write(_d: unknown, cb?: () => void) { cb?.() }
  loadAddon() {} dispose() {}
  refresh() { this.refreshes++ }
  clearTextureAtlas() { this.atlasClears++ }
  reset() {}
  attachCustomWheelEventHandler() {} parser = { registerCsiHandler() {}, registerEscHandler() {} }; attachCustomKeyEventHandler() {}
  onData() {} onBinary() {} onScroll() {}
  scrollToLine() {}
}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerm }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }))
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
  resizes() { return this.sent.filter(m => m.type === 'terminal.resize').map(m => [m.cols, m.rows]) }
}

function setup() {
  let ctl!: ReturnType<typeof createTerminal>
  const wrapper = mount(defineComponent({
    setup() {
      ctl = createTerminal('w1:p1', { setBanner: () => {}, hasBanner: () => false })
      return () => h('div')
    },
  }), { attachTo: document.body })
  terminalRenderer.value = 'html'
  const open = async () => {
    const parent = document.createElement('div')
    const el = document.createElement('div')
    parent.append(el)
    document.body.append(parent)
    expect(await ctl.mount(el)).toBe(true)
    await nextTick()
    ctl.fitNow(false)
    ctl.connect(false)
    return FakeSocket.all.at(-1)!
  }
  return { ctl, open, wrapper }
}

beforeEach(() => {
  h1.terms.length = 0
  h1.fit = { cols: 47, rows: 40 }
  FakeSocket.all.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => { vi.unstubAllGlobals(); kbOpen.value = false })

it('the keyboard opening never resizes the pane for rows alone', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const ws = await open()
    ws.open()
    // Composer focused, keyboard sliding up: the window is shorter, nothing else moved.
    kbOpen.value = true
    h1.fit = { cols: 47, rows: 30 }
    ctl.fitNow(true)
    expect(h1.terms[0]).toMatchObject({ cols: 47, rows: 40 })
    expect(ws.resizes()).toEqual([])
    // Closing fits back to the same pane: still nothing to send.
    kbOpen.value = false
    h1.fit = { cols: 47, rows: 40 }
    ctl.fitNow(true)
    expect(ws.resizes()).toEqual([])
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('the keyboard resizes as usual while the terminal itself is typed in', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const ws = await open()
    ws.open()
    kbOpen.value = true
    ctl.kbdOn.value = true
    h1.fit = { cols: 47, rows: 30 }
    ctl.fitNow(true)
    expect(h1.terms[0]).toMatchObject({ cols: 47, rows: 30 })
    expect(ws.resizes()).toEqual([[47, 30]])
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('a core-driven resize repaints: the atlas is rebuilt, not trusted', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const ws = await open()
    ws.open()
    ws.receive({ type: 'web.capabilities', core: true })
    ws.receive({ type: 'terminal.control', on: true })
    ws.receive({ type: 'terminal.frame', width: 60, height: 20, bytes: '' })
    expect(h1.terms[0]).toMatchObject({ cols: 60, rows: 20 })
    expect(h1.terms[0]!.atlasClears).toBeGreaterThan(0)
    expect(h1.terms[0]!.refreshes).toBeGreaterThan(0)
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('a local fit to a new size repaints too', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const ws = await open()
    ws.open()
    h1.fit = { cols: 50, rows: 30 }
    ctl.fitNow(true)
    expect(h1.terms[0]).toMatchObject({ cols: 50, rows: 30 })
    expect(h1.terms[0]!.atlasClears).toBeGreaterThan(0)
    expect(h1.terms[0]!.refreshes).toBeGreaterThan(0)
  } finally { ctl.dispose(); wrapper.unmount() }
})
