import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick, ref } from 'vue'
import TerminalView from '~/components/TerminalView.vue'
import { smoothTouchScrolling } from '~/composables/useHerdr'
import { kbOpen } from '~/composables/useViewport'

// Bootstrap Nuxt outside gesture assertions: its first app mount compiles the
// test app and can exceed the per-test limit on a small CI worker.
beforeAll(async () => {
  const app = await mountSuspended({ template: '<div />' })
  app.unmount()
}, 60_000)

let unmount: (() => void) | undefined
const frames = new Map<number, FrameRequestCallback>()
let id = 0
let roCallback: ResizeObserverCallback | undefined
async function mounted(enabled: boolean) {
  smoothTouchScrolling.value = enabled
  roCallback = undefined
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: ResizeObserverCallback) { roCallback = cb }
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
    loading: ref(false), selectionHint: { visible: ref(false), dismiss: vi.fn() },
  }
  const w = await mountSuspended(TerminalView, { props: { ctl: ctl as unknown as TerminalCtl } })
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++id, fn); return id })
  vi.stubGlobal('cancelAnimationFrame', (n: number) => frames.delete(n))
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(fn => { frames.set(++id, fn); return id })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(n => { frames.delete(n) })
  unmount = () => w.unmount()
  const send = async (type: string, y: number, count = 1, x = 50) => {
    await w.get('#touch').trigger(type, { touches: Array.from({ length: count }, () => ({ clientX: x, clientY: y })), changedTouches: [{ clientX: x, clientY: y }] })
  }
  return { w, ctl, send, roFire: () => roCallback?.([], {} as ResizeObserver), screen: () => w.get('.xterm-screen').attributes('style') || '' }
}
function paint() {
  for (const [n, fn] of [...frames]) { frames.delete(n); fn(performance.now()) }
}
afterEach(() => {
  unmount?.(); unmount = undefined
  smoothTouchScrolling.value = false
  kbOpen.value = false
  localStorage.removeItem('smoothTouchScrolling')
  frames.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})

