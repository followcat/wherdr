import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createTerminal } from '~/composables/useTerminal'
import { kbOpen } from '~/composables/useViewport'
import { terminalRenderer } from '~/composables/useHerdr'
import { PARK_IDLE_MS } from '~/utils/terminalPark'
import { DEEP_FETCH_TIMEOUT_MS } from '~/utils/terminalDeepHistory'
import { COLD_HISTORY, MAX_HISTORY } from '#shared/terminalHistory'

// Parking a terminal instead of disposing it: the Conversation/Terminal toggle
// and a visit to another agent keep the xterm and its stream, so the next mount
// adopts them with no attach, no download and no repaint. The FakeTerm models
// the public xterm contract the controller uses: a buffer with rows, a viewport,
// markers and writes.
const h1 = vi.hoisted(() => ({ terms: [] as FakeTerm[], fit: { cols: 47, rows: 40 } as { cols: number, rows: number } | undefined }))

class FakeMarker {
  isDisposed = false
  constructor(public line: number) {}
  dispose() { this.isDisposed = true }
  onDispose() { return { dispose: () => {} } }
}

class FakeTerm {
  cols = 80
  rows = 24
  options: Record<string, unknown> = { fontFamily: 'monospace', fontSize: 13, theme: {}, scrollback: 0 }
  textarea = document.createElement('textarea')
  element = document.createElement('div')
  screen = document.createElement('div')
  modes = { mouseTrackingMode: 'none' }
  buffer = { active: { viewportY: 0, baseY: 0, length: 0, cursorY: 0, type: 'normal', getLine: () => undefined } }
  written: string[] = []
  csi: ((final: string) => void)[] = []
  constructor(init?: Record<string, unknown>) {
    if (init) Object.assign(this.options, init)
    h1.terms.push(this)
    this.screen.className = 'xterm-screen'
    this.element.append(this.screen, this.textarea)
  }
  open(host: HTMLElement) { host.append(this.element) }
  resize(cols: number, rows: number) { this.cols = cols; this.rows = rows }
  focus() { this.textarea.focus() }
  write(d: string | Uint8Array, cb?: () => void) {
    const text = typeof d === 'string' ? d : new TextDecoder().decode(d)
    if (text) this.written.push(text)
    cb?.()
  }
  loadAddon() {} dispose() {} refresh() {} clearTextureAtlas() {} reset() { this.written.length = 0 }
  parser = {
    // The controller watches DECSET 1006 through the parser: tests feed a mode.
    registerCsiHandler: (_spec: unknown, fn: (params: unknown[]) => boolean) => {
      this.csi.push(() => fn([1006]))
      return { dispose() {} }
    },
    registerEscHandler: () => ({ dispose() {} }),
  }
  attachCustomWheelEventHandler() {} attachCustomKeyEventHandler() {}
  onData() {} onBinary() {} onScroll() {}
  // xterm clamps a line to the buffer's scroll domain, as the controller's
  // followCursor relies on.
  scrollToLine(y: number) { this.buffer.active.viewportY = Math.max(0, Math.min(y, this.buffer.active.baseY)) }
  scrollToBottom() { this.buffer.active.viewportY = this.buffer.active.baseY }
  registerMarker = (offset = 0) => new FakeMarker(this.buffer.active.cursorY + offset)
}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerm }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }))
vi.mock('~/utils/terminalSize', async importOriginal => ({ ...(await importOriginal() as object), proposeTerminalSize: () => h1.fit }))
vi.mock('~/utils/terminalMouse', () => ({ bindTerminalMouse: () => ({ dispose() {}, tap() {} }) }))
vi.mock('~/utils/terminalSelection', () => ({ bindTerminalSelection: () => () => {} }))
vi.mock('~/utils/terminalLinks', () => ({ bindTerminalLinks: () => ({ dispose() {}, tap: () => false }) }))
vi.mock('~/utils/terminalOsc52', () => ({ OSC52_MAX_BYTES: 1000, bindTerminalOsc52: () => () => {}, copyAgentText: () => Promise.resolve(true) }))
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
  resizes() { return this.sent.filter(m => m.type === 'terminal.resize').map(m => [m.cols, m.rows]) }
  cts() { return this.sent.filter(m => m.type === 'terminal.history') }
}

