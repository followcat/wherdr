import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createTerminal } from '~/composables/useTerminal'
import { setToaster, smoothTouchScrolling, terminalRenderer } from '~/composables/useHerdr'

// The controller gates user input while the phone copy surface is open, but
// never the stream itself: frames, credit and lifecycle keep flowing, and an
// IME composition lifecycle (including its deferred commit) keeps its exact
// text and order.
const hoisted = vi.hoisted(() => ({
  terminals: [] as FakeTerm[],
  release: () => {},
  rows: [{ text: 'ab  ' }, { text: 'cd' }] as { text?: string, wrapped?: boolean }[],
}))

interface FakeCell {
  ch?: string
  width?: number
}
const cell = (c: FakeCell = {}) => ({
  getWidth: () => c.width ?? 1,
  getChars: () => c.ch ?? '',
  isFgRGB: () => false, isBgRGB: () => false, isFgPalette: () => false, isBgPalette: () => false,
  getFgColor: () => 0, getBgColor: () => 0,
  isInverse: () => 0, isInvisible: () => 0, isBold: () => 0, isDim: () => 0,
  isItalic: () => 0, isUnderline: () => 0, isStrikethrough: () => 0,
})

class FakeTerm {
  cols = 4
  rows = 2
  options: Record<string, unknown> = { fontFamily: 'monospace', fontSize: 13, theme: {} }
  textarea = document.createElement('textarea')
  element = document.createElement('div')
  buffer = {
    active: {
      viewportY: 0, baseY: 0, length: 2, cursorY: 0,
      getLine: (y: number) => {
        const r = hoisted.rows[y]
        if (!r) return undefined
        const cells = [...(r.text ?? '')].map(ch => ({ ch }))
        return { isWrapped: !!r.wrapped, length: 4, getCell: (x: number) => cell(cells[x]) }
      },
    },
  }
  onDataCb: ((d: string) => void) | null = null
  onBinaryCb: ((d: string) => void) | null = null
  constructor() { hoisted.terminals.push(this); this.element.appendChild(this.textarea) }
  loadAddon() {} open() {} focus() {} dispose() {} refresh() {} reset() {} resize() {} scrollLines() {}
  attachCustomWheelEventHandler() {} attachCustomKeyEventHandler() {}
  onData(fn: (d: string) => void) { this.onDataCb = fn }
  onBinary(fn: (d: string) => void) { this.onBinaryCb = fn }
  write(_d: string | Uint8Array, cb?: () => void) { cb?.() }
}

vi.mock('~/utils/xtermLoader', () => ({
  loadXterm: () => new Promise((resolve) => {
    hoisted.release = () => resolve({ Terminal: FakeTerm, FitAddon: class { proposeDimensions() { return null } } })
  }),
  loadWebgl: () => Promise.resolve({ WebglAddon: class { onContextLoss() {} dispose() {} } }),
}))
vi.mock('~/composables/useAppVersion', () => ({ reloadIfNewBuild: vi.fn(async () => false) }))
vi.mock('~/utils/terminalRenderer', async orig => ({ ...await orig<object>(), guardWebglCanvasSize: () => {} }))
vi.mock('~/utils/terminalMouse', () => ({ bindTerminalMouse: () => ({ dispose() {}, tap: vi.fn() }), terminalCell: () => null }))
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

let allowed = true
const sockets = () => FakeSocket.all
const b64 = (s: string) => btoa(s)

async function setup() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  let ctl!: ReturnType<typeof createTerminal>
  const wrapper = mount(defineComponent({
    setup() {
      ctl = createTerminal('w1:p1', { setBanner: () => {}, hasBanner: () => false, input: () => allowed })
      return () => h('div')
    },
  }), { attachTo: document.body })
  terminalRenderer.value = 'html'
  const ready = ctl.mount(host)
  hoisted.release()
  expect(await ready).toBe(true)
  ctl.connect(false)
  const ws = sockets().at(-1)!
  ws.open()
  ws.receive({ type: 'web.capabilities', core: true, mouse: true })
  ws.receive({ type: 'terminal.frame', bytes: b64('frame'), credit: 40, full: true })
  const term = hoisted.terminals.at(-1)!
  return { ctl, ws, term, wrapper }
}

