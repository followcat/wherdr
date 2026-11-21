import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick, ref } from 'vue'
import TerminalView from '~/components/TerminalView.vue'
import { layout } from '~/composables/useViewport'

// The keyboard's animation resizes the visual viewport every frame: a fit per
// frame is a pane resize storm (SIGWINCH after SIGWINCH). Fits wait for quiet.
beforeAll(async () => {
  const app = await mountSuspended({ template: '<div />' })
  app.unmount()
}, 60_000)

let unmount: (() => void) | undefined
let roCallback: (() => void) | undefined
async function mounted() {
  roCallback = undefined
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: () => void) { roCallback = cb }
    observe() {} disconnect() {}
  })
  const ctl = {
    mount: vi.fn(async (el: HTMLElement) => { el.innerHTML = '<div class="xterm"><div class="xterm-screen">terminal grid</div></div>'; return true }),
    scroll: vi.fn(() => true), rowHeight: () => 16, pageRows: () => 24,
    fitNow: vi.fn(), hasBanner: () => true, connect: vi.fn(), dispose: vi.fn(),
    focus: vi.fn(), blur: vi.fn(), hasFocus: vi.fn(() => false), imeBusy: vi.fn(() => false),
    tapLink: vi.fn(() => false), tapMouse: vi.fn(), tapOnCursor: vi.fn(() => false),
    captureScreen: vi.fn(() => null), clearVirtualModifiers: vi.fn(),
    scrollInputVersion: ref(0), scrollGeometryVersion: ref(0), frameTick: ref(0),
    loading: ref(false), loadingEarlier: ref(false), park: vi.fn(), isConnected: () => true,
    selectionHint: { visible: ref(false), dismiss: vi.fn() },
  }
  const w = await mountSuspended(TerminalView, { props: { ctl: ctl as unknown as TerminalCtl } })
  unmount = () => w.unmount()
  await nextTick()
  ctl.fitNow.mockClear()
  return ctl
}
afterEach(() => {
  unmount?.(); unmount = undefined
  vi.unstubAllGlobals(); vi.useRealTimers()
})

describe('terminal fit while the viewport moves', () => {
  it('sends one fit once the keyboard animation settles, not one per frame', async () => {
    const ctl = await mounted()
    vi.useFakeTimers()
    // The keyboard's slide: each frame reports a new visible height, so each
    // layout() is a real change (a repeated one is deduped away).
    const vp = { height: 1000, offsetTop: 0 }
    vi.stubGlobal('visualViewport', vp)
    vi.stubGlobal('screen', { width: 820, height: 1180 })
    vi.stubGlobal('innerWidth', 744)
    vi.stubGlobal('innerHeight', 1000)
    for (let i = 0; i < 5; i++) {
      vp.height = 1000 - i
      layout()
      await nextTick()
      vi.advanceTimersByTime(60)
    }
    expect(ctl.fitNow).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(ctl.fitNow).toHaveBeenCalledTimes(1)
    expect(ctl.fitNow).toHaveBeenCalledWith(true)
  })

  it('a local resize without viewport motion still fits right away', async () => {
    const ctl = await mounted()
    vi.useFakeTimers()
    vi.advanceTimersByTime(1000) // any earlier layout() is long past
    roCallback?.() // a divider drag: the host resizes, the viewport does not
    vi.advanceTimersByTime(60)
    expect(ctl.fitNow).toHaveBeenCalledTimes(1)
    expect(ctl.fitNow).toHaveBeenCalledWith(true)
  })
})
