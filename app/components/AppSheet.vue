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
// `clamp`: a long title (a task's) on the phone: two lines in smaller type, a tap
// shows it whole; one line once the body is scrolled or a field is typed in.
import { kbOpen } from '~/composables/useViewport'
import { SHEET_DRAG_SLOP, sheetDragCloses, sheetDragOffset } from '~/utils/sheetDrag'

const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ hideClose?: boolean, title?: string, tall?: boolean, wide?: boolean, full?: boolean, screen?: boolean, top?: boolean, clamp?: boolean }>()
const emit = defineEmits<{ closed: [] }>()
const slots = defineSlots<{ default?: () => unknown, footer?: () => unknown, lead?: () => unknown }>()
watch(open, (v, old) => { if (old && !v) emit('closed') })
// Typing on the phone: a text field of the sheet has focus, the keyboard over
// the page. The bars pinned over the body hide (`.typing` on the body or the
// footer, main.css), so nothing covers the field; its form (the field and its
// own send button) is kept in view while it fits. Back on blur, or when the
// keyboard closes with the field still focused (Android; the composer's rule),
// and on again when the keyboard reopens on that same field (no new focusin).
const typing = ref(false)
const bodyEl = ref<HTMLElement>()
const footEl = ref<HTMLElement>()
const isField = (el: EventTarget | null) => el instanceof HTMLElement
  && (el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !/^(button|submit|reset|checkbox|radio|file|range|color)$/.test(el.type)))
function focusIn(e: FocusEvent) { typing.value = isField(e.target) && matchMedia(PHONE_QUERY).matches }
function focusOut(e: FocusEvent) { if (!isField(e.relatedTarget)) typing.value = false }
function showForm() {
  const form = typing.value ? document.activeElement?.closest('form') : null
  const body = form?.closest<HTMLElement>('.hw-sheet-body')
  if (form && body && form.offsetHeight <= body.clientHeight) requestAnimationFrame(() => form.scrollIntoView({ block: 'nearest' }))
}
function fieldInSheet() {
  const el = document.activeElement
  return isField(el) && !!(bodyEl.value?.contains(el) || footEl.value?.contains(el)) && matchMedia(PHONE_QUERY).matches
}
watch(kbOpen, (v) => {
  typing.value = v && fieldInSheet()
  if (v) showForm()
})
const scrolledDown = ref(false)
const fullTitle = ref(false)
function bodyScroll(e: Event) { scrolledDown.value = (e.currentTarget as HTMLElement).scrollTop > 8 }
const compact = computed(() => props.clamp && (scrolledDown.value || typing.value))
watch(compact, (v) => { if (v) fullTitle.value = false })
const ui = computed(() => ({
  overlay: `hw-scrim${props.screen ? ' screen' : ''}${props.top ? ' top' : ''}`,
  content: `hw-sheet${props.tall ? ' tall' : ''}${props.wide ? ' wide' : ''}${props.full ? ' full' : ''}${props.screen ? ' screen' : ''}${props.top ? ' top' : ''}`,
}))
// On open, focus goes to the window itself (screen readers announce its
// title), not to its first button: the phone's full-width handle would get
// the browser's focus outline across the top. Tab then reaches the buttons,
// which keep their keyboard focus ring.
function focusSheet(e: Event) {
  e.preventDefault()
  ;(e.target as HTMLElement).focus({ preventScroll: true })
}

// The content, or a part of it that scrolls on its own,
// is scrolled down: the swipe scrolls it back up, it does not close the sheet.
function scrolled(from: EventTarget | null, body: HTMLElement) {
  for (let n = from as HTMLElement | null; n; n = n === body ? null : n.parentElement) if (n.scrollTop > 0) return true
  return false
}
// Swipe down: the sheet follows the finger, then closes or springs back.
let drag: { sheet: HTMLElement, fromHandle: boolean, y0: number, y: number, t: number, v: number, dragging: boolean } | null = null
function dragStart(e: TouchEvent, fromHandle: boolean) {
  if (props.screen || e.touches.length !== 1 || !matchMedia(PHONE_QUERY).matches) return
  const el = e.currentTarget as HTMLElement
  const sheet = el.closest<HTMLElement>('.hw-sheet')
  if (!sheet || (!fromHandle && scrolled(e.target, el))) return
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
    // Kept open (unsaved changes, CoordinatorButton): it springs back.
    nextTick(() => { if (open.value) d.sheet.style.transform = '' })
    return
  }
  d.sheet.style.transition = 'transform .2s cubic-bezier(.2, .8, .2, 1)'
  d.sheet.style.transform = ''
}
</script>

<template>
  <!-- The image viewer opened from the sheet: its taps and Escape are its own. -->
  <UModal v-model:open="open" :title="title" :ui="ui" :content="{ onOpenAutoFocus: focusSheet }" :dismissible="!lightboxSrc">
    <template #content>
      <button
        v-if="!screen" type="button" class="hw-sheet-handle" :aria-label="tl('Close', 'Fermer')"
        @click="open = false" @touchstart.passive="dragStart($event, true)" @touchmove="dragMove" @touchend="dragEnd" @touchcancel="dragEnd"
      />
      <div
        v-if="title" data-slot="header" class="hw-sheet-head" :class="{ compact }"
        @touchstart.passive="dragStart($event, true)" @touchmove="dragMove" @touchend="dragEnd" @touchcancel="dragEnd"
      >
        <span v-if="slots.lead" class="hw-sheet-lead"><slot name="lead" /></span>
        <span class="hw-sheet-title" :class="{ clamp, open: fullTitle }" :title="clamp ? title : undefined" aria-hidden="true" data-testid="sheet-title" @click="fullTitle = !!clamp && !fullTitle">{{ title }}</span>
        <UButton v-if="!hideClose" icon="i-lucide-x" color="neutral" variant="ghost" data-slot="close" class="hw-sheet-close" :aria-label="tl('Close', 'Fermer')" @click="open = false" />
      </div>
      <div
        ref="bodyEl" data-slot="body" class="hw-sheet-body" :class="{ typing }"
        @focusin="focusIn" @focusout="focusOut" @input="showForm" @scroll.passive="bodyScroll"
        @touchstart.passive="dragStart($event, false)" @touchmove="dragMove" @touchend="dragEnd" @touchcancel="dragEnd"
      >
        <slot />
      </div>
      <div v-if="slots.footer" data-slot="footer" ref="footEl" class="hw-sheet-foot" :class="{ typing }" @focusin="focusIn" @focusout="focusOut">
        <slot name="footer" />
      </div>
    </template>
  </UModal>
</template>
