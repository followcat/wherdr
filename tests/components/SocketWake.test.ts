import { expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createTerminal } from '~/composables/useTerminal'
import { pageVisible, socketWake, terminalRenderer, smoothTouchScrolling } from '~/composables/useHerdr'

const terms: { scrollToLine: ReturnType<typeof vi.fn> }[] = []
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}; modes = { mouseTrackingMode: 'none' }
  buffer = { active: { viewportY: 10, baseY: 10, length: 34, cursorY: 23 } }
  scrollToLine = vi.fn(function (this: { buffer: { active: { viewportY: number } } }, y: number) { this.buffer.active.viewportY = y })
  write(_data: unknown, done?: () => void) { done?.() }
  resize() {} reset() {}
  loadAddon() {} open() {} dispose() {} refresh() {} attachCustomWheelEventHandler() {}
  attachCustomKeyEventHandler() {} onData() {} onBinary() {} onScroll() {}
  constructor() { terms.push(this) }
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { return null } } }))
vi.mock('~/utils/terminalMouse', () => ({ bindTerminalMouse: () => ({ dispose() {} }) }))
vi.mock('~/utils/terminalSelection', () => ({ bindTerminalSelection: () => () => {} }))
vi.mock('~/utils/terminalLinks', () => ({ bindTerminalLinks: () => ({ dispose() {} }) }))
vi.mock('~/utils/terminalOsc52', () => ({ OSC52_MAX_BYTES: 1000, bindTerminalOsc52: () => () => {} }))
vi.mock('~/utils/terminalFont', () => ({ TERM_FONT: 'monospace', onFontsLoaded: () => () => {} }))

