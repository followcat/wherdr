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
  let resize = () => {}
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} })
  const ctl = {
    mount: vi.fn((el: HTMLElement) => { el.innerHTML = '<div class="xterm"><div class="xterm-screen">terminal grid</div></div>' }),
    scroll: vi.fn(() => true), rowHeight: () => 16, pageRows: () => 24,
    fitNow: vi.fn(), hasBanner: () => true, connect: vi.fn(), dispose: vi.fn(),
    focus: vi.fn(), blur: vi.fn(), tapLink: vi.fn(() => false), tapMouse: vi.fn(),
    cancelTouchScroll: vi.fn(), scrollInputVersion: ref(0), scrollGeometryVersion: ref(0), scrollAck: ref(0), frameTick: ref(0),
    loading: ref(false), selectionHint: { visible: ref(false), dismiss: vi.fn() },
    mouseMode: ref(coarse),
    requestScrollback: vi.fn(), scrollback: ref(''), scrollbackVersion: ref(0),
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
  return { w, ctl, send, resize: () => resize(), screen: () => w.get('.xterm-screen').attributes('style') || '' }
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
  it('keeps the rendered grid fixed through drag, repaint and acknowledgement', async () => {
    const r = await mounted(true)
    await r.send('touchstart', 100)
    for (const y of [140, 172, 124]) {
      await r.send('touchmove', y)
      expect(r.screen()).not.toContain('translate')
      paint()
      r.ctl.scrollAck.value += 2
      r.ctl.frameTick.value++
      await nextTick()
      expect(r.screen()).not.toContain('translate')
    }
    r.ctl.scrollInputVersion.value++
    await nextTick()
    expect(frames.size).toBe(0)
    expect(r.ctl.cancelTouchScroll).toHaveBeenCalled()
  })
  it('continues the same finger drag after terminal geometry changes', async () => {
    const r = await mounted(true)
    await r.send('touchstart', 100)
    await r.send('touchmove', 132)
    paint()
    r.resize()
    r.ctl.scrollGeometryVersion.value++
    await nextTick()
    await r.send('touchmove', 164)
    paint()
    expect(r.ctl.scroll.mock.calls.map(call => call[0])).toEqual([2, 2])
  })
  it('does not discard real drag input while the finger holds still awaiting a frame', async () => {
    const r = await mounted(true)
    vi.useFakeTimers()
    await r.send('touchstart', 100)
    await r.send('touchmove', 164)
    paint()
    r.ctl.cancelTouchScroll.mockClear()
    vi.advanceTimersByTime(300)
    expect(r.ctl.cancelTouchScroll).not.toHaveBeenCalled()
  })
  it.each([false, true])('does not turn a sub-row drag into a keyboard tap with beta=%s', async enabled => {
    const r = await mounted(enabled)
    await r.send('touchstart', 100)
    await r.send('touchmove', 107)
    await r.send('touchend', 107, 0)
    await r.w.get('#touch').trigger('mousedown')
    expect(r.ctl.focus).not.toHaveBeenCalled()
    expect(r.ctl.tapMouse).not.toHaveBeenCalled()
  })
  it.each([false, true])('checks the release point when no touchmove arrived with beta=%s', async enabled => {
    const r = await mounted(enabled)
    await r.send('touchstart', 100)
    await r.send('touchend', 107, 0)
    expect(r.ctl.focus).not.toHaveBeenCalled()
    expect(r.ctl.tapMouse).not.toHaveBeenCalled()
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
  it('waits for a full row without moving the screen at the gesture threshold', async () => {
    const r = await mounted(true)
    await r.send('touchstart', 100)
    await r.send('touchmove', 105)
    paint()
    expect(r.ctl.scroll).not.toHaveBeenCalled()
    expect(r.screen()).not.toContain('translate')
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
