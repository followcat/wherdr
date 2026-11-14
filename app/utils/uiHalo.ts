// Point at a place in a scrolling view: wait for it, keep it in view while the
// content above it loads, and highlight it with a halo (`.ui-halo` in main.css:
// an outline and a shadow, so the element's layout never changes and the halo
// follows scroll and resize). Used by Settings for `&target=` (shared/uiTargets.ts).

const shown = (el: Element | null): el is HTMLElement => !!el && el.getClientRects().length > 0

// The first element matching `selector` under `root` that is shown, as soon as
// there is one; null after `ms`.
export function waitForElement(root: HTMLElement, selector: string, ms = 3000): Promise<HTMLElement | null> {
  const find = () => [...root.querySelectorAll(selector)].find(shown) ?? null
  const now = find()
  if (now || typeof MutationObserver === 'undefined') return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = (el: HTMLElement | null) => { mo.disconnect(); clearTimeout(timer); resolve(el) }
    const mo = new MutationObserver(() => { const el = find(); if (el) done(el) })
    mo.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] })
    const timer = setTimeout(() => done(null), ms)
  })
}

// Scroll `el` to the top of `scroller` (a little room above for the halo), and
// keep it there while what is above finishes loading, until the user scrolls
// or for `ms`. Returns the function that stops following.
export function followElement(scroller: HTMLElement, el: HTMLElement, ms = 3000): () => void {
  const place = () => { scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12 }
  place()
  if (typeof ResizeObserver === 'undefined' || !scroller.firstElementChild) return () => {}
  const ro = new ResizeObserver(place)
  ro.observe(scroller.firstElementChild)
  const events = ['wheel', 'touchstart', 'keydown'] as const
  const stop = () => {
    ro.disconnect()
    clearTimeout(timer)
    for (const ev of events) scroller.removeEventListener(ev, stop)
  }
  const timer = setTimeout(stop, ms)
  for (const ev of events) scroller.addEventListener(ev, stop, { passive: true })
  return stop
}

// The halo: pulses twice then fades (CSS, still under reduced motion), and goes
// at once on a click or a key press anywhere. Returns the function that ends it.
export const HALO_MS = 4000
export function showHalo(el: HTMLElement, ms = HALO_MS): () => void {
  el.classList.remove('ui-halo')
  void el.offsetWidth // restart the animation when the same element is pointed at again
  el.classList.add('ui-halo')
  const end = () => {
    el.classList.remove('ui-halo')
    clearTimeout(timer)
    document.removeEventListener('pointerdown', end, true)
    document.removeEventListener('keydown', end, true)
  }
  const timer = setTimeout(end, ms)
  document.addEventListener('pointerdown', end, true)
  document.addEventListener('keydown', end, true)
  return end
}
