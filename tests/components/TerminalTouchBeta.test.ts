import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick, ref } from 'vue'
import TerminalView from '~/components/TerminalView.vue'
import { smoothTouchScrolling } from '~/composables/useHerdr'

// Bootstrap Nuxt outside gesture assertions: its first app mount compiles the
// test app and can exceed the per-test limit on a small CI worker.
beforeAll(async () => {
  const app = await mountSuspended({ template: '<div />' })
  app.unmount()
}, 60_000)

let unmount: (() => void) | undefined
const frames = new Map<number, FrameRequestCallback>()
let id = 0
async function mounted(enabled: boolean, coarse = false) {
  smoothTouchScrolling.value = enabled
  if (coarse) vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('pointer: coarse'), media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const ctl = {
    mount: vi.fn((el: HTMLElement) => { el.innerHTML = '<div class="xterm"><div class="xterm-screen">terminal grid</div></div>' }),
    scroll: vi.fn(() => true), rowHeight: () => 16, pageRows: () => 24,
    fitNow: vi.fn(), hasBanner: () => true, connect: vi.fn(), dispose: vi.fn(),
    focus: vi.fn(), blur: vi.fn(), tapLink: vi.fn(() => false), tapMouse: vi.fn(),
    cancelTouchScroll: vi.fn(), scrollInputVersion: ref(0), scrollAck: ref(0), frameTick: ref(0),
    loading: ref(false), selectionHint: { visible: ref(false), dismiss: vi.fn() },
    mouseMode: ref(coarse),
    requestScrollback: vi.fn(), scrollback: ref(''), scrollbackVersion: ref(0),
    termTheme: () => undefined, transcriptAt: () => undefined,
    transcriptInject: vi.fn(), transcriptRange: () => [0, 23],
    transcriptWindow: () => ({ top: 0, rows: 24 }),
  }
  const w = await mountSuspended(TerminalView, { props: { ctl: ctl as unknown as TerminalCtl } })
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++id, fn); return id })
  vi.stubGlobal('cancelAnimationFrame', (n: number) => frames.delete(n))
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(fn => { frames.set(++id, fn); return id })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(n => { frames.delete(n) })
  unmount = () => w.unmount()
  const send = async (type: string, y: number, count = 1) => {
    await w.get('#touch').trigger(type, { touches: Array.from({ length: count }, () => ({ clientX: 50, clientY: y })), changedTouches: [{ clientX: 50, clientY: y }] })
  }
  return { w, ctl, send, screen: () => w.get('.xterm-screen').attributes('style') || '' }
}
function paint() {
  for (const [n, fn] of [...frames]) { frames.delete(n); fn(performance.now()) }
}
afterEach(() => {
  unmount?.(); unmount = undefined
  smoothTouchScrolling.value = false
  localStorage.removeItem('smoothTouchScrolling')
  frames.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})

