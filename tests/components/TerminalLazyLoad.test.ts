import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { createTerminal } from '~/composables/useTerminal'
import { terminalRenderer } from '~/composables/useHerdr'

// xterm arrives when the test says so: what the app asks meanwhile must wait for it.
const loads = vi.hoisted(() => ({ xterm: 0, webgl: 0, release: () => {}, fail: (_e: Error) => {} }))
const terminals = vi.hoisted(() => [] as { focused: boolean, disposed: boolean, addons: string[] }[])
vi.mock('~/utils/xtermLoader', () => {
  class Terminal {
    cols = 80; rows = 24; options = {}; textarea = null; element = null
    buffer = { active: { viewportY: 0, baseY: 0, length: 0, cursorY: 0 } }
    state = { focused: false, disposed: false, addons: [] as string[] }
    constructor() { terminals.push(this.state) }
    loadAddon(a: { kind: string }) { this.state.addons.push(a.kind) }
    focus() { this.state.focused = true }
    dispose() { this.state.disposed = true }
    parser = { registerCsiHandler: () => ({ dispose() {} }) }
    write() {} open() {} refresh() {} reset() {} scrollToLine() {} attachCustomWheelEventHandler() {}
    attachCustomKeyEventHandler() {} onData() {} onBinary() {} onScroll() {}
  }
  class FitAddon { kind = 'fit'; proposeDimensions() { return null } }
  class WebglAddon { kind = 'webgl'; onContextLoss() {} dispose() {} }
  return {
    loadXterm: () => {
      loads.xterm++
      return new Promise((resolve, reject) => {
        loads.release = () => resolve({ Terminal, FitAddon })
        loads.fail = reject
      })
    },
    loadWebgl: () => { loads.webgl++; return Promise.resolve({ WebglAddon }) },
  }
})
const offerNewBuild = vi.hoisted(() => vi.fn(async () => false))
vi.mock('~/composables/useAppVersion', () => ({ offerNewBuild }))
vi.mock('~/utils/terminalRenderer', async orig => ({ ...await orig<object>(), guardWebglCanvasSize: () => {} }))
vi.mock('~/utils/terminalMouse', () => ({ bindTerminalMouse: () => ({ dispose() {} }) }))
vi.mock('~/utils/terminalSelection', () => ({ bindTerminalSelection: () => () => {} }))
vi.mock('~/utils/terminalLinks', () => ({ bindTerminalLinks: () => ({ dispose() {} }) }))
vi.mock('~/utils/terminalOsc52', () => ({ OSC52_MAX_BYTES: 1000, bindTerminalOsc52: () => () => {} }))
vi.mock('~/utils/terminalFont', async (importOriginal) => ({ ...(await importOriginal() as object), TERM_FONT: 'monospace', onFontsLoaded: () => () => {} }))

const sockets: { url: string }[] = []
beforeEach(() => {
  loads.xterm = 0
  loads.webgl = 0
  terminals.length = 0
  sockets.length = 0
  vi.stubGlobal('WebSocket', class {
    readyState = 0; url: string; send() {} close() {}
    constructor(url: string) { this.url = url; sockets.push(this) }
  })
})
afterEach(() => { vi.unstubAllGlobals() })

function setup(banner = vi.fn()) {
  let ctl!: ReturnType<typeof createTerminal>
  const wrapper = mount(defineComponent({
    setup() {
      ctl = createTerminal('w1:p1', { setBanner: banner, hasBanner: () => false })
      return () => h('div')
    },
  }), { attachTo: document.body })
  return { ctl, wrapper, host: wrapper.element as HTMLElement }
}

it('loads xterm only when a terminal is mounted', async () => {
  const { ctl, wrapper } = setup()
  ctl.connect(false)
  ctl.focus()
  expect(loads.xterm).toBe(0)
  expect(sockets).toHaveLength(0)
  ctl.dispose()
  wrapper.unmount()
})

it('keeps a take-over and a focus asked while xterm loads', async () => {
  terminalRenderer.value = 'html'
  const { ctl, wrapper, host } = setup()
  const ready = ctl.mount(host)
  expect(ctl.loading.value).toBe(true)
  // AgentView's "Take control" runs before TerminalView's own connect.
  ctl.connect(true)
  ctl.focus()
  expect(sockets).toHaveLength(0)
  loads.release()
  expect(await ready).toBe(true)
  expect(ctl.loading.value).toBe(false)
  expect(terminals[0]!.focused).toBe(true)
  expect(loads.webgl).toBe(0)
  ctl.connect(false)
  expect(sockets).toHaveLength(1)
  expect(sockets[0]!.url).toContain('takeover=1')
  ctl.connect(false)
  expect(sockets[1]!.url).not.toContain('takeover=1')
  ctl.dispose()
  wrapper.unmount()
})

it('fits with the WebGL renderer already in place', async () => {
  terminalRenderer.value = 'webgl'
  const { ctl, wrapper, host } = setup()
  const ready = ctl.mount(host)
  loads.release()
  expect(await ready).toBe(true)
  expect(terminals[0]!.addons).toEqual(['fit', 'webgl'])
  ctl.dispose()
  wrapper.unmount()
  terminalRenderer.value = 'html'
})

it('builds nothing when the view is gone before xterm arrives', async () => {
  terminalRenderer.value = 'html'
  const { ctl, wrapper, host } = setup()
  const ready = ctl.mount(host)
  ctl.dispose()
  loads.release()
  expect(await ready).toBe(false)
  expect(terminals).toHaveLength(0)
  expect(ctl.loading.value).toBe(false)
  wrapper.unmount()
})

it('offers a retry when xterm cannot be downloaded', async () => {
  terminalRenderer.value = 'html'
  const banner = vi.fn()
  const { ctl, wrapper, host } = setup(banner)
  const ready = ctl.mount(host)
  loads.fail(new Error('offline'))
  expect(await ready).toBe(false)
  expect(ctl.loading.value).toBe(false)
  // Its files may be gone after a deployment: the app checks for a new version.
  expect(offerNewBuild).toHaveBeenCalledTimes(1)
  const offer = banner.mock.calls.at(-1)![0]
  expect(offer.btn).toBe('Retry')
  offer.fn()
  expect(loads.xterm).toBe(2)
  loads.release()
  await vi.waitFor(() => expect(sockets).toHaveLength(1))
  expect(terminals).toHaveLength(1)
  ctl.dispose()
  wrapper.unmount()
})
