import { expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createTerminal } from '~/composables/useTerminal'
import { pageVisible, socketWake, terminalRenderer, smoothTouchScrolling } from '~/composables/useHerdr'

vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}; modes = { mouseTrackingMode: 'none' }
  write(_data: unknown, done?: () => void) { done?.() }
  loadAddon() {} open() {} dispose() {} refresh() {} attachCustomWheelEventHandler() {}
  attachCustomKeyEventHandler() {} onData() {} onBinary() {}
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { return null } } }))
vi.mock('~/utils/terminalMouse', () => ({ bindTerminalMouse: () => ({ dispose() {} }) }))
vi.mock('~/utils/terminalSelection', () => ({ bindTerminalSelection: () => () => {} }))
vi.mock('~/utils/terminalLinks', () => ({ bindTerminalLinks: () => ({ dispose() {} }) }))
vi.mock('~/utils/terminalOsc52', () => ({ OSC52_MAX_BYTES: 1000, bindTerminalOsc52: () => () => {} }))
vi.mock('~/utils/terminalFont', () => ({ TERM_FONT: 'monospace', onFontsLoaded: () => () => {} }))

it.each([false, true])('shares wake probes and counts painted frames with touch beta=%s', async enabled => {
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
    ctl.mount(wrapper.element as HTMLElement)
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
    ctl.scroll(2, 10, 20, 0, true)
    const packet = ws.send.mock.calls.map(([data]) => JSON.parse(data)).findLast(m => m.type === 'terminal.scroll')
    expect(packet.source).toBe(enabled ? 'touch' : undefined)
    ws.onmessage!({ data: JSON.stringify({ type: 'terminal.frame', width: 80, height: 24, bytes: '' }) })
    ws.onmessage!({ data: JSON.stringify({ type: 'scroll.ack', epoch: packet.epoch, lines: 2 }) })
    // Every parsed frame counts, including when touch scrolling is disabled.
    expect(ctl.frameTick.value).toBe(1)
    expect(ctl.scrollAck.value).toBe(enabled ? 2 : 0)
    const previousVersion = ctl.scrollInputVersion.value
    const staleClose = ws.onclose!
    ctl.connect(false)
    expect(ctl.scrollInputVersion.value).toBe(previousVersion + (enabled ? 1 : 0))
    const replacement = sockets[1]!
    replacement.readyState = 1
    replacement.onopen!()
    ctl.scroll(1, 10, 20, 0, true)
    const nextPacket = replacement.send.mock.calls.map(([data]) => JSON.parse(data)).findLast(m => m.type === 'terminal.scroll')
    staleClose()
    expect(ctl.scrollInputVersion.value).toBe(previousVersion + (enabled ? 1 : 0))
    replacement.onmessage!({ data: JSON.stringify({ type: 'scroll.ack', epoch: nextPacket.epoch, lines: 1 }) })
    expect(ctl.scrollAck.value).toBe(enabled ? 3 : 0)
  } finally {
    ctl.dispose()
    smoothTouchScrolling.value = false
    wrapper.unmount()
    vi.unstubAllGlobals()
  }
})
