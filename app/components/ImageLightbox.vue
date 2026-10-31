<script setup lang="ts">
// Conversation image enlarged, fitted to the screen. Zoom: pinch, ctrl+wheel
// (trackpad pinch), wheel on a fitted image, double tap, click on the image, the
// bottom bar or + / - / 0; zoomed, a drag or the wheel pans in every direction.
// When it belongs to a set (message with several images): ← → keys, swipe (not
// zoomed) or the side buttons go through all of them, with a counter. A tap
// outside the image, the close button or Escape closes it.
import { canPan, clampView, fitScale, fitView, isZoomed, toggleZoom, wheelFactor, ZOOM_STEP, zoomAt, zoomBounds } from '~/utils/imageZoom'
import type { ImageSize, ZoomView } from '~/utils/imageZoom'

const set = computed(() => lightboxSrc.value && lightboxSet.value.includes(lightboxSrc.value) ? lightboxSet.value : [])
const index = computed(() => lightboxSrc.value ? set.value.indexOf(lightboxSrc.value) : -1)
const multi = computed(() => set.value.length > 1)

const stage = ref<HTMLElement | null>(null)
const img = ref<ImageSize | null>(null) // natural size, once loaded
const box = ref<ImageSize>({ w: 0, h: 0 })
const view = ref<ZoomView>({ scale: 1, x: 0, y: 0 })

const zoomed = computed(() => Boolean(img.value) && isZoomed(view.value, img.value!, box.value))
const pannable = computed(() => Boolean(img.value) && canPan(view.value, img.value!, box.value))
const fit = computed(() => (img.value ? fitScale(img.value, box.value) : 1))
const bounds = computed(() => (img.value ? zoomBounds(img.value, box.value) : { min: 1, max: 1 }))
const percent = computed(() => `${Math.round(view.value.scale * 100)} %`)
const imgStyle = computed(() => {
  if (!img.value) return { visibility: 'hidden' as const }
  const v = view.value
  return { width: `${img.value.w * v.scale}px`, height: `${img.value.h * v.scale}px`, transform: `translate3d(${v.x}px, ${v.y}px, 0)` }
})

function measure() {
  const r = stage.value?.getBoundingClientRect()
  if (r) box.value = { w: r.width, h: r.height }
}
function onLoad(e: Event) {
  const el = e.target as HTMLImageElement
  measure()
  img.value = { w: el.naturalWidth, h: el.naturalHeight }
  view.value = fitView(img.value, box.value)
}
// Zoom keeping the given stage point (default: the centre) in place.
function zoomTo(scale: number, px = box.value.w / 2, py = box.value.h / 2) {
  if (img.value) view.value = zoomAt(view.value, scale, px, py, img.value, box.value)
}
function fitToScreen() {
  if (img.value) view.value = fitView(img.value, box.value)
}
// "1:1": actual size around the centre, or back to the fit when already there.
function actualSize() {
  if (view.value.scale === 1 || fit.value >= 1) fitToScreen()
  else zoomTo(1)
}

function close() { lightboxSrc.value = null; lightboxSet.value = [] }
function go(delta: number) {
  if (!multi.value) return
  lightboxSrc.value = set.value[stepImage(index.value, delta, set.value.length)] ?? lightboxSrc.value
}
function onKey(e: KeyboardEvent) {
  if (!lightboxSrc.value) return
  if (e.key === 'Escape') close()
  else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
  else if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
  else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomTo(view.value.scale * ZOOM_STEP) }
  else if (e.key === '-') { e.preventDefault(); zoomTo(view.value.scale / ZOOM_STEP) }
  else if (e.key === '0') { e.preventDefault(); fitToScreen() }
}

