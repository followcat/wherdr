import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createTerminal } from '~/composables/useTerminal'
import { kbOpen } from '~/composables/useViewport'
import { terminalRenderer } from '~/composables/useHerdr'

// AgentView keeps one controller while TerminalView comes and goes with the
// Conversation/Terminal toggle, so every mount after the first runs on a
// controller that has already seen a stream.
const h1 = vi.hoisted(() => ({ terms: [] as FakeTerm[], fit: { cols: 47, rows: 40 } as { cols: number, rows: number } | undefined }))

class FakeTerm {
  cols = 80
  rows = 24
  options: Record<string, unknown> = { fontFamily: 'monospace', fontSize: 13, theme: {} }
  textarea = document.createElement('textarea')
  element = document.createElement('div')
  modes = { mouseTrackingMode: 'none' }
  buffer = { active: { viewportY: 0, baseY: 0, length: 0, cursorY: 0 } }
  constructor(init?: Record<string, unknown>) {
    if (init) Object.assign(this.options, init)
    h1.terms.push(this)
    this.element.append(this.textarea)
  }
  open(host: HTMLElement) { host.append(this.element) }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows }
  focus() { this.textarea.focus() }
  write(_d: unknown, cb?: () => void) { cb?.() }
  loadAddon() {} dispose() {} refresh() {} reset() {}
  parser = { registerCsiHandler: () => ({ dispose() {} }) }
  attachCustomWheelEventHandler() {} attachCustomKeyEventHandler() {}
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
  close() {
    this.readyState = 3
    this.onclose?.()
  }

  open() { this.readyState = 1; this.onopen?.() }
  receive(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }) }
  size() { const q = new URL(this.url, 'http://x').searchParams; return [q.get('cols'), q.get('rows')].map(Number) }
  resizes() { return this.sent.filter(m => m.type === 'terminal.resize').map(m => [m.cols, m.rows]) }
}

function setup() {
  let ctl!: ReturnType<typeof createTerminal>
  let banner: unknown = null
  const wrapper = mount(defineComponent({
    setup() {
      ctl = createTerminal('w1:p1', { setBanner: (b) => { banner = b }, hasBanner: () => banner !== null })
      return () => h('div')
    },
  }), { attachTo: document.body })
  terminalRenderer.value = 'html'
  const host = () => {
    const parent = document.createElement('div')
    const el = document.createElement('div')
    parent.append(el)
    document.body.append(parent)
    return el
  }
  // What TerminalView does on each mount.
  const open = async () => {
    expect(await ctl.mount(host())).toBe(true)
    await nextTick()
    ctl.fitNow(false)
    ctl.connect(false)
    return FakeSocket.all.at(-1)!
  }
  return { ctl, open, wrapper, banner: () => banner, clearBanner: () => { banner = null } }
}

// The attached stream of a core terminal.
function attach(ws: FakeSocket, control = true) {
  ws.open()
  ws.receive({ type: 'web.capabilities', core: true })
  ws.receive({ type: 'terminal.control', on: control })
}

beforeEach(() => {
  h1.terms.length = 0
  h1.fit = { cols: 47, rows: 40 }
  FakeSocket.all.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => {
  vi.unstubAllGlobals()
  kbOpen.value = false
})

it('reopening the terminal attaches at this screen\'s size, not xterm\'s default', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    attach(await open())
    ctl.dispose()
    const second = await open()
    expect(second.size()).toEqual([47, 40])
    expect(h1.terms[1]).toMatchObject({ cols: 47, rows: 40 })
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('a socket replaced while live still attaches at this screen\'s size', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const first = await open()
    attach(first)
    // Watching another viewer's larger grid when the socket is replaced.
    first.receive({ type: 'terminal.frame', width: 152, height: 50, bytes: '' })
    expect(h1.terms[0]!.cols).toBe(152)
    ctl.connect(false)
    expect(FakeSocket.all.at(-1)!.size()).toEqual([47, 40])
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('a fit measured while the socket connects reaches the server once it is open', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    // Cells not measured yet: the attach can only ask for xterm's default.
    h1.fit = undefined
    const ws = await open()
    expect(ws.size()).toEqual([80, 24])
    h1.fit = { cols: 47, rows: 40 }
    ctl.fitNow(true)
    ws.open()
    expect(ws.resizes()).toEqual([[47, 40]])
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('offers to fit again when the terminal reopens on another viewer\'s size', async () => {
  const { ctl, open, wrapper, banner, clearBanner } = setup()
  try {
    const first = await open()
    attach(first, false)
    first.receive({ type: 'terminal.frame', width: 152, height: 50, bytes: '' })
    expect(banner()).not.toBeNull()
    // AgentView drops the banner when the view goes back to the conversation.
    clearBanner()
    ctl.dispose()
    const second = await open()
    attach(second, false)
    second.receive({ type: 'terminal.frame', width: 152, height: 50, bytes: '' })
    expect(banner()).not.toBeNull()
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('still releases the terminal focus when the keyboard closes after a reopen', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  const { ctl, open, wrapper } = setup()
  try {
    attach(await open())
    ctl.dispose()
    attach(await open())
    kbOpen.value = true
    await nextTick()
    ctl.focus()
    expect(ctl.hasFocus()).toBe(true)
    kbOpen.value = false
    await nextTick()
    expect(ctl.hasFocus()).toBe(false)
  } finally { ctl.dispose(); wrapper.unmount() }
})
