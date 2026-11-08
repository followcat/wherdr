// Drag a list row by its handle (mouse, finger, pen), as in
// PhoneKeyOrderSettings.vue: the row follows the pointer, the others make
// room, `drop(id, to)` runs on release. Rows carry `data-row="<id>"`.
export function useRowDrag(list: Ref<HTMLElement | null>, drop: (id: string, to: number) => void) {
  const drag = ref<{ id: string, from: number, dy: number, to: number, h: number } | null>(null)
  function shift(i: number) {
    const d = drag.value
    if (!d) return undefined
    if (i === d.from) return `translateY(${d.dy}px)`
    if (d.from < i && i <= d.to) return `translateY(${-d.h}px)`
    if (d.to <= i && i < d.from) return `translateY(${d.h}px)`
    return undefined
  }
  const blockScroll = (e: TouchEvent) => { if (drag.value) e.preventDefault() }
  let release: (() => void) | null = null
  onBeforeUnmount(() => release?.())
  function onGrab(id: string, e: PointerEvent) {
    if (drag.value || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
    e.preventDefault()
    const els = [...(list.value?.querySelectorAll<HTMLElement>('[data-row]') || [])]
    const from = els.findIndex(el => el.dataset.row === id)
    if (from < 0) return
    const mids = els.map((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 })
    const y0 = e.clientY
    drag.value = { id, from, dy: 0, to: from, h: els[from]!.getBoundingClientRect().height }
    haptic()
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId || !drag.value) return
      const dy = ev.clientY - y0
      const to = mids.filter((m, i) => i !== from && m < mids[from]! + dy).length
      if (to !== drag.value.to) haptic()
      drag.value = { ...drag.value, dy, to }
    }
    const end = (save: boolean) => (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      const d = drag.value
      release?.()
      if (save && d && d.to !== d.from) drop(id, d.to)
    }
    const up = end(true), cancel = end(false)
    release = () => {
      release = null
      drag.value = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      document.removeEventListener('touchmove', blockScroll)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    // iOS: the page stays still while the row moves.
    document.addEventListener('touchmove', blockScroll, { passive: false })
  }
  return { drag, shift, onGrab }
}