// Pointers: one finger / the mouse pans when the image overflows, otherwise a
// horizontal swipe changes image; two fingers pinch. A tap that did not move
// zooms (click, double tap) on the image and closes outside it.
const pointers = new Map<number, { x: number, y: number }>()
let gesture: {
  start: { x: number, y: number, t: number }
  last: { x: number, y: number }
  pinch: { dist: number, scale: number } | null
  pinched: boolean // a pinch happened during the gesture: no swipe at the end
  moved: boolean
  onImage: boolean
} | null = null
let lastTap: { x: number, y: number, t: number } | null = null

function local(x: number, y: number) {
  const r = stage.value?.getBoundingClientRect()
  return { x: x - (r?.left ?? 0), y: y - (r?.top ?? 0) }
}
function pinchOf() {
  const [a, b] = [...pointers.values()]
  if (!a || !b) return null
  return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) }
}
function onDown(e: PointerEvent) {
  if (pointers.size >= 2) return
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  if (pointers.size === 1) {
    gesture = { start: { x: e.clientX, y: e.clientY, t: Date.now() }, last: { x: e.clientX, y: e.clientY }, pinch: null, pinched: false, moved: false, onImage: (e.target as HTMLElement).tagName === 'IMG' }
  } else if (gesture && pointers.size === 2) {
    const p = pinchOf()
    if (p) { gesture.pinch = { dist: p.dist, scale: view.value.scale }; gesture.pinched = true; gesture.last = p.mid; gesture.moved = true }
  }
}
function onMove(e: PointerEvent) {
  if (!gesture || !pointers.has(e.pointerId) || !img.value) return
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (Math.hypot(e.clientX - gesture.start.x, e.clientY - gesture.start.y) > 8) gesture.moved = true
  if (gesture.pinch) {
    const p = pinchOf()
    if (!p) return
    // Scale around the fingers' midpoint, then follow its movement.
    const at = local(p.mid.x, p.mid.y)
    const zoomedView = zoomAt(view.value, gesture.pinch.scale * p.dist / Math.max(gesture.pinch.dist, 1), at.x, at.y, img.value, box.value)
    view.value = clampView({ ...zoomedView, x: zoomedView.x + p.mid.x - gesture.last.x, y: zoomedView.y + p.mid.y - gesture.last.y }, img.value, box.value)
    gesture.last = p.mid
  } else if (pannable.value) {
    view.value = clampView({ ...view.value, x: view.value.x + e.clientX - gesture.last.x, y: view.value.y + e.clientY - gesture.last.y }, img.value, box.value)
    gesture.last = { x: e.clientX, y: e.clientY }
  }
}
function onUp(e: PointerEvent) {
  if (!pointers.delete(e.pointerId)) return
  const g = gesture
  if (!g) return
  if (pointers.size === 1 && g.pinch) {
    // One finger left after a pinch: it pans from where it is.
    const [rest] = [...pointers.values()]
    g.pinch = null
    if (rest) g.last = rest
    return
  }
  if (pointers.size) return
  gesture = null
  if (e.type === 'pointercancel' || !img.value) return
  if (g.moved) {
    // Swipe between the images of a set, only when not zoomed (otherwise it pans).
    const dx = e.clientX - g.start.x
    if (multi.value && !g.pinched && !zoomed.value && swipeAxis(dx, e.clientY - g.start.y) === 'x') {
      const step = swipeStep(dx, Date.now() - g.start.t, window.innerWidth)
      if (step) go(step)
    }
    return
  }
  if (!g.onImage) { close(); return }
  const at = local(e.clientX, e.clientY)
  if (e.pointerType === 'mouse') { view.value = toggleZoom(view.value, at.x, at.y, img.value, box.value); return }
  // Touch: double tap.
  const now = Date.now()
  if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
    view.value = toggleZoom(view.value, at.x, at.y, img.value, box.value)
    lastTap = null
  } else lastTap = { x: e.clientX, y: e.clientY, t: now }
}