function setup() {
  let ctl!: ReturnType<typeof createTerminal>
  let banner: unknown = null
  const setBanner = vi.fn((b: unknown) => { banner = b })
  const wrapper = mount(defineComponent({
    setup() {
      ctl = createTerminal('w1:p1', { setBanner, hasBanner: () => banner !== null, input: () => true })
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
  // What TerminalView does on each mount: mount, fit, and connect only if the
  // adopted controller is not already on a live wire.
  const open = async () => {
    expect(await ctl.mount(host())).toBe(true)
    await nextTick()
    ctl.fitNow(false)
    if (!ctl.isConnected() && !ctl.hasBanner()) ctl.connect(false)
    return FakeSocket.all.at(-1)!
  }
  // What TerminalView does on unmount.
  const leave = () => ctl.park()
  return { ctl, open, leave, hostFor: host, wrapper, setBanner, banner: () => banner }
}

// A cold attach whose replay is revealed: capabilities, control, the full
// frame and the paint, then the reveal gate's quiet period. Without it the
// window is not at the tail yet and no scroll means what a test expects.
async function attached(ctl: ReturnType<typeof createTerminal>, ws: FakeSocket, paint = 'screen') {
  ws.open()
  ws.receive({ type: 'web.capabilities', core: true })
  ws.receive({ type: 'terminal.control', on: true })
  ws.receive({ type: 'terminal.frame', full: true, width: 47, height: 40, bytes: '' })
  ws.receive({ type: 'terminal.frame', bytes: btoa(paint), credit: paint.length, width: 47, height: 40 })
  await vi.waitFor(() => expect(ctl.loading.value).toBe(false))
  await nextTick()
}

const frame = (ws: FakeSocket, text: string, extra: Record<string, unknown> = {}) =>
  ws.receive({ type: 'terminal.frame', bytes: btoa(text), credit: text.length, width: 47, height: 40, ...extra })

beforeEach(() => {
  h1.terms.length = 0
  h1.fit = { cols: 47, rows: 40 }
  FakeSocket.all.length = 0
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  kbOpen.value = false
})

it('unmounting then mounting with a live wire opens no new socket and keeps the buffer', async () => {
  const { ctl, open, leave, wrapper } = setup()
  try {
    const ws = await open()
    await attached(ctl, ws, 'kept output')
    const xterm = h1.terms[0]!
    expect(xterm.written.join('')).toContain('kept output')
    leave()
    expect(h1.terms).toHaveLength(1)
    expect(ctl.isParked()).toBe(true)
    // The mount adopts: same xterm, no new WebSocket, the same stream.
    await open()
    expect(h1.terms).toHaveLength(1)
    expect(h1.terms[0]).toBe(xterm)
    expect(FakeSocket.all).toHaveLength(1)
    expect(ctl.isParked()).toBe(false)
    expect(xterm.written.join('')).toContain('kept output')
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('output written while parked is in the terminal after the mount', async () => {
  const { ctl, open, leave, wrapper } = setup()
  try {
    const ws = await open()
    await attached(ctl, ws, 'before')
    leave()
    // The stream stays live: the relay keeps writing into the parked xterm.
    frame(ws, 'while parked')
    expect(h1.terms[0]!.written.join('')).toContain('while parked')
    await open()
    const written = h1.terms[0]!.written.join('')
    expect(written).toContain('before')
    expect(written).toContain('while parked')
    expect(FakeSocket.all).toHaveLength(1)
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('a wire that died while parked opens cold on the mount', async () => {
  const { ctl, open, leave, wrapper, banner } = setup()
  try {
    const ws = await open()
    await attached(ctl, ws)
    leave()
    // "Taken over" by another viewer: the parked viewer says nothing and drops.
    ws.close()
    expect(ctl.isParked()).toBe(false)
    expect(ctl.isConnected()).toBe(false)
    expect(banner()).toBeNull()
    // The next mount is a cold one: a new xterm, a new attach.
    const cold = await open()
    expect(h1.terms).toHaveLength(2)
    expect(FakeSocket.all).toHaveLength(2)
    expect(cold).not.toBe(ws)
    const q = new URL(cold.url, 'http://x').searchParams
    expect(q.get('cols')).toBe('47')
    expect(cold.cts()).toEqual([])
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('a parked terminal never resizes, banners, focuses, or reports visibility', async () => {
  const { ctl, open, leave, wrapper, setBanner } = setup()
  try {
    const ws = await open()
    await attached(ctl, ws)
    const xterm = h1.terms[0]!
    leave()
    setBanner.mockClear()
    const sentBefore = ws.resizes().length
    const visibilityBefore = ws.sent.filter(m => m.type === 'visibility').length
    // A fit while parked would measure an element detached from any layout.
    h1.fit = { cols: 120, rows: 60 }
    ctl.fitNow(true)
    expect(xterm.cols).toBe(47)
    expect(xterm.rows).toBe(40)
    expect(ws.resizes()).toHaveLength(sentBefore)
    // A size the core reports does not raise a banner either.
    ws.receive({ type: 'terminal.control', on: false })
    expect(setBanner).not.toHaveBeenCalled()
    // No focus and no focus report.
    ctl.focus()
    expect(document.activeElement).not.toBe(xterm.textarea)
    expect(ctl.kbdOn.value).toBe(false)
    // Visibility is held for the adopt, never sent from a viewer nobody sees.
    ctl.setVisible(true)
    expect(ws.sent.filter(m => m.type === 'visibility')).toHaveLength(visibilityBefore)
    // The adopt sends the current one, once (after its own fit).
    await open()
    const after = ws.sent.filter(m => m.type === 'visibility')
    expect(after).toHaveLength(visibilityBefore + 1)
    expect(after.at(-1)).toEqual({ type: 'visibility', visible: !document.hidden })
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('a terminal parked inside its live view is disposed after the idle limit', async () => {
  const { ctl, open, leave, wrapper } = setup()
  try {
    const ws = await open()
    await attached(ctl, ws)
    // Terminal → Conversation on the same agent: parked, never reaching the
    // cross-pane cache.
    vi.useFakeTimers()
    leave()
    expect(ctl.isParked()).toBe(true)
    vi.advanceTimersByTime(PARK_IDLE_MS - 1)
    expect(ctl.isParked()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(ctl.isParked()).toBe(false)
    // Disposed, which closes the wire.
    expect(ws.readyState).toBe(3)
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('adopting cancels the idle limit', async () => {
  const { ctl, open, leave, wrapper } = setup()
  try {
    const ws = await open()
    await attached(ctl, ws)
    vi.useFakeTimers()
    leave()
    vi.advanceTimersByTime(PARK_IDLE_MS - 10)
    await open()
    expect(ctl.isParked()).toBe(false)
    vi.advanceTimersByTime(PARK_IDLE_MS)
    expect(ctl.isConnected()).toBe(true)
    expect(ws.readyState).toBe(1)
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('a parked terminal goes at once when the page becomes hidden', async () => {
  const { ctl, open, leave, wrapper } = setup()
  try {
    const ws = await open()
    await attached(ctl, ws)
    leave()
    expect(ctl.isParked()).toBe(true)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      expect(ctl.isParked()).toBe(false)
      expect(ws.readyState).toBe(3)
    } finally { hidden.mockRestore() }
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('a visible terminal ignores the page going hidden', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const ws = await open()
    await attached(ctl, ws)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      expect(ctl.isConnected()).toBe(true)
      expect(ws.readyState).toBe(1)
    } finally { hidden.mockRestore() }
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('parking during a covered replay keeps the cover, and the reveal lands at the tail', async () => {
  const { ctl, open, leave, wrapper } = setup()
  try {
    const ws = await open()
    ws.open()
    ws.receive({ type: 'web.capabilities', core: true })
    vi.useFakeTimers()
    // A full repaint starts the reveal gate: the view is covered while the
    // replay is written.
    ws.receive({ type: 'terminal.frame', full: true, width: 47, height: 40, bytes: '' })
    expect(ctl.loading.value).toBe(true)
    // The view unmounts in the middle of the replay.
    leave()
    expect(ctl.isParked()).toBe(true)
    // A frame keeps being written into the parked xterm; the gate still holds.
    frame(ws, 'replayed history')
    expect(h1.terms[0]!.written.join('')).toContain('replayed history')
    expect(ctl.loading.value).toBe(true)
    // Adopted before the quiet period ends: still covered, same xterm.
    await open()
    expect(h1.terms).toHaveLength(1)
    expect(ctl.loading.value).toBe(true)
    // The gate reveals on its own, with no view having driven it.
    vi.advanceTimersByTime(2000)
    await nextTick()
    expect(ctl.loading.value).toBe(false)
    // The reveal put the window at the live tail, not in the replay's middle.
    expect(h1.terms[0]!.buffer.active.viewportY).toBe(h1.terms[0]!.buffer.active.baseY)
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('a deep fetch still pending at park is cleared, its one-per-xterm mark kept', async () => {
  const { ctl, open, leave, wrapper } = setup()
  try {
    const ws = await open()
    await attached(ctl, ws)
    // A cold paint that filled its amount: the core may hold more.
    Object.assign(h1.terms[0]!.buffer.active, { baseY: 240, length: 280, cursorY: 39 })
    ctl.scroll(240)
    expect(ctl.loadingEarlier.value).toBe(true)
    expect(ws.cts().map(m => m.lines)).toEqual([MAX_HISTORY])
    leave()
    expect(ctl.loadingEarlier.value).toBe(false)
    await open()
    // One deep fetch per xterm still holds: the same xterm does not ask again.
    ctl.scroll(240)
    expect(ws.cts()).toHaveLength(1)
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('asks for the deep history only at the top, and only once', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const ws = await open()
    await attached(ctl, ws)
    Object.assign(h1.terms[0]!.buffer.active, { baseY: 240, length: 280, cursorY: 39 })
    // Re-pin the window to the new tail (the buffer changed under the view).
    ctl.scroll(-1000)
    // A first short scroll back is still far from the top.
    ctl.scroll(10)
    expect(ws.cts()).toHaveLength(0)
    // Reaching the top asks once.
    ctl.scroll(1000)
    expect(ws.cts()).toHaveLength(1)
    // A second seek to the top does not ask again.
    ctl.scroll(-5)
    ctl.scroll(5)
    expect(ws.cts()).toHaveLength(1)
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('never asks for the deep history on the alternate screen', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const ws = await open()
    await attached(ctl, ws)
    const term = h1.terms[0]!
    term.buffer.active.type = 'alternate'
    Object.assign(term.buffer.active, { baseY: 240, length: 280, cursorY: 39 })
    ctl.scroll(1000)
    expect(ws.cts()).toHaveLength(0)
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('does not ask when the cold paint ended before the amount it requested', async () => {
  const { ctl, open, wrapper } = setup()
  try {
    const ws = await open()
    await attached(ctl, ws)
    // 60 rows delivered for 200 requested: the core had nothing older.
    Object.assign(h1.terms[0]!.buffer.active, { baseY: 60, length: 100, cursorY: 39 })
    ctl.scroll(1000)
    expect(ws.cts()).toHaveLength(0)
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('a cold re-open asks for the cold amount and may fetch deep again', async () => {
  const { ctl, open, leave, wrapper } = setup()
  try {
    const ws = await open()
    await attached(ctl, ws)
    Object.assign(h1.terms[0]!.buffer.active, { baseY: 240, length: 280, cursorY: 39 })
    ctl.scroll(1000)
    expect(ws.cts()).toHaveLength(1)
    // The wire dies while parked: the next mount is cold, a new xterm, and its
    // own deep fetch.
    leave()
    ws.close()
    const cold = await open()
    expect(cold).not.toBe(ws)
    await attached(ctl, cold)
    Object.assign(h1.terms.at(-1)!.buffer.active, { baseY: 240, length: 280, cursorY: 39 })
    ctl.scroll(1000)
    expect(cold.cts()).toHaveLength(1)
    expect(COLD_HISTORY).toBeLessThan(MAX_HISTORY)
  } finally { ctl.dispose(); wrapper.unmount() }
})

// A deep fetch the relay never answers (an older server after a rollback, or
// one that ignored it) must not freeze the view on the old line for good.
it('an unanswered deep fetch clears the strip when its deadline passes, and the view follows again', async () => {
  vi.useFakeTimers()
  const { ctl, open, wrapper } = setup()
  try {
    const ws = await open()
    await attached(ctl, ws)
    const term = h1.terms[0]!
    Object.assign(term.buffer.active, { baseY: 240, length: 280, cursorY: 39 })
    ctl.scroll(1000)
    expect(ctl.loadingEarlier.value).toBe(true)
    expect(ws.cts()).toHaveLength(1)
    // No `full` frame ever comes. The strip clears on its own…
    vi.advanceTimersByTime(DEEP_FETCH_TIMEOUT_MS)
    await nextTick()
    expect(ctl.loadingEarlier.value).toBe(false)
    expect(ws.cts()).toHaveLength(1)
    // …and the view is not frozen: the reader's row is held while parked at
    // the top, and scrolling back down moves the window again, to the tail.
    expect(term.buffer.active.viewportY).toBe(0)
    Object.assign(term.buffer.active, { baseY: 300, length: 340 })
    ctl.scroll(-1000)
    expect(term.buffer.active.viewportY).toBe(300)
  } finally { ctl.dispose(); wrapper.unmount() }
})

it('a full frame before the deadline still restores the reading line', async () => {
  vi.useFakeTimers()
  const { ctl, open, wrapper } = setup()
  try {
    const ws = await open()
    await attached(ctl, ws)
    const term = h1.terms[0]!
    Object.assign(term.buffer.active, { baseY: 240, length: 280, cursorY: 39 })
    ctl.scroll(1000)
    expect(ctl.loadingEarlier.value).toBe(true)
    expect(term.buffer.active.viewportY).toBe(0)
    vi.advanceTimersByTime(50)
    // The deep paint arrives: the window goes back to the same distance from
    // the tail it had when the fetch was asked (baseY 240, viewportY 0 → 240
    // rows from the bottom), not to the new tail and not to the new top.
    Object.assign(term.buffer.active, { baseY: 4780, length: 4820, cursorY: 39 })
    ws.receive({ type: 'terminal.frame', full: true, width: 47, height: 40, bytes: '' })
    ws.receive({ type: 'terminal.frame', bytes: btoa('deep'), credit: 4, width: 47, height: 40 })
    vi.advanceTimersByTime(2000)
    await nextTick()
    expect(ctl.loadingEarlier.value).toBe(false)
    expect(term.buffer.active.viewportY).toBe(4540)
    // The deadline was cancelled: no second clear, no jump.
    vi.advanceTimersByTime(DEEP_FETCH_TIMEOUT_MS)
    await nextTick()
    expect(term.buffer.active.viewportY).toBe(4540)
  } finally { ctl.dispose(); wrapper.unmount() }
})

// The adopt awaits the renderer move (a WebGL rebuild); the view can unmount
// in that window, which parks the controller again. The stale adopt must not
// finish into the host the leaving view took with it, nor leave it mounting.
it('an adopt overtaken by a park during its renderer move leaves the terminal parked', async () => {
  const { ctl, open, leave, hostFor, wrapper } = setup()
  terminalRenderer.value = 'webgl'
  try {
    const ws = await open()
    await attached(ctl, ws)
    const xterm = h1.terms[0]!
    leave()
    expect(ctl.isParked()).toBe(true)
    const adopting = ctl.mount(hostFor())
    // The view unmounts while the renderer move is awaited: parked again.
    ctl.park()
    expect(ctl.isParked()).toBe(true)
    expect(await adopting).toBe(false)
    // Its own state stands: parked, with the same one xterm, not loading, and
    // not left "mounting" (which would block the paste rebind on adopt).
    expect(ctl.isParked()).toBe(true)
    expect(ctl.loading.value).toBe(false)
    expect(h1.terms).toHaveLength(1)
    expect(h1.terms[0]).toBe(xterm)
    // A later mount adopts it normally.
    expect(await open()).toBe(ws)
    expect(h1.terms).toHaveLength(1)
    expect(ctl.isParked()).toBe(false)
  } finally { terminalRenderer.value = 'html'; ctl.dispose(); wrapper.unmount() }
})

it('an adopt interrupted by dispose during its renderer move leaves a clean controller', async () => {
  const { ctl, open, leave, hostFor, wrapper } = setup()
  // webgl makes the adopt await the renderer move: that is the window in which
  // the view can go away.
  terminalRenderer.value = 'webgl'
  try {
    const ws = await open()
    await attached(ctl, ws)
    const xterm = h1.terms[0]!
    leave()
    expect(ctl.isParked()).toBe(true)
    // Adopt, and dispose before the renderer move settles.
    const adopting = ctl.mount(hostFor())
    ctl.dispose()
    expect(await adopting).toBe(false)
    // No half-adopted state: not parked (it would be adopted again), not
    // connected, and not left loading.
    expect(ctl.isParked()).toBe(false)
    expect(ctl.isConnected()).toBe(false)
    expect(ctl.loading.value).toBe(false)
    // The next mount is a cold one and works.
    terminalRenderer.value = 'html'
    const again = await open()
    expect(h1.terms).toHaveLength(2)
    expect(again).not.toBe(ws)
  } finally { terminalRenderer.value = 'html'; ctl.dispose(); wrapper.unmount() }
})
