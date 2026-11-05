import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick, ref } from 'vue'
import TerminalView from '~/components/TerminalView.vue'
import { pageVisible, smoothTouchScrolling } from '~/composables/useHerdr'
import type { TerminalCopySnapshot } from '~/utils/terminalCopy'

// One stationary finger held 480 ms freezes the visible screen for copy.
// Movement, a second finger, an IME composition, a page hide, a reconnect or
// a refused capture each cancel the hold before anything happens.
beforeAll(async () => {
  const app = await mountSuspended({ template: '<div />' })
  app.unmount()
}, 60_000)

const snapshot: TerminalCopySnapshot = {
  lines: [[{ text: 'frozen row' }], [{ text: 'second' }]],
  columns: 40,
  fontFamily: 'monospace',
  fontSize: 13,
}

let unmount: (() => void) | undefined
const pt = (x: number, y: number) => ({ clientX: x, clientY: y })

async function mounted(smooth: boolean, screen: TerminalCopySnapshot | null = snapshot) {
  smoothTouchScrolling.value = smooth
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const calls: string[] = []
  const ctl = {
    mount: vi.fn(async (el: HTMLElement) => {
      el.innerHTML = '<div class="xterm"><div class="xterm-screen">terminal grid</div></div>'
      return true
    }),
    scroll: vi.fn(() => true), rowHeight: () => 16, pageRows: () => 24,
    fitNow: vi.fn(), hasBanner: () => true, connect: vi.fn(), dispose: vi.fn(),
    focus: vi.fn(), blur: vi.fn(() => calls.push('blur')),
    tapLink: vi.fn(() => false), tapMouse: vi.fn(), tapOnCursor: vi.fn(() => false),
    hasFocus: () => false, imeBusy: () => false,
    clearVirtualModifiers: vi.fn(() => calls.push('mods')),
    captureScreen: vi.fn(() => { calls.push('capture'); return screen }),
    scrollInputVersion: ref(0), scrollGeometryVersion: ref(0), frameTick: ref(0),
    loading: ref(false), selectionHint: { visible: ref(false), dismiss: vi.fn() },
  }
  // emitted() is reset by unmount: a parent listener sees the whole session,
  // including the final copying(false) released while the view tears down.
  const copying: boolean[] = []
  const w = await mountSuspended(TerminalView, {
    props: { ctl: ctl as unknown as TerminalCtl, onCopying: (v: boolean) => { copying.push(v) } },
  })
  unmount = () => w.unmount()
  const layer = w.get('#touch')
  const touch = (type: string, x: number, y: number, count = 1) => layer.trigger(type, {
    touches: Array.from({ length: count }, () => pt(x, y)),
    changedTouches: [pt(x, y)],
  })
  return { w, ctl, calls, touch, copying }
}

