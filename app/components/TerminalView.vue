<script setup lang="ts">
// Raw terminal of the pane: xterm.js + touch layer (scrolling with a finger or
// the wheel -> terminal.scroll, the history lives in Herdr; never ↑/↓
// sent to the agent; click = keyboard to the terminal, a tap too except on
// iOS: see utils/terminalTapFocus.ts).
import '@xterm/xterm/css/xterm.css'
import { createTerminalTouch, touchPreviewOffset } from '~/utils/terminalTouch'
import { mouseFromTouch, tapFocusesTerminal } from '~/utils/terminalTapFocus'
import type { TerminalCopySnapshot } from '~/utils/terminalCopy'

const props = defineProps<{ ctl: TerminalCtl }>()
const emit = defineEmits<{ copying: [active: boolean] }>()
const host = ref<HTMLElement | null>(null)
const copySnapshot = shallowRef<TerminalCopySnapshot | null>(null)
const copyMetrics = shallowRef<Record<string, string>>({})
const copyMode = computed(() => copySnapshot.value !== null)

let legacyLastY: number | null = null
let legacyLastX: number | null = null
let legacyStartX = 0, legacyStartY = 0
let legacyAcc = 0
let legacyPendingLines = 0
let legacyRaf = 0
let legacyMoved = false
const legacyFlush = () => {
  legacyRaf = 0
  if (!legacyPendingLines) return
  props.ctl.scroll(legacyPendingLines)
  legacyPendingLines = 0
}
const legacyQueue = (n: number) => {
  legacyPendingLines += n
  if (!legacyRaf) legacyRaf = requestAnimationFrame(legacyFlush)
}
const tapFocuses = import.meta.client ? tapFocusesTerminal(navigator.vendor) : true
function legacyOnTouchStart(e: TouchEvent) {
  legacyLastY = e.touches[0]!.clientY
  legacyLastX = e.touches[0]!.clientX
  legacyStartX = legacyLastX
  legacyStartY = legacyLastY
  legacyAcc = 0
  legacyMoved = false
}
function legacyOnTouchMove(e: TouchEvent) {
  e.preventDefault()
  if (legacyLastY === null) return
  const y = e.touches[0]!.clientY
  const x = e.touches[0]!.clientX
  const dx = legacyLastX === null ? 0 : x - legacyLastX
  const dy = y - legacyLastY
  legacyLastX = x
  const scroller = host.value?.querySelector('.xterm') as HTMLElement | null
  if (scroller && scroller.scrollWidth > scroller.clientWidth && Math.abs(dx) > Math.abs(dy)) {
    scroller.scrollLeft -= dx
    legacyLastY = y
    legacyMoved = true
    return
  }
  legacyAcc += dy
  legacyLastY = y
  const { lines, rest } = takeLines(legacyAcc, props.ctl.rowHeight())
  legacyAcc = rest
  if (lines) {
    legacyMoved = true
    legacyQueue(lines)
  }
}
function legacyOnTouchEnd(e: TouchEvent) {
  const t = e.changedTouches[0]
  legacyLastY = null
  legacyLastX = null
  // A tap on a link opens it; any simple tap closes the keyboard: the
  // terminal stays readable in full. The release position still counts
  // when the browser coalesced the last moves of a drag.
  if (!legacyMoved && t && Math.hypot(t.clientX - legacyStartX, t.clientY - legacyStartY) < 5) {
    // No keyboard for a link: cancels the mousedown that follows the tap.
    if (props.ctl.tapLink(t.clientX, t.clientY)) e.preventDefault()
    else props.ctl.tapMouse(t.clientX, t.clientY)
    props.ctl.blur()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
  }
}
// The layer only receives the mouse on a touch screen (main.css): on a
// computer, xterm receives it directly (selection, mouse mode).
function legacyOnMouseDown() { props.ctl.focus() }
// Listened on the whole block, before xterm: on a computer the mouse reaches
// xterm (selection), which would otherwise send the wheel to the program in mouse
// mode. Herdr applies the application's mouse mode itself.
function legacyOnWheel(e: WheelEvent) {
  e.preventDefault()
  e.stopPropagation()
  const scroller = host.value?.querySelector('.xterm') as HTMLElement | null
  if (scroller && scroller.scrollWidth > scroller.clientWidth && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
    scroller.scrollLeft += e.shiftKey ? e.deltaY : e.deltaX
    return
  }
  const h = props.ctl.rowHeight()
  legacyAcc -= wheelPixels(e.deltaY, e.deltaMode, h, props.ctl.pageRows())
  const { lines, rest } = takeLines(legacyAcc, h)
  legacyAcc = rest
  if (lines) legacyQueue(lines)
}


