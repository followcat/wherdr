<script setup lang="ts">
// App window: sheet at the bottom of the screen on the phone, centered window
// on a computer (≥ 900 px, or a tablet). Escape or a tap outside closes it; on the phone,
// so do a tap on the handle and a swipe down from the handle, the header, or
// the content while it is scrolled to its top.
import { PHONE_QUERY } from '~/utils/layoutMode'
// `screen`: full-screen view on the phone instead of a sheet (page color,
// safe areas included); unchanged on a computer. The `footer` slot stays
// pinned under the scrolling content (above the home bar or the keyboard).
// `top`: above the other windows (a confirmation asked from an open sheet).
import { SHEET_DRAG_SLOP, sheetDragCloses, sheetDragOffset } from '~/utils/sheetDrag'

const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ hideClose?: boolean, title?: string, tall?: boolean, wide?: boolean, full?: boolean, screen?: boolean, top?: boolean }>()
const emit = defineEmits<{ closed: [] }>()
const slots = defineSlots<{ default?: () => unknown, footer?: () => unknown }>()
watch(open, (v, old) => { if (old && !v) emit('closed') })
const ui = computed(() => ({
  overlay: `hw-scrim${props.screen ? ' screen' : ''}${props.top ? ' top' : ''}`,
  content: `hw-sheet${props.tall ? ' tall' : ''}${props.wide ? ' wide' : ''}${props.full ? ' full' : ''}${props.screen ? ' screen' : ''}${props.top ? ' top' : ''}`,
}))

// Swipe down: the sheet follows the finger, then closes or springs back.
let drag: { sheet: HTMLElement, fromHandle: boolean, y0: number, y: number, t: number, v: number, dragging: boolean } | null = null
function dragStart(e: TouchEvent, fromHandle: boolean) {
  if (props.screen || e.touches.length !== 1 || !matchMedia(PHONE_QUERY).matches) return
  const el = e.currentTarget as HTMLElement
  const sheet = el.closest<HTMLElement>('.hw-sheet')
  if (!sheet || (!fromHandle && el.scrollTop > 0)) return
  const y = e.touches[0]!.clientY
  drag = { sheet, fromHandle, y0: y, y, t: e.timeStamp, v: 0, dragging: false }
}
function dragMove(e: TouchEvent) {
  if (!drag) return
  const y = e.touches[0]!.clientY
  const dy = y - drag.y0
  if (!drag.dragging) {
    if (dy < -SHEET_DRAG_SLOP && !drag.fromHandle) drag = null // scrolling the content up
    else if (dy > SHEET_DRAG_SLOP) {
      drag.dragging = true
      drag.sheet.style.transition = 'none'
    }
    if (!drag?.dragging) return
  }
  e.preventDefault()
  const dt = e.timeStamp - drag.t
  if (dt > 0) drag.v = (y - drag.y) / dt
  drag.y = y
  drag.t = e.timeStamp
  drag.sheet.style.transform = `translateY(${sheetDragOffset(dy)}px)`
}
function dragEnd(e: TouchEvent) {
  const d = drag
  drag = null
  if (!d?.dragging) return
  e.preventDefault() // no click on the handle after a drag
  if (sheetDragCloses(d.y - d.y0, d.v, d.sheet.offsetHeight)) {
    // The closing animation starts from where the finger left the sheet.
    d.sheet.style.transition = ''
    open.value = false
    return
  }
  d.sheet.style.transition = 'transform .2s cubic-bezier(.2, .8, .2, 1)'
  d.sheet.style.transform = ''
}
</script>

<template>
  <UModal v-model:open="open" :title="title" :ui="ui">
    <template #content>
      <button
        v-if="!screen" type="button" class="hw-sheet-handle" :aria-label="tl('Close', 'Fermer')"
        @click="open = false" @touchstart.passive="dragStart($event, true)" @touchmove="dragMove" @touchend="dragEnd" @touchcancel="dragEnd"
      />
      <div
        v-if="title" data-slot="header" class="hw-sheet-head"
        @touchstart.passive="dragStart($event, true)" @touchmove="dragMove" @touchend="dragEnd" @touchcancel="dragEnd"
      >
        <span class="hw-sheet-title" aria-hidden="true">{{ title }}</span>
        <UButton v-if="!hideClose" icon="i-lucide-x" color="neutral" variant="ghost" data-slot="close" class="hw-sheet-close" :aria-label="tl('Close', 'Fermer')" @click="open = false" />
      </div>
      <div
        data-slot="body" class="hw-sheet-body"
        @touchstart.passive="dragStart($event, false)" @touchmove="dragMove" @touchend="dragEnd" @touchcancel="dragEnd"
      >
        <slot />
      </div>
      <div v-if="slots.footer" data-slot="footer" class="hw-sheet-foot">
        <slot name="footer" />
      </div>
    </template>
  </UModal>
</template>