it.each([false, true])('shares wake probes while preserving touch beta=%s frame accounting', async enabled => {
  smoothTouchScrolling.value = enabled
  const sockets: Socket[] = []
  class Socket {
    readyState = 0
    send = vi.fn()
    close = vi.fn()
    onopen?: () => void
    onmessage?: (e: { data: string }) => void
    onclose?: (() => void) | null
    constructor() { sockets.push(this) }
  }
  vi.stubGlobal('WebSocket', Socket)
  terms.length = 0
  pageVisible.value = true
  terminalRenderer.value = 'html'
  let ctl!: ReturnType<typeof createTerminal>
  const wrapper = mount(defineComponent({
    setup() {
      ctl = createTerminal('w1:p1', { setBanner: vi.fn(), hasBanner: () => false })
      return () => h('div')
    },
  }))
  try {
    await ctl.mount(wrapper.element as HTMLElement)
    ctl.connect(false)
    const ws = sockets[0]!
    const pings = () => ws.send.mock.calls.filter(([data]) => JSON.parse(data).type === 'ping').length
    socketWake.value++
    await nextTick()
    expect(pings()).toBe(0)
    expect(sockets).toHaveLength(1)
    expect(ws.close).not.toHaveBeenCalled()
    ws.readyState = 1
    ws.onopen!()
    socketWake.value++
    await nextTick()
    expect(pings()).toBe(1)
    socketWake.value++
    await nextTick()
    expect(pings()).toBe(1)
    ws.onmessage!({ data: '{"type":"pong"}' })
    await nextTick()
    socketWake.value++
    await nextTick()
    expect(pings()).toBe(2)
    expect(pageVisible.value).toBe(true)
    expect(sockets).toHaveLength(1)
    expect(ws.close).not.toHaveBeenCalled()
    ws.onmessage!({ data: '{"type":"web.capabilities","core":true}' })
    // Watching mode pins the window to the tail (baseY 10): scrolling is
    // local — scrollToLine on xterm, never a terminal.scroll packet.
    ws.onmessage!({ data: '{"type":"terminal.control","on":false}' })
    ctl.scroll(2)
    expect(terms[0]!.scrollToLine).toHaveBeenLastCalledWith(8)
    expect(ws.send.mock.calls.map(([data]) => JSON.parse(data)).some(m => m.type === 'terminal.scroll')).toBe(false)
    ws.onmessage!({ data: JSON.stringify({ type: 'terminal.frame', width: 80, height: 24, bytes: '' }) })
    expect(ctl.frameTick.value).toBe(enabled ? 1 : 0)
    // A full repaint replaces the screen a gesture measured: input version.
    const beforeFull = ctl.scrollInputVersion.value
    ws.onmessage!({ data: JSON.stringify({ type: 'terminal.frame', width: 80, height: 24, full: true, bytes: '' }) })
    expect(ctl.scrollInputVersion.value).toBe(beforeFull + 1)
    // A resize only invalidates coordinates: geometry version, not input.
    const beforeGeometry = ctl.scrollInputVersion.value
    ws.onmessage!({ data: JSON.stringify({ type: 'terminal.frame', width: 100, height: 30, bytes: '' }) })
    expect(ctl.scrollInputVersion.value).toBe(beforeGeometry)
    expect(ctl.scrollGeometryVersion.value).toBeGreaterThan(0)
    // scroll.ack belongs to the retired remote model: ignored, never an error.
    ws.onmessage!({ data: '{"type":"scroll.ack","lines":2}' })
    expect(ctl.frameTick.value).toBe(enabled ? 3 : 0)
    // Real controller input invalidates a gesture in BOTH scroll modes —
    // local only, never a remote cancel.
    const v0 = ctl.scrollInputVersion.value
    ctl.sendTerm({ type: 'terminal.input', text: 'x' })
    expect(ctl.scrollInputVersion.value).toBe(v0 + 1)
    void ctl.sendKeys(['esc'])
    expect(ctl.scrollInputVersion.value).toBe(v0 + 2)
    ctl.sendTerm({ type: 'paste', text: 'p' })
    expect(ctl.scrollInputVersion.value).toBe(v0 + 3)
    ctl.setVisible(false)
    expect(ctl.scrollInputVersion.value).toBe(v0 + 4)
    expect(ws.send.mock.calls.map(([data]) => JSON.parse(data)).some(m => m.type === 'touch.cancel')).toBe(false)
    const previousVersion = ctl.scrollInputVersion.value
    const staleClose = ws.onclose!
    ctl.connect(false)
    expect(ctl.scrollInputVersion.value).toBe(previousVersion + 1)
    const replacement = sockets[1]!
    replacement.readyState = 1
    replacement.onopen!()
    ctl.scroll(1)
    expect(terms[0]!.scrollToLine).toHaveBeenLastCalledWith(9)
    staleClose()
    expect(ctl.scrollInputVersion.value).toBe(previousVersion + 1)
    replacement.onmessage!({ data: '{"type":"scroll.ack","lines":1}' })
    // The full repaint between the scrolls re-pinned the window to the tail
    // (scrollToLine 10): three owned viewport moves in total.
    expect(terms[0]!.scrollToLine).toHaveBeenCalledTimes(3)
    // Disconnect invalidates pending gestures in both modes too.
    const vd = ctl.scrollInputVersion.value
    ctl.disconnect()
    expect(ctl.scrollInputVersion.value).toBe(vd + 1)
  } finally {
    ctl.dispose()
    smoothTouchScrolling.value = false
    wrapper.unmount()
    vi.unstubAllGlobals()
  }
})

it.each([false, true])('rowHeight measures the rendered grid, not the clipped host, beta=%s', async enabled => {
  smoothTouchScrolling.value = enabled
  let ctl!: ReturnType<typeof createTerminal>
  const wrapper = mount(defineComponent({
    setup() {
      ctl = createTerminal('w1:p1', { setBanner: vi.fn(), hasBanner: () => false })
      return () => h('div')
    },
  }))
  try {
    await ctl.mount(wrapper.element as HTMLElement)
    const el = wrapper.element as HTMLElement
    // A watching viewer: a 24-row grid rendered at 20px/row inside a 240px
    // clipped host. Host/rows would read 10px — the grid's own 20px is right.
    Object.defineProperty(el, 'clientHeight', { value: 240, configurable: true })
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    Object.defineProperty(screen, 'clientHeight', { value: 480, configurable: true })
    el.appendChild(screen)
    expect(ctl.rowHeight()).toBe(20)
    // Before the screen renders, the host metric is the fallback.
    screen.remove()
    expect(ctl.rowHeight()).toBe(10)
  } finally {
    ctl.dispose()
    smoothTouchScrolling.value = false
    wrapper.unmount()
  }
})
