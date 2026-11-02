import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import Keybar from '~/components/Keybar.vue'

beforeAll(async () => {
  const app = await mountSuspended({ template: '<div />' })
  app.unmount()
}, 60_000)

let unmount: (() => void) | undefined
afterEach(() => { unmount?.(); unmount = undefined; vi.restoreAllMocks() })

async function mounted(focused = false, compact = false) {
  let has = focused
  const ctl = {
    lastVirtualChord: ref(''), virtualModifiers: ref([]), toggleModifier: vi.fn(), sendVirtualKey: vi.fn(), kbdOn: ref(focused),
    hasFocus: () => has,
    focus: vi.fn(() => { has = true }), blur: vi.fn(() => { has = false }),
  }
  const w = await mountSuspended(Keybar, { props: { ctl: ctl as unknown as TerminalCtl, compact, terminal: true } })
  unmount = () => w.unmount()
  const btn = w.get(`button[aria-label="${compact ? 'Show or hide the phone keyboard' : 'Type in terminal'}"]`)
  // Geometry is fixed here; real touch hit testing is covered by Playwright.
  vi.spyOn(btn.element, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 44, bottom: 44 } as DOMRect)
  const touch = (type: string, x = 5, y = 5) => btn.trigger(type, {
    touches: type === 'touchend' ? [] : [{ identifier: 1, clientX: x, clientY: y }],
    changedTouches: [{ identifier: 1, clientX: x, clientY: y }],
  })
  return { ctl, btn, touch }
}

describe.each([false, true])('key bar keyboard button (compact=%s)', compact => {
  // iOS: with a tap on the terminal no longer opening the keyboard, this button
  // is the way to it, so it must not depend on the click Safari may drop.
  it('opens the keyboard on the touch itself, without waiting for a click', async () => {
    const r = await mounted(false, compact)
    await r.touch('touchstart')
    await r.touch('touchend')
    expect(r.ctl.focus).toHaveBeenCalledOnce()
    // The click the browser may still make of that touch does not undo it.
    await r.btn.trigger('click')
    expect(r.ctl.blur).not.toHaveBeenCalled()
    expect(r.ctl.focus).toHaveBeenCalledOnce()
  })
  it('closes the keyboard on a touch when the terminal has it', async () => {
    const r = await mounted(true, compact)
    await r.touch('touchstart')
    await r.touch('touchend')
    expect(r.ctl.blur).toHaveBeenCalledOnce()
    expect(r.ctl.focus).not.toHaveBeenCalled()
  })
  it('does nothing when the finger scrolls the bar', async () => {
    const r = await mounted(false, compact)
    await r.touch('touchstart', 5, 5)
    await r.touch('touchmove', 40, 5)
    await r.touch('touchend', 40, 5)
    expect(r.ctl.focus).not.toHaveBeenCalled()
  })
  it('does nothing after a cancelled touch', async () => {
    const r = await mounted(false, compact)
    await r.touch('touchstart')
    await r.touch('touchcancel')
    await r.touch('touchend')
    expect(r.ctl.focus).not.toHaveBeenCalled()
  })
  it('still works with a mouse click', async () => {
    const r = await mounted(false, compact)
    await r.btn.trigger('click')
    expect(r.ctl.focus).toHaveBeenCalledOnce()
  })
})