// Ctrl+wheel (and trackpad pinch) zooms at the cursor; the plain wheel pans a
// zoomed image and zooms a fitted one.
function onWheel(e: WheelEvent) {
  if (!img.value) return
  const at = local(e.clientX, e.clientY)
  if (e.ctrlKey || e.metaKey || !pannable.value) {
    zoomTo(view.value.scale * wheelFactor(e.deltaY, e.deltaMode), at.x, at.y)
    return
  }
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? box.value.h : 1
  const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k
  const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * k
  view.value = clampView({ ...view.value, x: view.value.x - dx, y: view.value.y - dy }, img.value, box.value)
}

// Window resized (rotation, keyboard): stay fitted if fitted, otherwise keep the zoom within bounds.
function onResize() {
  if (!lightboxSrc.value || !img.value) return
  const wasZoomed = zoomed.value
  measure()
  view.value = wasZoomed ? clampView(view.value, img.value, box.value) : fitView(img.value, box.value)
}
// iOS: Safari's own pinch (page zoom) must not start on top of ours.
function stopGesture(e: Event) { if (lightboxSrc.value) e.preventDefault() }

// The system back gesture / edge swipe should dismiss the viewer, not leave
// the pane: opening pushes a same-URL history entry, and popping it closes
// the viewer instead of navigating. Closing from the UI pops that entry back.
let historyArmed = false
watch(lightboxSrc, (src) => {
  img.value = null; pointers.clear(); gesture = null; lastTap = null
  if (src && !historyArmed) { history.pushState({ wherdrLightbox: true }, ''); historyArmed = true }
  else if (!src && historyArmed) { historyArmed = false; history.back() }
})
function onPopState() {
  if (!lightboxSrc.value) return
  historyArmed = false // the pop consumed our entry — no back() on this close
  close()
}

onMounted(() => {
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)
  window.addEventListener('popstate', onPopState)
  document.addEventListener('gesturestart', stopGesture)
})
onUnmounted(() => {
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('popstate', onPopState)
  document.removeEventListener('gesturestart', stopGesture)
})
</script>

<template>
  <div v-if="lightboxSrc" class="lightbox" role="dialog" aria-modal="true" :aria-label="t('Image')" @click.self="close">
    <div
      ref="stage" class="lightbox-stage" :class="{ pannable, zoomed }"
      @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @wheel.prevent="onWheel"
    >
      <img :key="lightboxSrc" :src="lightboxSrc" alt="" draggable="false" :style="imgStyle" @load="onLoad">
    </div>
    <span v-if="multi" class="lightbox-count">{{ index + 1 }} / {{ set.length }}</span>
    <button type="button" class="lightbox-btn lightbox-close" :aria-label="t('Close')" @click="close"><UIcon name="i-lucide-x" /></button>
    <template v-if="multi">
      <button type="button" class="lightbox-nav prev" :disabled="index <= 0" :aria-label="t('Previous image')" @click="go(-1)"><UIcon name="i-lucide-chevron-left" /></button>
      <button type="button" class="lightbox-nav next" :disabled="index >= set.length - 1" :aria-label="t('Next image')" @click="go(1)"><UIcon name="i-lucide-chevron-right" /></button>
    </template>
    <div v-if="img" class="lightbox-bar">
      <button type="button" class="lightbox-btn" :disabled="!zoomed" :aria-label="t('Zoom out')" @click="zoomTo(view.scale / ZOOM_STEP)"><UIcon name="i-lucide-minus" /></button>
      <button type="button" class="lightbox-zoom" :title="t('Fit to screen')" :disabled="!zoomed" @click="fitToScreen">{{ percent }}</button>
      <button type="button" class="lightbox-btn" :disabled="view.scale >= bounds.max - 1e-6" :aria-label="t('Zoom in')" @click="zoomTo(view.scale * ZOOM_STEP)"><UIcon name="i-lucide-plus" /></button>
      <button type="button" class="lightbox-real" :disabled="fit >= 1" :aria-pressed="view.scale === 1" :title="t('Actual size')" @click="actualSize">1:1</button>
    </div>
  </div>
</template>
