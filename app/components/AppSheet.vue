<script setup lang="ts">
// App window, on Nuxt UI overlays: a bottom sheet (UDrawer) on the phone, a
// centered window (UModal) on a computer (≥ 900 px, or a tablet). Escape or a
// tap outside closes it; on the phone, so do a tap on the handle and a swipe
// down from the handle, the header, or the content while it is scrolled to its
// top (the drawer's own drag: it follows the finger, then closes or springs back).
// Both trap the focus, return it on close, and lock the page's scroll.
import { useMediaQuery } from '@vueuse/core'
import { UDrawer, UModal } from '#components'
import { PHONE_QUERY } from '~/utils/layoutMode'
// `screen`: full-screen view on the phone instead of a sheet (page color,
// safe areas included, no drag); unchanged on a computer. The `footer` slot stays
// pinned under the scrolling content (above the home bar or the keyboard).
// `top`: above the other windows (a confirmation asked from an open sheet).
// `sub` slot: a row under the title, the header's full width (a shown file's
// folder · size and controls, FilesView).
// `actions` slot: the sheet's own controls, just before the close cross (a project's ⋯ menu).
// `clamp`: a long title (a task's) on the phone: two lines in smaller type, a tap
// shows it whole; one line once the body is scrolled or a field is typed in.
import { kbOpen } from '~/composables/useViewport'

const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ title?: string, tall?: boolean, wide?: boolean, full?: boolean, screen?: boolean, top?: boolean, clamp?: boolean }>()
const emit = defineEmits<{ closed: [] }>()
const slots = defineSlots<{ default?: () => unknown, footer?: () => unknown, lead?: () => unknown, actions?: () => unknown, sub?: () => unknown }>()
watch(open, (v, old) => { if (old && !v) emit('closed') })
const phone = useMediaQuery(PHONE_QUERY)
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
  // mt-0: the drawer's top margin would push a full-screen view down.
  content: `hw-sheet${props.tall ? ' tall' : ''}${props.wide ? ' wide' : ''}${props.full ? ' full' : ''}${props.screen ? ' screen' : ''}${props.top ? ' top' : ''}${phone.value ? ' mt-0' : ''}`,
}))
// On open, focus goes to the window itself (screen readers announce its
// title), not to its first button: the phone's full-width handle would get
// the browser's focus outline across the top. Tab then reaches the buttons,
// which keep their keyboard focus ring.
function focusSheet(e: Event) {
  e.preventDefault()
  ;(e.target as HTMLElement).focus({ preventScroll: true })
}

// The drawer's open state. A swipe closes the drawer itself before asking to
// close: a sheet kept open (unsaved changes, CoordinatorButton) springs back.
const shown = ref(open.value)
watch(open, (v) => { shown.value = v })
let swiped = false
async function setOpen(v: boolean) {
  open.value = v
  if (v || !swiped) return
  swiped = false
  await nextTick()
  if (!open.value) return
  shown.value = false
  await nextTick()
  shown.value = true
}
// The handle closes on a tap (or Enter), not at the end of a drag from it.
let handleY = 0
function handleTap(e: MouseEvent) {
  if (e.detail === 0 || Math.abs(e.clientY - handleY) <= 8) open.value = false
}
// The image viewer opened from the sheet: its taps and Escape are its own.
const overlay = computed(() => phone.value
  ? {
      // No drag on a full-screen view: drag from a handle it does not have.
      handle: false,
      handleOnly: !!props.screen,
      // The page keeps its own layout (no fixed body); Reka still locks its scroll.
      noBodyStyles: true,
      content: { onOpenAutoFocus: focusSheet, disableOutsidePointerEvents: true },
      onClose: () => { swiped = true },
    }
  : { content: { onOpenAutoFocus: focusSheet } })
</script>

<template>
  <component
    :is="phone ? UDrawer : UModal" v-bind="overlay" :open="shown" :title="title" :ui="ui" :dismissible="!lightboxSrc"
    @update:open="setOpen"
  >
    <template #content>
      <button
        v-if="!screen" type="button" class="hw-sheet-handle" :aria-label="tl('Close', 'Fermer')"
        @pointerdown="handleY = $event.clientY" @click="handleTap"
      />
      <div v-if="title" data-slot="header" class="hw-sheet-head" :class="{ compact }">
        <span v-if="slots.lead" class="hw-sheet-lead"><slot name="lead" /></span>
        <span class="hw-sheet-title" :class="{ clamp, open: fullTitle }" :title="clamp ? title : undefined" aria-hidden="true" data-testid="sheet-title" @click="fullTitle = !!clamp && !fullTitle">{{ title }}</span>
        <span v-if="slots.actions" class="hw-sheet-actions"><slot name="actions" /></span>
        <UButton icon="i-lucide-x" color="neutral" variant="ghost" data-slot="close" class="hw-sheet-close" :aria-label="tl('Close', 'Fermer')" @click="open = false" />
        <div v-if="slots.sub" class="hw-sheet-sub"><slot name="sub" /></div>
      </div>
      <div
        ref="bodyEl" data-slot="body" class="hw-sheet-body" :class="{ typing }"
        @focusin="focusIn" @focusout="focusOut" @input="showForm" @scroll.passive="bodyScroll"
      >
        <slot />
      </div>
      <div v-if="slots.footer" data-slot="footer" ref="footEl" class="hw-sheet-foot" :class="{ typing }" @focusin="focusIn" @focusout="focusOut">
        <slot name="footer" />
      </div>
    </template>
  </component>
</template>
