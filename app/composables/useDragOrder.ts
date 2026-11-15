// Reorder a list by dragging: the item follows the pointer, the others make
// room (transforms only) and `drop` gets the new order on release. Items are
// the `[data-order-id]` elements under `list`, in page order. `grab` starts from a
// handle (mouse, pen); `hold` from the row itself on a touch screen, after a
// long press (moving earlier is a scroll); `key` moves with the arrow keys.
import type { Ref } from 'vue'

type Drag = { id: string, ids: string[], from: number, dy: number, to: number, h: number }
const HOLD_MS = 300
const SLOP = 8

export function useDragOrder(list: Ref<HTMLElement | null>, drop: (ids: string[], moved: string) => void) {
  const drag = ref<Drag | null>(null)
  let droppedAt = 0
  const slots = () => [...(list.value?.querySelectorAll<HTMLElement>('[data-order-id]') || [])]
  const moved = (ids: string[], id: string, to: number) => { const next = ids.filter(x => x !== id); next.splice(to, 0, id); return next }

  function shift(id: string) {
    const d = drag.value
    const i = d ? d.ids.indexOf(id) : -1
    if (!d || i < 0) return undefined
    if (i === d.from) return `translateY(${d.dy}px)`
    if (d.from < i && i <= d.to) return `translateY(${-d.h}px)`
    if (d.to <= i && i < d.from) return `translateY(${d.h}px)`
    return undefined
  }

  let release: (() => void) | null = null
  onBeforeUnmount(() => release?.())
  const blockScroll = (e: TouchEvent) => e.preventDefault()
  function follow(e: PointerEvent, start: () => boolean, now: boolean) {
    const y0 = e.clientY
    const x0 = e.clientX
    let mids: number[] = []
    const begin = () => {
      if (!start()) return release?.()
      // iOS: the page stays still while the row moves.
      document.addEventListener('touchmove', blockScroll, { passive: false })
      mids = slots().map((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 })
    }
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      const d = drag.value
      if (!d) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > SLOP) release?.(); return }
      const dy = ev.clientY - y0
      const y = mids[d.from]! + dy
      // Its new place: the number of other items whose middle is above its own.
      const to = mids.filter((m, i) => i !== d.from && m < y).length
      if (to !== d.to) haptic()
      drag.value = { ...d, dy, to }
    }
    const end = (save: boolean) => (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      const d = drag.value
      release?.()
      if (!d) return
      droppedAt = Date.now()
      if (save && d.to !== d.from) drop(moved(d.ids, d.id, d.to), d.id)
    }
    const up = end(true)
    const cancel = end(false)
    release?.()
    let timer: ReturnType<typeof setTimeout> | undefined
    release = () => {
      release = null
      clearTimeout(timer)
      drag.value = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      document.removeEventListener('touchmove', blockScroll)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    if (now) begin()
    else timer = setTimeout(begin, HOLD_MS)
  }
  const starter = (id: string) => () => {
    const ids = slots().map(el => el.dataset.orderId!)
    const from = ids.indexOf(id)
    if (from < 0) return false
    drag.value = { id, ids, from, dy: 0, to: from, h: slots()[from]!.getBoundingClientRect().height }
    haptic()
    return true
  }
  return {
    drag,
    shift,
    grab(id: string, e: PointerEvent) {
      if (drag.value || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
      e.preventDefault()
      follow(e, starter(id), true)
    },
    hold(id: string, e: PointerEvent) {
      if (drag.value || !e.isPrimary || e.pointerType !== 'touch') return
      follow(e, starter(id), false)
    },
    key(id: string, e: KeyboardEvent) {
      const ids = slots().map(el => el.dataset.orderId!)
      const at = ids.indexOf(id)
      const to = e.key === 'ArrowUp' ? at - 1 : e.key === 'ArrowDown' ? at + 1 : -1
      if (at < 0 || to < 0 || to >= ids.length) return
      e.preventDefault()
      drop(moved(ids, id, to), id)
      nextTick(() => list.value?.querySelector<HTMLElement>(`[data-order-id="${CSS.escape(id)}"] [data-grip]`)?.focus())
    },
    // The click that ends a drag is not a tap.
    swallowClick: () => Date.now() - droppedAt < 400,
  }
}
