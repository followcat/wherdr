import { liftsOn } from './touchTap'

// Focus synchronously on touchend for iOS, while allowing the key strip to scroll.
export function createKeyboardTap(run: () => void) {
  let kbdTouch: { id: number, x: number, y: number } | null = null
  let kbdTouchAt = -Infinity
  function start(e: TouchEvent) {
    const t = e.changedTouches[0]
    kbdTouch = e.touches.length === 1 && t ? { id: t.identifier, x: t.clientX, y: t.clientY } : null
  }
  function move(e: TouchEvent) {
    const t = kbdTouch && Array.from(e.changedTouches).find(c => c.identifier === kbdTouch!.id)
    if (t && Math.hypot(t.clientX - kbdTouch!.x, t.clientY - kbdTouch!.y) > 10) kbdTouch = null
  }
  function end(e: TouchEvent) {
    const t = kbdTouch && Array.from(e.changedTouches).find(c => c.identifier === kbdTouch!.id)
    kbdTouch = null
    if (!t) return
    const el = e.currentTarget as Element | null
    if (!el || !liftsOn(el.getBoundingClientRect(), t.clientX, t.clientY)) return
    // No click after this touch; if a browser still makes one, it is ignored.
    e.preventDefault()
    kbdTouchAt = performance.now()
    run()
  }
  function cancel() { kbdTouch = null }
  function click() {
    if (performance.now() - kbdTouchAt < 700) return
    run()
  }
  return { start, move, end, cancel, click }
}