beforeEach(() => {
  allowed = true
  hoisted.terminals.length = 0
  FakeSocket.all.length = 0
  hoisted.rows = [{ text: 'ab  ' }, { text: 'cd' }]
  smoothTouchScrolling.value = false
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => {
  smoothTouchScrolling.value = false
  localStorage.removeItem('smoothTouchScrolling')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('copy-mode input gate', () => {
  it('lets user input through normally and stops it while copying', async () => {
    const { ctl, ws, term, wrapper } = await setup()
    term.onDataCb!('a')
    expect(ws.messages()).toContainEqual({ type: 'terminal.input', text: 'a' })
    allowed = false // copy surface open
    term.onDataCb!('b')
    term.onBinaryCb!('\x03')
    await ctl.sendKeys(['ctrl+c'])
    await ctl.sendVirtualKey('esc')
    expect(ctl.sendTerm({ type: 'paste', text: '/home/user/i.png' })).toBe(false)
    expect(ws.messages().filter(m => m.type === 'terminal.input' || m.type === 'keys' || m.type === 'paste')).toHaveLength(1)
    allowed = true
    term.onDataCb!('c')
    expect(ws.messages()).toContainEqual({ type: 'terminal.input', text: 'c' })
    ctl.dispose(); wrapper.unmount()
  })

  it('keeps frames, credit and lifecycle flowing while input is gated', async () => {
    const { ctl, ws, wrapper } = await setup()
    allowed = false
    ws.receive({ type: 'terminal.frame', bytes: b64('more'), credit: 12 })
    expect(ws.messages()).toContainEqual({ type: 'credit', bytes: 12 })
    expect(ctl.isConnected()).toBe(true)
    ctl.setVisible(false)
    expect(ws.messages()).toContainEqual({ type: 'visibility', visible: false })
    ctl.dispose(); wrapper.unmount()
  })

  it('captures the visible screen for the frozen layer', async () => {
    const { ctl, wrapper } = await setup()
    const snap = ctl.captureScreen()
    expect(snap?.columns).toBe(4)
    expect(snap?.fontFamily).toBe('monospace')
    expect(snap?.lines.map(l => l.map(s => s.text).join('')).join('\n')).toBe('ab\ncd')
    ctl.dispose(); wrapper.unmount()
  })
})

describe('IME composition lifecycle under the gate', () => {
  it('keeps commits as text, refuses capture while a commit is pending, never sends early', async () => {
    const { ctl, ws, term, wrapper } = await setup()
    const ta = term.textarea!
    ta.dispatchEvent(new Event('compositionstart'))
    // An active composition already refuses the frozen capture.
    expect(ctl.captureScreen()).toBeNull()
    term.onDataCb!('你')
    expect(ws.messages()).toContainEqual({ type: 'terminal.input', text: '你' })
    ta.dispatchEvent(new Event('compositionend'))
    // Deferred commit pending: capture stays refused, nothing is sent early,
    // and refusing twice proves the peek never consumed the flag.
    expect(ctl.captureScreen()).toBeNull()
    expect(ctl.captureScreen()).toBeNull()
    ctl.toggleModifier('ctrl')
    term.onDataCb!('好')
    const inputs = ws.messages().filter(m => m.type === 'terminal.input')
    expect(inputs).toEqual([{ type: 'terminal.input', text: '你' }, { type: 'terminal.input', text: '好' }])
    // The committed candidate stays text: it never spends the armed modifier.
    expect(ctl.virtualModifiers.value).toEqual([])
    // The flag is consumed by that commit: a fresh capture is allowed again.
    expect(ctl.captureScreen()?.lines.map(l => l.map(s => s.text).join('')).join('\n')).toBe('ab\ncd')
    ctl.dispose(); wrapper.unmount()
  })

  it('sends a deferred commit once, as exact text, even across a gate change', async () => {
    const { ctl, ws, term, wrapper } = await setup()
    const ta = term.textarea!
    ta.dispatchEvent(new Event('compositionstart'))
    term.onDataCb!('中')
    ta.dispatchEvent(new Event('compositionend'))
    // The surface asks and is refused: the pending commit keeps its flag.
    expect(ctl.captureScreen()).toBeNull()
    term.onDataCb!('文')
    expect(ws.messages().filter(m => m.type === 'terminal.input')).toEqual([
      { type: 'terminal.input', text: '中' },
      { type: 'terminal.input', text: '文' },
    ])
    // A later real keystroke after an empty composition is not swallowed.
    ta.dispatchEvent(new Event('compositionstart'))
    ta.dispatchEvent(new Event('compositionend'))
    term.element!.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))
    term.onDataCb!('x')
    expect(ws.messages().filter(m => m.type === 'terminal.input').at(-1)).toEqual({ type: 'terminal.input', text: 'x' })
    ctl.dispose(); wrapper.unmount()
  })

  it('lets capture resume after a cancelled composition settles, without a keystroke', async () => {
    const { ctl, ws, term, wrapper } = await setup()
    const ta = term.textarea!
    ta.dispatchEvent(new Event('compositionstart'))
    ta.dispatchEvent(new Event('compositionend'))
    // Still inside xterm's deferred finalize window: a real commit may land.
    expect(ctl.captureScreen()).toBeNull()
    // The finalize tick passes with no output — the candidate was cancelled.
    // The stale first-data flag alone must not keep refusing capture forever.
    await new Promise(r => setTimeout(r, 10))
    expect(ctl.captureScreen()?.columns).toBe(4)
    expect(ws.messages().filter(m => m.type === 'terminal.input')).toHaveLength(0)
    // The stale guard itself is untouched: data that does arrive late still
    // takes the commit path, clearing an armed modifier instead of spending it.
    ctl.toggleModifier('ctrl')
    term.onDataCb!('x')
    expect(ws.messages().filter(m => m.type === 'terminal.input')).toEqual([{ type: 'terminal.input', text: 'x' }])
    expect(ctl.virtualModifiers.value).toEqual([])
    ctl.dispose(); wrapper.unmount()
  })

  it('keeps a commit after an empty-data compositionend exact, and the 229 guard intact', async () => {
    const { ctl, ws, term, wrapper } = await setup()
    const ta = term.textarea!
    ta.dispatchEvent(new Event('compositionstart'))
    // Chromium's compositionend.data is unreliable: a real commit can follow
    // an empty event. The tracker never reads it — the deferred textarea read
    // modelled by onData below is what decides.
    ta.dispatchEvent(new Event('compositionend'))
    expect(ctl.captureScreen()).toBeNull()
    const k229 = new KeyboardEvent('keydown', { bubbles: true })
    Object.defineProperty(k229, 'keyCode', { value: 229 })
    term.element!.dispatchEvent(k229)
    ctl.toggleModifier('ctrl')
    // The finalize tick delivers the text: once, exactly, never as a chord.
    term.onDataCb!('a')
    expect(ws.messages().filter(m => m.type === 'terminal.input')).toEqual([{ type: 'terminal.input', text: 'a' }])
    expect(ws.messages().filter(m => m.type === 'keys')).toEqual([])
    expect(ctl.virtualModifiers.value).toEqual([])
    // The commit consumed the window: capture opens without waiting for settle.
    expect(ctl.captureScreen()?.columns).toBe(4)
    // A subsequent ordinary keystroke still spends an armed modifier as a chord.
    ctl.toggleModifier('ctrl')
    term.element!.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))
    term.onDataCb!('x')
    expect(ws.messages().filter(m => m.type === 'keys')).toEqual([{ type: 'keys', keys: ['ctrl+x'] }])
    ctl.dispose(); wrapper.unmount()
  })
})