describe('terminal beta switch', () => {
  it('keeps an opaque application on the live touch surface without a guessed history document', async () => {
    const r = await mounted(true, true)
    expect(r.w.find('.lt-doc').exists()).toBe(false)
    expect(r.w.get('#scrollback').attributes('style')).toContain('pointer-events: none')
  })
  it('sends only the distance dragged, without speculative read-ahead wheel ticks', async () => {
    const r = await mounted(true)
    let time = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => time)
    await r.send('touchstart', 100)
    time += 16
    await r.send('touchmove', 132)
    paint()
    time += 16
    await r.send('touchmove', 164)
    paint()
    expect(r.ctl.scroll.mock.calls.map(call => call[0])).toEqual([2, 2])
  })
  it('cancels an old direction even after its preview has been acknowledged', async () => {
    const r = await mounted(true)
    await r.send('touchstart', 100)
    await r.send('touchmove', 132)
    paint()
    r.ctl.scrollAck.value = 2
    r.ctl.cancelTouchScroll.mockClear()
    await r.send('touchmove', 116)
    paint()
    expect(r.ctl.cancelTouchScroll).toHaveBeenCalledOnce()
    expect(r.ctl.scroll.mock.calls.at(-1)?.[0]).toBe(-1)
  })
  it('defaults to off and sends only legacy row scrolls without prediction or cancellation', async () => {
    expect(smoothTouchScrolling.value).toBe(false)
    const r = await mounted(false)
    await r.send('touchstart', 100)
    await r.send('touchmove', 140)
    paint()
    expect(r.ctl.scroll.mock.calls).toEqual([[2]])
    expect(r.screen()).not.toContain('translate')
    await r.send('touchend', 140, 0)
    paint()
    expect(r.ctl.cancelTouchScroll).not.toHaveBeenCalled()
    expect(r.ctl.scroll).toHaveBeenCalledTimes(1)
  })
  it('predicts only the grid, retires debt after paint, and cancels on resize/input', async () => {
    const r = await mounted(true)
    await r.send('touchstart', 100)
    await r.send('touchmove', 140)
    expect(r.screen()).toContain('translate3d')
    expect(r.w.get('#termWrap').attributes('style')).toBeUndefined()
    paint()
    // A request carries only actual finger travel; acknowledgement retires
    // its visual hint without claiming an application transcript position.
    expect(r.ctl.scroll).toHaveBeenCalledTimes(1)
    const call = r.ctl.scroll.mock.calls[0]!
    expect(call.slice(1)).toEqual([50, 140, 0, true])
    expect(call[0]).toBe(2)
    r.ctl.scrollAck.value = 2
    paint()
    expect(r.screen()).toContain('8px')
    await r.send('touchmove', 172)
    paint()
    r.ctl.scrollAck.value += 2
    paint()
    expect(r.screen()).toContain('8px')
    r.ctl.scrollInputVersion.value++
    await nextTick()
    expect(r.screen()).not.toContain('translate')
    expect(frames.size).toBe(0)
    expect(r.ctl.cancelTouchScroll).toHaveBeenCalled()
  })
  it('consumes the tap that stops a flick, including its compatibility mouse event', async () => {
    const r = await mounted(true)
    let time = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => time)
    await r.send('touchstart', 100)
    time += 16
    await r.send('touchmove', 160)
    await r.send('touchend', 160, 0)
    // Real browsers dispatch pointerdown before touchstart. Cancellation must
    // not forget that this next tap is stopping a scroll.
    await r.w.get('#touch').trigger('pointerdown')
    await r.send('touchstart', 160)
    await r.send('touchend', 160, 0)
    await r.w.get('#touch').trigger('mousedown')
    expect(r.ctl.tapMouse).not.toHaveBeenCalled()
    expect(r.ctl.tapLink).not.toHaveBeenCalled()
    expect(r.ctl.focus).not.toHaveBeenCalled()
    time += 701
    await r.send('touchstart', 160)
    await r.send('touchend', 160, 0)
    await r.w.get('#touch').trigger('mousedown')
    expect(r.ctl.tapMouse).toHaveBeenCalledOnce()
    expect(r.ctl.focus).toHaveBeenCalledOnce()
  })
  it.each([false, true])('allows a normal tap to focus the terminal with beta=%s', async enabled => {
    const r = await mounted(enabled)
    await r.send('touchstart', 100)
    await r.send('touchend', 100, 0)
    await r.w.get('#touch').trigger('mousedown')
    expect(r.ctl.tapMouse).toHaveBeenCalledOnce()
    expect(r.ctl.focus).toHaveBeenCalledOnce()
  })
  it('previews a small drag without inventing a full row at the gesture threshold', async () => {
    const r = await mounted(true)
    await r.send('touchstart', 100)
    await r.send('touchmove', 105)
    paint()
    expect(r.ctl.scroll).not.toHaveBeenCalled()
    expect(r.screen()).toContain('5px')
  })
  it('clears queued movement and styles immediately when disabled during a gesture', async () => {
    const r = await mounted(true)
    await r.send('touchstart', 100)
    await r.send('touchmove', 140)
    smoothTouchScrolling.value = false
    await nextTick()
    paint()
    expect(r.screen()).not.toContain('translate')
    expect(r.ctl.scroll).not.toHaveBeenCalled()
    await r.send('touchstart', 100)
    await r.send('touchmove', 140)
    paint()
    expect(r.ctl.scroll.mock.calls).toEqual([[2]])
  })
  it('cancels multitouch and removes every scheduled frame on unmount', async () => {
    const r = await mounted(true)
    await r.send('touchstart', 100)
    await r.send('touchmove', 140)
    await r.send('touchmove', 160, 2)
    paint()
    expect(r.ctl.scroll).not.toHaveBeenCalled()
    expect(r.screen()).not.toContain('translate')
    r.w.unmount(); unmount = undefined
    expect(frames.size).toBe(0)
    expect(r.ctl.dispose).toHaveBeenCalledOnce()
  })
})
