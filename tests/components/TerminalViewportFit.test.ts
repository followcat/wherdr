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
    fitNow: vi.fn(), hasBanner: () => true, connect: vi.fn(), dispose: vi.fn(), isConnected: () => false,
    focus: vi.fn(), blur: vi.fn(), tapLink: vi.fn(() => false), tapMouse: vi.fn(),
    cancelTouchScroll: vi.fn(), scrollInputVersion: ref(0), scrollGeometryVersion: ref(0), scrollAck: ref(0), frameTick: ref(0),
    loading: ref(false), loadingEarlier: ref(false), kbdOn: ref(false), selectionHint: { visible: ref(false), dismiss: vi.fn() },
    hasFocus: () => false, imeBusy: () => false, park: vi.fn(), captureScreen: vi.fn(() => null),
    clearVirtualModifiers: vi.fn(), tapOnCursor: vi.fn(() => false),
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
    // visualViewport firing during the keyboard's slide: each frame reports a
    // shorter height, each bumps layoutTick.
    const vp = { height: 768, offsetTop: 0 }
    vi.stubGlobal('visualViewport', vp)
    for (let i = 0; i < 5; i++) {
      vp.height -= 15
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

  it('fits when kbdOn turns on while the keyboard is already covering the viewport', async () => {
    const ctl = await mounted()
    vi.useFakeTimers()
    vi.advanceTimersByTime(1000)
    ctl.kbdOn.value = true
    await nextTick()
    vi.advanceTimersByTime(60)
    expect(ctl.fitNow).toHaveBeenCalledTimes(1)
    expect(ctl.fitNow).toHaveBeenCalledWith(true)
  })
})