describe('terminal beta switch', () => {
  it('defaults to off and sends only legacy row scrolls', async () => {
    expect(smoothTouchScrolling.value).toBe(false)
    const r = await mounted(false)
    await r.send('touchstart', 100)
    await r.send('touchmove', 140)
    paint()
    expect(r.ctl.scroll.mock.calls).toEqual([[2]])
    await r.send('touchend', 140, 0)
    paint()
    expect(r.ctl.scroll).toHaveBeenCalledTimes(1)
  })
  it('scrolls locally: the first row follows the finger, later rows coalesce', async () => {
    const r = await mounted(true)
    await r.send('touchstart', 100)
    await r.send('touchmove', 140)
    // takeTouchLines leads by half a row: 40px at 16px/row -> 3 lines now.
    expect(r.ctl.scroll.mock.calls).toEqual([[3]])
    expect(r.screen()).not.toContain('translate')
    await r.send('touchmove', 172)
    expect(r.ctl.scroll.mock.calls).toEqual([[3]])
    paint()
    expect(r.ctl.scroll.mock.calls).toEqual([[3], [2]])
    expect(r.screen()).not.toContain('translate')
  })
  it('keeps gesture ownership through a resize but disqualifies the release', async () => {
    const r = await mounted(true)
    await r.send('touchstart', 100)
    await r.send('touchmove', 140)
    r.ctl.scrollGeometryVersion.value++
    await nextTick()
    // The finger still owns its drag: motion keeps scrolling.
    await r.send('touchmove', 180)
    paint()
    expect(r.ctl.scroll.mock.calls.length).toBeGreaterThan(1)
    // Its release is disqualified: never a tap, a hold or accidental input.
    await r.send('touchend', 180, 0)
    expect(r.ctl.tapMouse).not.toHaveBeenCalled()
    expect(r.ctl.tapLink).not.toHaveBeenCalled()
    expect(r.ctl.focus).not.toHaveBeenCalled()
  })
  it('cancels the gesture on input but lets the next touch start fresh', async () => {
    const r = await mounted(true)
    let time = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => time)
    await r.send('touchstart', 100)
    time += 16
    await r.send('touchmove', 140)
    r.ctl.scrollInputVersion.value++
    await nextTick()
    await r.send('touchmove', 180)
    paint()
    expect(r.ctl.scroll).toHaveBeenCalledTimes(1)
    await r.send('touchend', 180, 0)
    expect(r.ctl.tapMouse).not.toHaveBeenCalled()
    // A tap right after scroll movement is still a stop-scroll tap; once the
    // flick window passes, the next touch starts fresh.
    time += 701
    await r.send('touchstart', 180)
    await r.send('touchend', 180, 0)
    expect(r.ctl.tapMouse).toHaveBeenCalledOnce()
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
    r.ctl.tapOnCursor.mockReturnValue(true)
    await r.send('touchstart', 160)
    await r.send('touchend', 160, 0)
    await r.w.get('#touch').trigger('mousedown')
    expect(r.ctl.tapMouse).toHaveBeenCalledOnce()
    expect(r.ctl.focus).toHaveBeenCalledOnce()
  })
  it.each([false, true])('focuses only a tap on the cursor row with beta=%s', async enabled => {
    const r = await mounted(enabled)
    r.ctl.tapOnCursor.mockReturnValue(true)
    await r.send('touchstart', 100)
    await r.send('touchend', 100, 0)
    expect(r.ctl.tapMouse).toHaveBeenCalledOnce()
    expect(r.ctl.focus).toHaveBeenCalledOnce()
    // A tap elsewhere dismisses the keyboard; a stray compatibility
    // mousedown is gated by the cursor row in both modes.
    r.ctl.tapOnCursor.mockReturnValue(false)
    r.ctl.tapMouse.mockClear(); r.ctl.focus.mockClear()
    await r.send('touchstart', 300)
    await r.send('touchend', 300, 0)
    await r.w.get('#touch').trigger('mousedown', { clientX: 50, clientY: 300 })
    expect(r.ctl.tapMouse).toHaveBeenCalledOnce()
    expect(r.ctl.focus).not.toHaveBeenCalled()
    expect(r.ctl.blur).toHaveBeenCalled()
  })
  it.each([false, true])('a touch-derived compatibility mousedown never refocuses with beta=%s', async enabled => {
    const r = await mounted(enabled)
    r.ctl.tapOnCursor.mockReturnValue(true)
    await r.send('touchstart', 100)
    await r.send('touchend', 100, 0)
    // touchend already decided the tap's keyboard intent; a stray compat
    // mousedown after a background tap must not reopen input.
    await r.w.get('#touch').trigger('mousedown', { clientX: 50, clientY: 100 })
    expect(r.ctl.focus).toHaveBeenCalledOnce()
    r.ctl.tapOnCursor.mockReturnValue(false)
    r.ctl.focus.mockClear()
    await r.send('touchstart', 200)
    await r.send('touchend', 200, 0)
    await r.w.get('#touch').trigger('mousedown', { clientX: 50, clientY: 200 })
    expect(r.ctl.focus).not.toHaveBeenCalled()
  })
  it('a legacy scroll drag releases the keyboard like a smooth one', async () => {
    const r = await mounted(false)
    r.ctl.hasFocus.mockReturnValue(true)
    kbOpen.value = true
    await r.send('touchstart', 100)
    await r.send('touchmove', 140)
    paint()
    expect(r.ctl.scroll).toHaveBeenCalled()
    expect(r.ctl.blur).toHaveBeenCalled()
  })
  it('a legacy scroll drag keeps the keyboard while an IME composition is in flight', async () => {
    const r = await mounted(false)
    r.ctl.hasFocus.mockReturnValue(true)
    r.ctl.imeBusy.mockReturnValue(true)
    kbOpen.value = true
    await r.send('touchstart', 100)
    await r.send('touchmove', 140)
    paint()
    expect(r.ctl.scroll).toHaveBeenCalled()
    expect(r.ctl.blur).not.toHaveBeenCalled()
  })
  it.each([false, true])('out-and-back sub-row motion stays a drag with beta=%s', async enabled => {
    const r = await mounted(enabled)
    await r.send('touchstart', 100)
    await r.send('touchmove', 106) // 6px: past the tap slop, under a row
    await r.send('touchmove', 100)
    await r.send('touchend', 100, 0)
    expect(r.ctl.tapMouse).not.toHaveBeenCalled()
    expect(r.ctl.focus).not.toHaveBeenCalled()
  })
  it('input cancellation drops queued legacy rows and disqualifies the release', async () => {
    const r = await mounted(false)
    await r.send('touchstart', 100)
    await r.send('touchmove', 140)
    r.ctl.scrollInputVersion.value++
    await nextTick()
    paint()
    expect(r.ctl.scroll).not.toHaveBeenCalled()
    await r.send('touchend', 140, 0)
    expect(r.ctl.tapMouse).not.toHaveBeenCalled()
    expect(r.ctl.focus).not.toHaveBeenCalled()
  })
  it.each([false, true])('keeps the keyboard closed after a tap on WebKit with beta=%s', async enabled => {
    vi.spyOn(navigator, 'vendor', 'get').mockReturnValue('Apple Computer, Inc.')
    const r = await mounted(enabled)
    r.ctl.tapOnCursor.mockReturnValue(true)
    await r.send('touchstart', 100)
    await r.send('touchend', 100, 0)
    await r.w.get('#touch').trigger('mousedown')
    expect(r.ctl.tapMouse).toHaveBeenCalledOnce()
    expect(r.ctl.focus).not.toHaveBeenCalled()
  })
  it.each([false, true])('keeps the keyboard closed for links with beta=%s', async enabled => {
    const r = await mounted(enabled)
    r.ctl.tapOnCursor.mockReturnValue(true)
    r.ctl.tapLink.mockReturnValue(true)
    await r.send('touchstart', 100)
    const end = new Event('touchend', { bubbles: true, cancelable: true })
    Object.defineProperty(end, 'changedTouches', { value: [{ clientX: 50, clientY: 100 }] })
    r.w.get('#touch').element.dispatchEvent(end)
    expect(end.defaultPrevented).toBe(true)
    // A compatibility mouse event delivered anyway cannot focus either.
    if (enabled) await r.w.get('#touch').trigger('mousedown')
    expect(r.ctl.tapLink).toHaveBeenCalledOnce()
    expect(r.ctl.tapMouse).not.toHaveBeenCalled()
    expect(r.ctl.focus).not.toHaveBeenCalled()
  })
  it('does not scroll until half a row accumulates', async () => {
    const r = await mounted(true)
    await r.send('touchstart', 100)
    await r.send('touchmove', 105)
    paint()
    expect(r.ctl.scroll).not.toHaveBeenCalled()
  })
  it('a scroll drag releases the keyboard unless an IME composition is in flight', async () => {
    const r = await mounted(true)
    r.ctl.hasFocus.mockReturnValue(true)
    await r.send('touchstart', 100)
    await r.send('touchmove', 140)
    expect(r.ctl.blur).toHaveBeenCalled()
    r.ctl.blur.mockClear()
    r.ctl.imeBusy.mockReturnValue(true)
    await r.send('touchstart', 100)
    await r.send('touchmove', 140)
    expect(r.ctl.blur).not.toHaveBeenCalled()
    expect(r.ctl.scroll).toHaveBeenCalled()
  })
  it('releases stale terminal focus at touchstart only while the keyboard is closed', async () => {
    const r = await mounted(true)
    r.ctl.hasFocus.mockReturnValue(true)
    kbOpen.value = false
    await r.send('touchstart', 100)
    expect(r.ctl.blur).toHaveBeenCalledOnce()
    r.ctl.blur.mockClear()
    kbOpen.value = true
    await r.send('touchstart', 100)
    expect(r.ctl.blur).not.toHaveBeenCalled()
  })
  it('falls back to legacy row scrolls when disabled during a gesture', async () => {
    const r = await mounted(true)
    await r.send('touchstart', 100)
    await r.send('touchmove', 140)
    expect(r.ctl.scroll.mock.calls).toEqual([[3]])
    smoothTouchScrolling.value = false
    await nextTick()
    await r.send('touchmove', 180)
    paint()
    expect(r.ctl.scroll.mock.calls).toEqual([[3]])
    await r.send('touchend', 180, 0)
    await r.send('touchstart', 100)
    await r.send('touchmove', 140)
    paint()
    expect(r.ctl.scroll.mock.calls).toEqual([[3], [2]])
  })
  it('cancels multitouch and removes every scheduled frame on unmount', async () => {
    const r = await mounted(true)
    await r.send('touchstart', 100)
    await r.send('touchmove', 140)
    await r.send('touchmove', 160, 2)
    paint()
    expect(r.ctl.scroll.mock.calls).toEqual([[3]])
    r.w.unmount(); unmount = undefined
    expect(frames.size).toBe(0)
    expect(r.ctl.dispose).toHaveBeenCalledOnce()
  })
  it.each([false, true])('the resize observer kills an armed hold but keeps the finger with beta=%s', async enabled => {
    vi.useFakeTimers()
    const r = await mounted(enabled)
    await r.send('touchstart', 100)
    // fitNow can resize locally before the echoed frame: no scrollGeometryVersion
    // bump fires, so the actual ResizeObserver callback must invalidate both modes.
    r.roFire()
    vi.advanceTimersByTime(600)
    expect(r.ctl.captureScreen).not.toHaveBeenCalled()
    // The release of the resized gesture is never a tap.
    await r.send('touchend', 100, 0)
    expect(r.ctl.tapMouse).not.toHaveBeenCalled()
    expect(r.ctl.focus).not.toHaveBeenCalled()
    // A fresh hold still enters copy mode — the next gesture is unaffected.
    await r.send('touchstart', 100)
    vi.advanceTimersByTime(600)
    expect(r.ctl.captureScreen).toHaveBeenCalledOnce()
  })
  it.each([false, true])('a wheel cancels a pending touch hold in either mode with beta=%s', async enabled => {
    vi.useFakeTimers()
    const r = await mounted(enabled)
    await r.send('touchstart', 100)
    await r.w.get('#termWrap').trigger('wheel', { deltaY: 40 })
    vi.advanceTimersByTime(600)
    expect(r.ctl.captureScreen).not.toHaveBeenCalled()
    // The cancelled gesture's release is never a tap either.
    await r.send('touchend', 100, 0)
    expect(r.ctl.tapMouse).not.toHaveBeenCalled()
    expect(r.ctl.focus).not.toHaveBeenCalled()
  })
  it.each([false, true])('a hold refused by an active IME releases without tap, blur or focus with beta=%s', async enabled => {
    vi.useFakeTimers()
    const r = await mounted(enabled)
    r.ctl.hasFocus.mockReturnValue(true)
    r.ctl.imeBusy.mockReturnValue(true)
    // Composition still active while the hold matures: refused before the
    // controller's capture is even consulted (document-level flag).
    document.dispatchEvent(new Event('compositionstart'))
    await r.send('touchstart', 100)
    vi.advanceTimersByTime(600)
    expect(r.ctl.captureScreen).not.toHaveBeenCalled()
    await r.send('touchend', 100, 0)
    expect(r.ctl.tapMouse).not.toHaveBeenCalled()
    expect(r.ctl.tapLink).not.toHaveBeenCalled()
    expect(r.ctl.blur).not.toHaveBeenCalled()
    expect(r.ctl.focus).not.toHaveBeenCalled()
    // Deferred commit: composition ended, the controller still refuses the
    // capture — the release of that hold is consumed the same way.
    document.dispatchEvent(new Event('compositionend'))
    await r.send('touchstart', 100)
    vi.advanceTimersByTime(600)
    expect(r.ctl.captureScreen).toHaveBeenCalledOnce()
    await r.send('touchend', 100, 0)
    expect(r.ctl.tapMouse).not.toHaveBeenCalled()
    expect(r.ctl.blur).not.toHaveBeenCalled()
    expect(r.ctl.focus).not.toHaveBeenCalled()
    // A short deliberate tap afterwards is untouched: it still acts and
    // still dismisses the keyboard (the smooth path may also release the
    // stale touchstart focus first — both blurs are intended).
    r.ctl.imeBusy.mockReturnValue(false)
    r.ctl.blur.mockClear()
    await r.send('touchstart', 100)
    await r.send('touchend', 100, 0)
    expect(r.ctl.tapMouse).toHaveBeenCalledOnce()
    expect(r.ctl.blur).toHaveBeenCalled()
  })
  it.each([false, true])('a horizontal pan releases the keyboard like a vertical drag with beta=%s', async enabled => {
    const r = await mounted(enabled)
    const xterm = r.w.get('.xterm').element as HTMLElement
    Object.defineProperties(xterm, { scrollWidth: { value: 600, configurable: true }, clientWidth: { value: 300, configurable: true } })
    r.ctl.hasFocus.mockReturnValue(true)
    kbOpen.value = true
    await r.send('touchstart', 100)
    await r.send('touchmove', 100, 1, 20)
    paint()
    expect(xterm.scrollLeft).toBeGreaterThan(0)
    expect(r.ctl.blur).toHaveBeenCalled()
  })
  it.each([false, true])('a horizontal pan keeps the keyboard while an IME composition is in flight with beta=%s', async enabled => {
    const r = await mounted(enabled)
    const xterm = r.w.get('.xterm').element as HTMLElement
    Object.defineProperties(xterm, { scrollWidth: { value: 600, configurable: true }, clientWidth: { value: 300, configurable: true } })
    r.ctl.hasFocus.mockReturnValue(true)
    r.ctl.imeBusy.mockReturnValue(true)
    kbOpen.value = true
    await r.send('touchstart', 100)
    await r.send('touchmove', 100, 1, 20)
    paint()
    expect(xterm.scrollLeft).toBeGreaterThan(0)
    expect(r.ctl.blur).not.toHaveBeenCalled()
  })
  it.each([false, true])('a wheel stream keeps its coalesced lines across per-event touch cancellation with beta=%s', async enabled => {
    const r = await mounted(enabled)
    // 4 x 24px at 16px/row: the fractional rests carry between events —
    // -1/-2/-1/-2 whole lines coalesce to a single -6 flush.
    for (let i = 0; i < 4; i++) await r.w.get('#termWrap').trigger('wheel', { deltaY: 24 })
    paint()
    const total = r.ctl.scroll.mock.calls.reduce((n: number, [lines]) => n + (lines as number), 0)
    expect(total).toBe(-6)
    // Preservation is only across consecutive wheel events: a new gesture
    // kills the queued rows and their frame before it fires.
    r.ctl.scroll.mockClear()
    for (let i = 0; i < 2; i++) await r.w.get('#termWrap').trigger('wheel', { deltaY: 24 })
    await r.send('touchstart', 100)
    paint()
    expect(r.ctl.scroll).not.toHaveBeenCalled()
  })
  it.each([false, true])('a composition started during an armed hold consumes its release with beta=%s', async enabled => {
    vi.useFakeTimers()
    const r = await mounted(enabled)
    r.ctl.hasFocus.mockReturnValue(true)
    r.ctl.imeBusy.mockReturnValue(true)
    await r.send('touchstart', 100)
    vi.advanceTimersByTime(200)
    // The IME claims the keyboard mid-hold: the hold's timer dies but its
    // release must still be consumed — it lands on an active composition.
    document.dispatchEvent(new Event('compositionstart'))
    vi.advanceTimersByTime(600)
    expect(r.ctl.captureScreen).not.toHaveBeenCalled()
    await r.send('touchend', 100, 0)
    expect(r.ctl.tapMouse).not.toHaveBeenCalled()
    expect(r.ctl.tapLink).not.toHaveBeenCalled()
    expect(r.ctl.blur).not.toHaveBeenCalled()
    expect(r.ctl.focus).not.toHaveBeenCalled()
    // After the composition a short deliberate tap still works normally.
    document.dispatchEvent(new Event('compositionend'))
    r.ctl.imeBusy.mockReturnValue(false)
    await r.send('touchstart', 100)
    await r.send('touchend', 100, 0)
    expect(r.ctl.tapMouse).toHaveBeenCalledOnce()
  })
  it.each([false, true])('a watching transform survives movement and cancellation with beta=%s', async enabled => {
    const r = await mounted(enabled)
    // The watching viewer's followCursor translateY belongs to the
    // controller: no gesture, cancellation or release may rewrite it.
    const screen = r.w.get('.xterm-screen').element as HTMLElement
    screen.style.transform = 'translateY(-40px)'
    await r.send('touchstart', 100)
    await r.send('touchmove', 140)
    paint()
    expect(r.ctl.scroll).toHaveBeenCalled()
    r.ctl.scrollInputVersion.value++
    await nextTick()
    await r.send('touchend', 140, 0)
    expect(screen.style.transform).toBe('translateY(-40px)')
  })
})