// Prediction is restricted to the grid and to one outstanding gesture. Epochs
// in useTerminal prevent late acknowledgements from retiring a newer gesture.
let acc = 0, pendingLines = 0, unconfirmed = 0, momentumAcc = 0
let raf = 0, paintRaf = 0
let settleTimer: ReturnType<typeof setTimeout> | undefined
let scrollX = 0, scrollY = 0
let lastTouchAt = -Infinity
let lastScrollAt = -Infinity
let stoppingScroll = false
let allowTouchFocus = false
let hadScroll = false
const screenEl = () => host.value?.querySelector('.xterm-screen') as HTMLElement | null
const applyOffset = () => {
  const el = screenEl()
  if (!el) return
  const px = smoothTouchScrolling.value ? touchPreviewOffset(acc + (pendingLines + unconfirmed) * props.ctl.rowHeight(), props.ctl.rowHeight()) : 0
  el.style.willChange = px ? 'transform' : ''
  el.style.transform = px ? `translate3d(0, ${px}px, 0)` : ''
}
function expirePreview() {
  if (!hadScroll) return
  clearTimeout(settleTimer)
  // At an edge Herdr may send no frame. Clear once, never animate a spring.
  settleTimer = setTimeout(() => {
    unconfirmed = pendingLines = acc = 0
    cancelAnimationFrame(raf); raf = 0
    props.ctl.cancelTouchScroll()
    applyOffset()
  }, 180)
}
function flush() {
  raf = 0
  if (!pendingLines) return
  const n = pendingLines
  pendingLines = 0
  if (props.ctl.scroll(n, scrollX, scrollY, 0, true)) unconfirmed += n
  else unconfirmed = acc = 0
  applyOffset()
  expirePreview()
}
watch(props.ctl.scrollAck, (value, previous) => {
  const n = value - previous
  if (!n || !smoothTouchScrolling.value) return
  if (Math.sign(n) === Math.sign(unconfirmed))
    unconfirmed -= Math.sign(n) * Math.min(Math.abs(n), Math.abs(unconfirmed))
  cancelAnimationFrame(paintRaf)
  paintRaf = requestAnimationFrame(() => { paintRaf = 0; applyOffset() })
}, { flush: 'sync' })
const scroller = () => host.value?.querySelector('.xterm') as HTMLElement | null
const touch = createTerminalTouch({
  vertical(pixels, point) {
    lastScrollAt = performance.now()
    // Reversal abandons stale prediction and pending commands first.
    if (unconfirmed && Math.sign(pixels) !== Math.sign(unconfirmed)) {
      props.ctl.cancelTouchScroll()
      unconfirmed = pendingLines = acc = 0
    }
    scrollX = point.x; scrollY = point.y
    acc += pixels
    const { lines, rest } = takeLines(acc, props.ctl.rowHeight())
    acc = rest
    pendingLines += lines
    hadScroll = true
    if (lines && !raf) raf = requestAnimationFrame(flush)
    applyOffset()
    expirePreview()
  },
  momentum(pixels, point) {
    lastScrollAt = performance.now()
    momentumAcc += pixels
    const { lines, rest } = takeLines(momentumAcc, props.ctl.rowHeight())
    momentumAcc = rest
    // Momentum has no visual prediction; its acks must not pay finger debt.
    if (lines) props.ctl.scroll(lines, point.x, point.y, 0, true, false)
  },
  horizontal(pixels) { lastScrollAt = performance.now(); const el = scroller(); if (el) el.scrollLeft -= pixels },
  canHorizontal: () => { const el = scroller(); return !!el && el.scrollWidth > el.clientWidth },
  maxMomentum: () => props.ctl.rowHeight() * props.ctl.pageRows() * 1.5,
  dragStart: () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = undefined } },
})
// Long press on the gesture surface opens copy mode; it must not be mistaken
// for a slow tap or leak into the tap->focus path on release.
let lpTimer: ReturnType<typeof setTimeout> | undefined, lpX = 0, lpY = 0, lpEntered = false, lpScale = 1
const armLongPress = () => { clearTimeout(lpTimer); lpTimer = setTimeout(enterCopyMode, 480) }
let entryFinger = false
let composing = false
const compositionStart = () => { composing = true; clearTimeout(lpTimer); lpTimer = undefined }
const compositionEnd = () => { composing = false }
let suppressCopyContextUntil = 0
function enterCopyMode() {
  lpTimer = undefined
  if (copyMode.value || composing || (window.visualViewport?.scale ?? 1) !== lpScale) return
  // Capture before blur can resize the live terminal; the controller itself
  // refuses while an IME composition or its deferred commit is in flight.
  const snapshot = props.ctl.captureScreen()
  const screen = screenEl()
  if (!snapshot || !screen) return
  const cs = getComputedStyle(screen)
  copyMetrics.value = {
    fontFamily: snapshot.fontFamily || cs.fontFamily,
    fontSize: snapshot.fontSize ? `${snapshot.fontSize}px` : cs.fontSize,
    lineHeight: `${props.ctl.rowHeight()}px`,
    letterSpacing: cs.letterSpacing,
    color: cs.color,
    width: `${screen.getBoundingClientRect().width}px`,
  }
  lpEntered = entryFinger = true
  suppressCopyContextUntil = performance.now() + 1000
  // Cancel both input paths and the remote queue, even if the last drag was
  // already acknowledged.
  cancelTouch()
  cancelAnimationFrame(legacyRaf); legacyRaf = 0
  legacyPendingLines = legacyAcc = 0
  legacyLastX = legacyLastY = null
  props.ctl.cancelTouchScroll()
  props.ctl.clearVirtualModifiers()
  copySnapshot.value = snapshot
  // Close the owner's input gate before blurring: with focus reporting
  // enabled, xterm emits ESC[O through onData on textarea blur — a
  // synchronous path inert renders too late to cover.
  emit('copying', true)
  props.ctl.blur()
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  haptic()
}
function exitCopyMode() {
  if (!copyMode.value) return
  copySnapshot.value = null
  emit('copying', false)
  // Deliberately leave focus with the user: Done never opens the IME.
}
function releaseEntryFinger(e: TouchEvent) {
  if (!entryFinger) return
  entryFinger = false
  lastTouchAt = performance.now()
  suppressCopyContextUntil = lastTouchAt + 250
  e.preventDefault()
  e.stopImmediatePropagation()
}
function copyContextMenu(e: Event) {
  if (entryFinger || performance.now() < suppressCopyContextUntil) e.preventDefault()
}
function cancelTouch() {
  clearTimeout(lpTimer); lpTimer = undefined
  touch.cancel()
  cancelAnimationFrame(raf); raf = 0
  cancelAnimationFrame(paintRaf); paintRaf = 0
  clearTimeout(settleTimer)
  pendingLines = unconfirmed = momentumAcc = acc = 0
  if (hadScroll) props.ctl.cancelTouchScroll()
  hadScroll = false
  applyOffset()
}
watch(props.ctl.scrollInputVersion, cancelTouch)
// A reconnect reloads the live screen in both scroll modes (the smooth path's
// scrollInputVersion only bumps on some of them): a pending hold is tied to
// the screen it measured, so it dies. An opened copy surface is untouched —
// cancelTouch never leaves copy mode.
watch(props.ctl.loading, loading => { if (loading) cancelTouch() })
watch(pageVisible, visible => { if (!visible) cancelTouch() })
watch(smoothTouchScrolling, () => {
  cancelTouch()
  cancelAnimationFrame(legacyRaf); legacyRaf = 0
  legacyPendingLines = legacyAcc = 0
  legacyLastX = legacyLastY = null
}, { flush: 'sync' })
function onTouchStart(e: TouchEvent) {
  lastTouchAt = performance.now()
  if (copyMode.value) return
  // A second finger arriving through a new touchstart kills the pending hold,
  // without waiting for a move.
  if (e.touches.length !== 1) { cancelTouch(); legacyLastY = legacyLastX = null; return }
  lpEntered = false
  lpScale = window.visualViewport?.scale ?? 1
  lpX = e.touches[0]!.clientX; lpY = e.touches[0]!.clientY
  if (!smoothTouchScrolling.value) { armLongPress(); return legacyOnTouchStart(e) }
  // Retain this across pointerdown cancellation, which precedes touchstart.
  // A tap during or just after scrolling only stops the viewport.
  stoppingScroll = lastTouchAt - lastScrollAt < 700
  allowTouchFocus = false
  cancelTouch()
  touch.start(e.touches[0]!.clientX, e.touches[0]!.clientY)
  armLongPress()
}
function onTouchMove(e: TouchEvent) {
  if (copyMode.value) return
  e.preventDefault()
  // The same 5px that locks a scroll axis ends the hold — in both scroll
  // modes, before anything else.
  const tm = e.touches[0]
  if (tm && Math.hypot(tm.clientX - lpX, tm.clientY - lpY) >= 5) { clearTimeout(lpTimer); lpTimer = undefined }
  if (e.touches.length !== 1) { cancelTouch(); legacyLastX = legacyLastY = null; return }
  if (!smoothTouchScrolling.value) return legacyOnTouchMove(e)
  touch.move(e.touches[0]!.clientX, e.touches[0]!.clientY)
}
function onTouchEnd(e: TouchEvent) {
  if (copyMode.value || lpEntered) { e.preventDefault(); return }
  lastTouchAt = performance.now()
  clearTimeout(lpTimer); lpTimer = undefined
  if (!smoothTouchScrolling.value) return legacyOnTouchEnd(e)
  const t = e.changedTouches[0]
  const tapped = touch.end()
  allowTouchFocus = tapped && !stoppingScroll
  if (allowTouchFocus) {
    if (t) {
      if (props.ctl.tapLink(t.clientX, t.clientY)) { allowTouchFocus = false; e.preventDefault() }
      else props.ctl.tapMouse(t.clientX, t.clientY)
    }
    props.ctl.blur()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
  } else e.preventDefault()
  expirePreview()
}
// The layer only receives the mouse on a touch screen (main.css): on a
// computer, xterm receives it directly (selection, mouse mode).
function onMouseDown(e: MouseEvent) {
  if (copyMode.value) return
  const fromTouch = mouseFromTouch((e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents, performance.now() - lastTouchAt)
  // On iOS a tap never opens the keyboard: the composer or the key bar does.
  if (fromTouch && !tapFocuses) { allowTouchFocus = false; return }
  if (!smoothTouchScrolling.value) return legacyOnMouseDown()
  // Preserve keyboard access for an intentional tap, but never refocus after
  // a drag, a link, or the tap that stopped inertia.
  if (fromTouch && !allowTouchFocus) return
  allowTouchFocus = false
  props.ctl.focus()
}
// Listened on the whole block, before xterm: on a computer the mouse reaches
// xterm (selection), which would otherwise send the wheel to the program in mouse
// mode. Herdr applies the application's mouse mode itself.
function onWheel(e: WheelEvent) {
  if (copyMode.value) return
  if (smoothTouchScrolling.value) cancelTouch()
  legacyOnWheel(e)
}

let fitTimer: ReturnType<typeof setTimeout> | undefined
// Throttle rather than debounce: long divider drags must keep fitting while
// the pointer moves, without sending every intermediate pixel to Herdr.
function scheduleFit() {
  if (smoothTouchScrolling.value) cancelTouch()
  if (fitTimer) return
  fitTimer = setTimeout(() => {
    fitTimer = undefined
    props.ctl.fitNow(true)
  }, 50)
}
watch(layoutTick, scheduleFit)
let ro: ResizeObserver | null = null
onMounted(() => {
  document.addEventListener('pointerdown', cancelTouch, true)
  document.addEventListener('touchend', releaseEntryFinger, { capture: true, passive: false })
  document.addEventListener('touchcancel', releaseEntryFinger, { capture: true, passive: false })
  document.addEventListener('contextmenu', copyContextMenu, true)
  document.addEventListener('compositionstart', compositionStart, true)
  document.addEventListener('compositionend', compositionEnd, true)
  // xterm is downloaded on the first terminal shown (utils/xtermLoader.ts):
  // the first fit and the connection wait for it.
  void props.ctl.mount(host.value!).then((ready) => {
    if (!ready) return
    nextTick(() => {
      props.ctl.fitNow(false)
      if (!props.ctl.hasBanner()) props.ctl.connect(false)
    })
  })
  ro = new ResizeObserver(scheduleFit)
  ro.observe(host.value!)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', cancelTouch, true)
  document.removeEventListener('touchend', releaseEntryFinger, true)
  document.removeEventListener('touchcancel', releaseEntryFinger, true)
  document.removeEventListener('contextmenu', copyContextMenu, true)
  document.removeEventListener('compositionstart', compositionStart, true)
  document.removeEventListener('compositionend', compositionEnd, true)
  exitCopyMode()
  cancelTouch()
  ro?.disconnect()
  clearTimeout(fitTimer)
  cancelAnimationFrame(legacyRaf)
  props.ctl.dispose()
})
</script>

<template>
  <div id="termWrap" :class="{ 'smooth-touch': smoothTouchScrolling, 'copying-screen': copyMode }" @wheel.capture="onWheel">
    <div id="term" ref="host" :inert="copyMode" />
    <div
      id="touch" aria-hidden="true" :inert="copyMode"
      @touchstart.passive="onTouchStart" @touchmove="onTouchMove" @touchend="onTouchEnd" @touchcancel="cancelTouch"
      @mousedown.prevent="onMouseDown"
    />
    <TerminalCopyLayer v-if="copySnapshot" :snapshot="copySnapshot" :metrics="copyMetrics" @close="exitCopyMode" />
    <div v-if="ctl.loading.value" class="term-loading"><span class="spinner" /></div>
    <div v-if="ctl.selectionHint.visible.value" class="terminal-selection-hint">
      {{ tl('Shift + drag to select', 'Shift + glisser pour sélectionner') }}
      <button type="button" :aria-label="t('Hide')" @click="ctl.selectionHint.dismiss()">×</button>
    </div>
  </div>
</template>
