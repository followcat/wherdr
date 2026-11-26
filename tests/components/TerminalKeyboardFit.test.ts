import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createTerminal } from '~/composables/useTerminal'
import { terminalRenderer } from '~/composables/useHerdr'
import { kbOpen } from '~/composables/useViewport'

// While the mobile keyboard covers the bottom of the pane and the user is typing
// elsewhere (e.g. the composer), a rows-only change keeps the pane unresized
// and shifts .xterm-screen so the cursor row stays visible above the keyboard.
const h1 = vi.hoisted(() => ({ terms: [] as FakeTerm[], fit: { cols: 47, rows: 40 } as { cols: number, rows: number } | undefined }))

class FakeTerm {
  cols = 80
  rows = 24
  options: Record<string, unknown> = { fontFamily: 'monospace', fontSize: 13, theme: {} }
  textarea = document.createElement('textarea')
  element = document.createElement('div')
  screen = document.createElement('div')
  modes = { mouseTrackingMode: 'none' }
  buffer = { active: { viewportY: 0, baseY: 0, length: 0, cursorY: 0 } }
  constructor(init?: Record<string, unknown>) {
    if (init) Object.assign(this.options, init)
    h1.terms.push(this)
    this.screen.className = 'xterm-screen'
    Object.defineProperty(this.screen, 'offsetHeight', { configurable: true, get: () => this.rows * 16 })
    this.element.append(this.screen, this.textarea)
  }
  open(host: HTMLElement) { host.append(this.element) }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows }
  focus() { this.textarea.focus() }
  write(_d: unknown, cb?: () => void) { cb?.() }
  loadAddon() {} dispose() {} refresh() {} clearTextureAtlas() {} reset() {}
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
  const open = async (clientHeight = 640) => {
    const parent = document.createElement('div')
    const el = document.createElement('div')
    let height = clientHeight
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => height })
    parent.append(el)
    document.body.append(parent)
    expect(await ctl.mount(el)).toBe(true)
    await nextTick()
    ctl.fitNow(false)
    ctl.connect(false)
    return { ws: FakeSocket.all.at(-1)!, el, parent, setHeight: (h: number) => { height = h } }
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
    const { ws } = await open()
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
    const { ws } = await open()
    ws.open()
    kbOpen.value = true
    ctl.kbdOn.value = true
    h1.fit = { cols: 47, rows: 30 }
    ctl.fitNow(true)
    expect(h1.terms[0]).toMatchObject({ cols: 47, rows: 30 })
    expect(ws.resizes()).toEqual([[47, 30]])
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('shifts .xterm-screen to keep the cursor row visible while covered, and resets when cleared or disposed', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const { ws, setHeight } = await open(640)
    ws.open()
    const term = h1.terms[0]!
    // Cursor sits in the lower rows that the keyboard will cover.
    term.buffer.active.cursorY = 35
    kbOpen.value = true
    setHeight(480)
    h1.fit = { cols: 47, rows: 30 }
    ctl.fitNow(true)
    expect(term.screen.style.transform).toBe('translateY(-96px)')

    // New output moves the cursor further down while covered.
    term.buffer.active.cursorY = 38
    ws.receive({ type: 'terminal.frame', width: 47, height: 40, bytes: '' })
    expect(term.screen.style.transform).toBe('translateY(-144px)')

    // Switching to type in the terminal clears covered and resets the shift.
    ctl.kbdOn.value = true
    await nextTick()
    expect(term.screen.style.transform).toBe('')
    ctl.kbdOn.value = false
    await nextTick()
    expect(term.screen.style.transform).toBe('translateY(-144px)')

    // Closing the keyboard clears the shift.
    kbOpen.value = false
    setHeight(640)
    h1.fit = { cols: 47, rows: 40 }
    ctl.fitNow(true)
    expect(term.screen.style.transform).toBe('')

    // Re-covering shifts again, dispose resets cleanly, and reopening on the same controller still watches kbdOn.
    kbOpen.value = true
    setHeight(480)
    h1.fit = { cols: 47, rows: 30 }
    ctl.fitNow(true)
    expect(term.screen.style.transform).toBe('translateY(-144px)')
    ctl.dispose()
    expect(term.screen.style.transform).toBe('')

    kbOpen.value = false
    ctl.kbdOn.value = false
    h1.fit = { cols: 47, rows: 40 }
    const reopened = await open(640)
    reopened.ws.open()
    const term2 = h1.terms[1]!
    term2.buffer.active.cursorY = 35
    kbOpen.value = true
    reopened.setHeight(480)
    h1.fit = { cols: 47, rows: 30 }
    ctl.fitNow(true)
    expect(term2.screen.style.transform).toBe('translateY(-96px)')
    ctl.kbdOn.value = true
    await nextTick()
    expect(term2.screen.style.transform).toBe('')
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('does not repaint the glyph atlas when the pane resizes', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const { ws } = await open()
    ws.open()
    const term = h1.terms[0]!
    const atlas = vi.spyOn(term, 'clearTextureAtlas')
    // A real geometry change (rotation: cols and rows, not a covered rows-only one).
    h1.fit = { cols: 60, rows: 30 }
    ctl.fitNow(true)
    expect(term).toMatchObject({ cols: 60, rows: 30 })
    expect(ws.resizes()).toEqual([[60, 30]])
    expect(atlas).not.toHaveBeenCalled()
  } finally { ctl.dispose(); wrapper.unmount() }
})

