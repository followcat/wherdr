import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createTerminal } from '~/composables/useTerminal'
import { terminalRenderer } from '~/composables/useHerdr'

// A full-screen app on the alternate screen keeps its history to itself:
// xterm has no rows to move, so a scroll has to reach the app as the mouse
// wheel it asked for.
const h1 = vi.hoisted(() => ({ terms: [] as FakeTerm[], fit: { cols: 80, rows: 24 } as { cols: number, rows: number } | null }))

type Params = (number | number[])[]

class FakeTerm {
  cols = 80
  rows = 24
  options: Record<string, unknown> = { fontFamily: 'monospace', fontSize: 13, theme: {} }
  textarea = document.createElement('textarea')
  element = document.createElement('div')
  modes = { mouseTrackingMode: 'any' }
  buffer = { active: { type: 'alternate', viewportY: 0, baseY: 0, length: 24, cursorY: 0 } }
  csi: { id: { prefix?: string, final: string }, fn: (p: Params) => boolean }[] = []
  parser = {
    registerCsiHandler: (id: { prefix?: string, final: string }, fn: (p: Params) => boolean) => {
      this.csi.push({ id, fn })
      return { dispose() {} }
    },
  }

  constructor(init?: Record<string, unknown>) {
    if (init) Object.assign(this.options, init)
    h1.terms.push(this)
    this.element.append(this.textarea)
  }

  // The bytes the app printed: DECSET (h) or DECRST (l) of these private modes.
  private(final: 'h' | 'l', ...modes: number[]) {
    for (const c of this.csi) if (c.id.prefix === '?' && c.id.final === final) c.fn(modes)
  }

  open(host: HTMLElement) { host.append(this.element) }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows }
  focus() { this.textarea.focus() }
  write(_d: unknown, cb?: () => void) { cb?.() }
  loadAddon() {} dispose() {} refresh() {} reset() {}
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

function setup(input?: () => boolean) {
  let ctl!: ReturnType<typeof createTerminal>
  const wrapper = mount(defineComponent({
    setup() {
      ctl = createTerminal('w1:p1', { setBanner: () => {}, hasBanner: () => false, input })
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
    const ws = FakeSocket.all.at(-1)!
    ws.open()
    ws.receive({ type: 'web.capabilities', core: true })
    ws.receive({ type: 'terminal.control', on: true })
    return { ws, term: h1.terms.at(-1)! }
  }
  return { ctl, open, wrapper }
}

const typed = (ws: FakeSocket) => ws.sent.filter(m => m.type === 'terminal.input').map(m => m.text)
const UP = '\x1b[<64;41;13M'
const DOWN = '\x1b[<65;41;13M'

beforeEach(() => {
  h1.terms.length = 0
  FakeSocket.all.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => { vi.unstubAllGlobals() })

it('a scroll on a full-screen app reaches it as the wheel it asked for', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const { ws, term } = await open()
    term.private('h', 1000, 1002, 1006)
    expect(ctl.scroll(3)).toBe(true)
    expect(ctl.scroll(-2)).toBe(true)
    expect(typed(ws)).toEqual([UP.repeat(3), DOWN.repeat(2)])
  } finally { wrapper.unmount() }
})

it('a wheel report is not typing: the gesture sending it carries on', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const { term } = await open()
    term.private('h', 1006)
    const before = ctl.scrollInputVersion.value
    ctl.scroll(1)
    expect(ctl.scrollInputVersion.value).toBe(before)
  } finally { wrapper.unmount() }
})

it('the normal screen still scrolls locally', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const { ws, term } = await open()
    term.private('h', 1006)
    term.buffer.active.type = 'normal'
    ctl.scroll(3)
    expect(typed(ws)).toEqual([])
  } finally { wrapper.unmount() }
})

it('an app that takes no wheel gets nothing', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const { ws, term } = await open()
    term.private('h', 1006)
    term.modes.mouseTrackingMode = 'none'
    ctl.scroll(3)
    term.modes.mouseTrackingMode = 'x10'
    ctl.scroll(3)
    expect(typed(ws)).toEqual([])
  } finally { wrapper.unmount() }
})

it('an app that did not ask for SGR reports gets nothing it could misread', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const { ws, term } = await open()
    ctl.scroll(1)
    term.private('h', 1006)
    term.private('l', 1006)
    ctl.scroll(1)
    expect(typed(ws)).toEqual([])
  } finally { wrapper.unmount() }
})

it('a closed input gate stops the wheel too', async () => {
  const { ctl, open, wrapper } = setup(() => false)
  try {
    const { ws, term } = await open()
    term.private('h', 1006)
    expect(ctl.scroll(1)).toBe(false)
    expect(typed(ws)).toEqual([])
  } finally { wrapper.unmount() }
})

it('a new socket learns the modes again from its own first paint', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const { ws, term } = await open()
    term.private('h', 1006)
    ws.close()
    ctl.connect(false)
    const next = FakeSocket.all.at(-1)!
    next.open()
    next.receive({ type: 'web.capabilities', core: true })
    ctl.scroll(1)
    expect(typed(next)).toEqual([])
    term.private('h', 1006)
    ctl.scroll(1)
    expect(typed(next)).toEqual([UP])
  } finally { wrapper.unmount() }
})