describe('armed-modifier input contract', () => {
  it('sends a transportable chord once as a named key, then spends nothing more', async () => {
    const { ctl, ws, term, wrapper } = await setup()
    ctl.toggleModifier('ctrl')
    ctl.toggleModifier('alt')
    term.onDataCb!('\x1b[C')
    expect(ws.messages().filter(m => m.type === 'keys')).toEqual([{ type: 'keys', keys: ['ctrl+alt+right'] }])
    expect(ctl.virtualModifiers.value).toEqual([])
    expect(ctl.lastVirtualChord.value).toBe('Ctrl + Alt + →')
    // The very next input is plain text: the chord was spent exactly once.
    term.onDataCb!('x')
    expect(ws.messages().at(-1)).toEqual({ type: 'terminal.input', text: 'x' })
    ctl.dispose(); wrapper.unmount()
  })

  it('keeps unrepresentable input as exact data, warns once and calls no key', async () => {
    const added: { title?: string }[] = []
    setToaster({ clear: vi.fn(), add: (o: { title?: string }) => { added.push(o) } } as never)
    const { ctl, ws, term, wrapper } = await setup()
    try {
      // Typed punctuation has no transportable chord name (`+` names `plus`,
      // which herdr-core cannot resolve); byte 29 is Ctrl+]. Composed text and
      // multi-character writes are not shortcuts either.
      for (const ch of [']', '+', '\x1d', 'é', 'ab']) {
        ctl.toggleModifier('ctrl')
        term.onDataCb!(ch)
        expect(ws.messages().at(-1)).toEqual({ type: 'terminal.input', text: ch })
        expect(ctl.virtualModifiers.value).toEqual([])
      }
      expect(ws.messages().filter(m => m.type === 'keys')).toEqual([])
      expect(added.map(a => a.title)).toEqual(new Array(5).fill('Chord not applied — text sent as typed'))
      // A bracketed paste stays quiet and still spends the armed modifiers.
      ctl.toggleModifier('ctrl')
      term.onDataCb!('\x1b[200~echo ok\x1b[201~')
      expect(ws.messages().at(-1)).toEqual({ type: 'terminal.input', text: '\x1b[200~echo ok\x1b[201~' })
      expect(ctl.virtualModifiers.value).toEqual([])
      expect(added).toHaveLength(5)
    } finally { setToaster(null as never); ctl.dispose(); wrapper.unmount() }
  })
})