const liftPx = (term: FakeTerm) => {
  const m = /^translateY\(-([\d.]+)px\)$/.exec(term.screen.style.transform)
  return m ? Number(m[1]) : 0
}

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

it('skips zero-height or disconnected hosts, then keeps the cursor row inside a real host', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const { ws, el, parent, setHeight } = await open(0)
    ws.open()
    const term = h1.terms[0]!
    term.buffer.active.cursorY = 39

    // Zero-height host while covered must never lift the whole grid off-screen.
    kbOpen.value = true
    ctl.fitNow(true)
    await nextFrame()
    expect(term.screen.style.transform).toBe('')

    // Disconnected host is skipped too.
    parent.remove()
    setHeight(480)
    ctl.fitNow(true)
    expect(term.screen.style.transform).toBe('')

    // Once connected at a real height (480 px = 30 rows of 16 px), the cursor row stays inside [0, 480].
    document.body.append(parent)
    expect(el.isConnected).toBe(true)
    ctl.fitNow(true)
    const lift = liftPx(term)
    expect(lift).toBe(160)
    const cursorTop = term.buffer.active.cursorY * 16 - lift
    const cursorBottom = (term.buffer.active.cursorY + 1) * 16 - lift
    expect(cursorTop).toBeGreaterThanOrEqual(0)
    expect(cursorBottom).toBeLessThanOrEqual(480)
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('settles keyboard open and close after layout, ending with no transform even when watching', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const { ws, setHeight } = await open(640)
    ws.open()
    ws.receive({ type: 'web.capabilities', core: true })
    ws.receive({ type: 'terminal.control', on: false })
    const term = h1.terms[0]!
    term.rows = 40
    term.buffer.active.cursorY = 39

    // Keyboard opens: in the same tick layout is still 0/stale; layout settles before the frame.
    kbOpen.value = true
    setHeight(0)
    await nextTick()
    expect(term.screen.style.transform).toBe('')
    setHeight(16)
    await nextFrame()
    await nextFrame()
    expect(term.screen.style.transform).toBe('translateY(-624px)')

    // Keyboard closes: in the same tick the host still holds the 16 px covered height,
    // then layout restores 640 px on the frame -> no footer-only transform remains.
    kbOpen.value = false
    await nextTick()
    setHeight(640)
    await nextFrame()
    await nextFrame()
    expect(term.screen.style.transform).toBe('')
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('re-runs followCursor when the view becomes visible again at a real height', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const { ws, setHeight } = await open(640)
    ws.open()
    const term = h1.terms[0]!
    term.buffer.active.cursorY = 39

    // Covered while hidden: the host has no height, so nothing is projected.
    kbOpen.value = true
    setHeight(0)
    ctl.fitNow(true)
    expect(term.screen.style.transform).toBe('')

    // Visible again at 480 px: setVisible re-runs followCursor and the shift lands.
    setHeight(480)
    ctl.setVisible(true)
    await nextTick()
    await nextFrame()
    expect(term.screen.style.transform).toBe('translateY(-160px)')
  } finally { ctl.dispose(); wrapper.unmount() }
})