afterEach(() => {
  unmount?.()
  unmount = undefined
  pageVisible.value = true
  smoothTouchScrolling.value = false
  localStorage.removeItem('smoothTouchScrolling')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe.each([false, true])('long-press copy entry (smooth=%s)', smooth => {
  it('freezes the screen after a stationary 480 ms hold and emits copying once', async () => {
    const r = await mounted(smooth)
    vi.useFakeTimers()
    await r.touch('touchstart', 50, 100)
    await vi.advanceTimersByTimeAsync(480)
    await nextTick()
    expect(r.ctl.captureScreen).toHaveBeenCalledTimes(1)
    // The screen is frozen before the terminal blurs: a resize from the
    // keyboard closing could never change what was copied.
    expect(r.calls).toEqual(['capture', 'mods', 'blur'])
    expect(r.copying).toEqual([true])
    expect(r.w.get('.terminal-copy-text').text()).toBe('frozen row\nsecond')
    // A second hold does not recapture: the snapshot stays the one taken.
    await r.touch('touchstart', 60, 110)
    await vi.advanceTimersByTimeAsync(600)
    expect(r.ctl.captureScreen).toHaveBeenCalledTimes(1)
    expect(r.copying).toEqual([true])
  })

  it('cancels a hold that reaches the 5px drag threshold, even if it moves back', async () => {
    const r = await mounted(smooth)
    vi.useFakeTimers()
    await r.touch('touchstart', 50, 100)
    // 3-4-5: exactly the axis-lock distance, in either scroll mode.
    await r.touch('touchmove', 53, 104)
    await vi.advanceTimersByTimeAsync(200)
    await r.touch('touchmove', 50, 100)
    await vi.advanceTimersByTimeAsync(600)
    expect(r.ctl.captureScreen).not.toHaveBeenCalled()
    expect(r.copying).toEqual([])
    expect(r.w.find('.terminal-copy-layer').exists()).toBe(false)
  })

  it('cancels on a second finger, whether it arrives by move or start', async () => {
    const r = await mounted(smooth)
    vi.useFakeTimers()
    await r.touch('touchstart', 50, 100)
    await r.touch('touchmove', 50, 100, 2)
    await vi.advanceTimersByTimeAsync(600)
    expect(r.ctl.captureScreen).not.toHaveBeenCalled()
    expect(r.copying).toEqual([])
    // A stationary second finger's own touchstart is just as fatal.
    await r.touch('touchend', 50, 100)
    await r.touch('touchstart', 50, 100)
    await r.touch('touchstart', 50, 100, 2)
    await vi.advanceTimersByTimeAsync(600)
    expect(r.ctl.captureScreen).not.toHaveBeenCalled()
    expect(r.copying).toEqual([])
  })

  it('refuses while an IME composition is open, without disturbing it', async () => {
    const r = await mounted(smooth)
    vi.useFakeTimers()
    document.dispatchEvent(new Event('compositionstart'))
    await r.touch('touchstart', 50, 100)
    await vi.advanceTimersByTimeAsync(600)
    expect(r.ctl.captureScreen).not.toHaveBeenCalled()
    // Entry must never blur, cancel or flush the live IME session.
    expect(r.ctl.blur).not.toHaveBeenCalled()
    expect(r.copying).toEqual([])
    // Once the composition ends, a fresh hold enters normally.
    document.dispatchEvent(new Event('compositionend'))
    await r.touch('touchend', 50, 100)
    await r.touch('touchstart', 50, 100)
    await vi.advanceTimersByTimeAsync(480)
    await nextTick()
    expect(r.copying).toEqual([true])
  })

  it('refuses when the controller reports a pending deferred commit', async () => {
    const r = await mounted(smooth, null)
    vi.useFakeTimers()
    await r.touch('touchstart', 50, 100)
    await vi.advanceTimersByTimeAsync(600)
    await nextTick()
    expect(r.ctl.captureScreen).toHaveBeenCalledTimes(1)
    expect(r.ctl.blur).not.toHaveBeenCalled()
    expect(r.copying).toEqual([])
    expect(r.w.find('.terminal-copy-layer').exists()).toBe(false)
  })

  it('cancels when the page hides mid-hold', async () => {
    const r = await mounted(smooth)
    vi.useFakeTimers()
    await r.touch('touchstart', 50, 100)
    pageVisible.value = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(600)
    expect(r.ctl.captureScreen).not.toHaveBeenCalled()
    expect(r.copying).toEqual([])
  })

  it('cancels a pending hold when the terminal reconnects', async () => {
    const r = await mounted(smooth)
    vi.useFakeTimers()
    await r.touch('touchstart', 50, 100)
    r.ctl.loading.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(600)
    expect(r.ctl.captureScreen).not.toHaveBeenCalled()
    expect(r.copying).toEqual([])
  })

  it('refuses when the pinch scale changed during the hold', async () => {
    const vp = { scale: 1 }
    vi.stubGlobal('visualViewport', vp)
    const r = await mounted(smooth)
    vi.useFakeTimers()
    await r.touch('touchstart', 50, 100)
    vp.scale = 2
    await vi.advanceTimersByTimeAsync(600)
    expect(r.ctl.captureScreen).not.toHaveBeenCalled()
    expect(r.copying).toEqual([])
  })
})

describe('frozen screen session', () => {
  async function held() {
    const r = await mounted(true)
    vi.useFakeTimers()
    await r.touch('touchstart', 50, 100)
    await vi.advanceTimersByTimeAsync(480)
    await nextTick()
    return r
  }

  it('keeps the snapshot stable across live output, scroll and reconnect', async () => {
    const r = await held()
    expect(r.w.get('.terminal-copy-text').text()).toBe('frozen row\nsecond')
    r.ctl.frameTick.value++
    r.ctl.scrollInputVersion.value++
    r.ctl.loading.value = true
    await nextTick()
    expect(r.w.get('.terminal-copy-text').text()).toBe('frozen row\nsecond')
    expect(r.ctl.captureScreen).toHaveBeenCalledTimes(1)
  })

  it('closes the input gate before blur can emit a focus-report packet', async () => {
    const r = await mounted(true)
    vi.useFakeTimers()
    const sent: string[] = []
    // xterm emits ESC[O through onData when its textarea blurs and focus
    // reporting is enabled (Terminal.ts sendFocus). The owner's input() gate
    // reads the copying event exactly like AgentView, so it must already be
    // closed when blur runs — inert renders too late for the sync path.
    r.ctl.blur = vi.fn(() => {
      r.calls.push('blur')
      if (r.copying.at(-1) !== true) sent.push('\x1b[O')
    })
    await r.touch('touchstart', 50, 100)
    await vi.advanceTimersByTimeAsync(480)
    await nextTick()
    expect(sent).toEqual([])
    expect(r.copying).toEqual([true])
    // The snapshot still reads the screen captured before the blur.
    expect(r.w.get('.terminal-copy-text').text()).toBe('frozen row\nsecond')
    expect(r.calls).toEqual(['capture', 'mods', 'blur'])
  })

  it('consumes the entry finger\'s release and the first context menu only', async () => {
    const r = await mounted(true)
    vi.useFakeTimers()
    let now = 10_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    await r.touch('touchstart', 50, 100)
    await vi.advanceTimersByTimeAsync(480)
    await nextTick()
    const end = new Event('touchend', { bubbles: true, cancelable: true })
    Object.defineProperty(end, 'changedTouches', { value: [pt(50, 100)] })
    document.body.dispatchEvent(end)
    expect(end.defaultPrevented).toBe(true)
    expect(r.ctl.tapMouse).not.toHaveBeenCalled()
    const menu = new Event('contextmenu', { bubbles: true, cancelable: true })
    document.body.dispatchEvent(menu)
    expect(menu.defaultPrevented).toBe(true)
    // Once the entry finger is up and the suppression window passed,
    // Android's own selection menu keeps working.
    now = 20_000
    const later = new Event('contextmenu', { bubbles: true, cancelable: true })
    document.body.dispatchEvent(later)
    expect(later.defaultPrevented).toBe(false)
  })

  it('keeps the wheel and the mouse out of the live terminal', async () => {
    const r = await held()
    await r.w.get('#termWrap').trigger('wheel', { deltaY: 120 })
    expect(r.ctl.scroll).not.toHaveBeenCalled()
    await r.w.get('#touch').trigger('mousedown')
    expect(r.ctl.focus).not.toHaveBeenCalled()
  })

  it('Done exits and emits copying false without focusing the terminal', async () => {
    const r = await held()
    await r.w.findAll('button').find(b => b.text() === 'Done')!.trigger('click')
    await nextTick()
    expect(r.copying).toEqual([true, false])
    expect(r.w.find('.terminal-copy-layer').exists()).toBe(false)
    expect(r.ctl.focus).not.toHaveBeenCalled()
  })

  it('releases the copy state on unmount', async () => {
    const r = await held()
    r.w.unmount()
    unmount = undefined
    expect(r.copying).toEqual([true, false])
    expect(r.ctl.dispose).toHaveBeenCalledOnce()
  })
})
