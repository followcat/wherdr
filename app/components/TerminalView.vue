<script setup lang="ts">
// Raw terminal of the pane: xterm.js + touch layer. The attach delivers the
// history: a finger drag or the wheel scrolls xterm's local viewport — never
// ↑/↓ sent to the agent; click = keyboard to the terminal, a tap too except
// on iOS: see utils/terminalTapFocus.ts).
import '@xterm/xterm/css/xterm.css'
import { createTerminalTouch } from '~/utils/terminalTouch'
import { takeTouchLines } from '~/utils/terminalWheel'
import { mouseFromTouch, tapFocusesTerminal } from '~/utils/terminalTapFocus'
import { kbOpen } from '~/composables/useViewport'
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
  // Any move beyond the tap slop owns the gesture — even out-and-back or
  // sub-row motion can no longer release as a tap.
  if (Math.hypot(x - legacyStartX, y - legacyStartY) >= 5) legacyMoved = true
  const scroller = host.value?.querySelector('.xterm') as HTMLElement | null
  if (scroller && scroller.scrollWidth > scroller.clientWidth && Math.abs(dx) > Math.abs(dy)) {
    // Same release rule as the smooth horizontal axis: a pan is not typing.
    if (props.ctl.hasFocus() && !props.ctl.imeBusy()) props.ctl.blur()
    scroller.scrollLeft -= dx
    legacyLastY = y
    return
  }
  legacyAcc += dy
  legacyLastY = y
  const { lines, rest } = takeLines(legacyAcc, props.ctl.rowHeight())
  legacyAcc = rest
  if (lines) {
    // A scroll drag is not typing: release the keyboard it would keep, like
    // the smooth path — never while an IME composition is in flight.
    if (props.ctl.hasFocus() && !props.ctl.imeBusy()) props.ctl.blur()
    legacyMoved = true
    legacyQueue(lines)
  }
}
function legacyOnTouchEnd(e: TouchEvent) {
  const t = e.changedTouches[0]
  legacyLastY = null
  legacyLastX = null
  // A scroll release is not a tap: suppress the compatibility mousedown it
  // would otherwise produce, which must not reopen the keyboard.
  if (legacyMoved) { e.preventDefault(); return }
  // The release position still counts when the browser coalesced the last
  // moves of a drag.
  if (!t || Math.hypot(t.clientX - legacyStartX, t.clientY - legacyStartY) >= 5) return
  e.preventDefault()
  const linked = props.ctl.tapLink(t.clientX, t.clientY)
  if (!linked) props.ctl.tapMouse(t.clientX, t.clientY)
  // Same intent as the smooth path: only a tap on the cursor's own row asks
  // to type; every other tap dismisses the keyboard.
  if (!linked && tapFocuses && props.ctl.tapOnCursor(t.clientX, t.clientY)) props.ctl.focus()
  else {
    props.ctl.blur()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
  }
}
// The wheel owns its own accumulator: onWheel cancels pending touch/hold
// state on every event, and that cancellation must not drop the stream's
// fractional rest or the rows already queued for the next frame.
let wheelAcc = 0, wheelPendingLines = 0, wheelRaf = 0
const wheelFlush = () => {
  wheelRaf = 0
  if (!wheelPendingLines) return
  props.ctl.scroll(wheelPendingLines)
  wheelPendingLines = 0
}
const wheelQueue = (n: number) => {
  wheelPendingLines += n
  if (!wheelRaf) wheelRaf = requestAnimationFrame(wheelFlush)
}
// The layer only receives the mouse on a touch screen (main.css): on a
// computer, xterm receives it directly (selection, mouse mode).
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
  wheelAcc -= wheelPixels(e.deltaY, e.deltaMode, h, props.ctl.pageRows())
  const { lines, rest } = takeLines(wheelAcc, h)
  wheelAcc = rest
  if (lines) wheelQueue(lines)
}


// The viewport is local: scrolling moves xterm over the history the attach
// delivered. Only real buffer lines move — a translated screen would expose
// missing rows and jump on every repaint.
let acc = 0, pendingLines = 0, scrollDirection = 0
let raf = 0
let lastTouchAt = -Infinity
let lastScrollAt = -Infinity
let stoppingScroll = false
let touching = false
const screenEl = () => host.value?.querySelector('.xterm-screen') as HTMLElement | null
function flush() {
  raf = 0
  if (!pendingLines) return
  const n = pendingLines
  pendingLines = 0
  if (!props.ctl.scroll(n)) acc = 0
}
const scroller = () => host.value?.querySelector('.xterm') as HTMLElement | null
const touch = createTerminalTouch({
  vertical(pixels, point) {
    if (!pixels) return
    // A scroll drag is not typing: release the keyboard it would otherwise
    // keep (the programmatic blur stays silent — see useTerminal). Never
    // disturb an active IME composition or its deferred commit.
    if (props.ctl.hasFocus() && !props.ctl.imeBusy()) props.ctl.blur()
    lastScrollAt = performance.now()
    acc += pixels
    const { lines, rest } = takeTouchLines(acc, props.ctl.rowHeight(), scrollDirection)
    acc = rest
    if (lines) scrollDirection = Math.sign(lines)
    pendingLines += lines
    if (lines && !raf) {
      // Scroll the first row now; further motion coalesces to one buffer
      // scroll per frame — xterm paints locally, there is no queue.
      flush()
      raf = requestAnimationFrame(flush)
    }
  },
  momentum(pixels, point) {
    lastScrollAt = performance.now()
    acc += pixels
    const { lines, rest } = takeTouchLines(acc, props.ctl.rowHeight(), scrollDirection)
    acc = rest
    if (lines) scrollDirection = Math.sign(lines)
    if (lines) props.ctl.scroll(lines)
  },
  horizontal(pixels) {
    lastScrollAt = performance.now()
    // A pan is not typing either: same release rule as the vertical axis.
    if (props.ctl.hasFocus() && !props.ctl.imeBusy()) props.ctl.blur()
    const el = scroller(); if (el) el.scrollLeft -= pixels
  },
  canHorizontal: () => { const el = scroller(); return !!el && el.scrollWidth > el.clientWidth },
  // A harder flick earns a longer glide: one page minimum, up to three.
  maxMomentum: (speed) => props.ctl.rowHeight() * props.ctl.pageRows() * Math.min(3, 1 + Math.abs(speed) * 1.5),
  dragStart: () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = undefined } },
})
// Long press on the gesture surface opens copy mode; it must not be mistaken
// for a slow tap or leak into the tap->focus path on release.
let lpTimer: ReturnType<typeof setTimeout> | undefined, lpX = 0, lpY = 0, lpEntered = false, lpScale = 1
// The 480ms hold fired: its release belongs to the hold — whether copy
// opened or was refused (IME busy, capture refused) — never to a tap.
let lpHeld = false
const armLongPress = () => { lpHeld = false; clearTimeout(lpTimer); lpTimer = setTimeout(enterCopyMode, 480) }
let entryFinger = false
let composing = false
const compositionStart = () => {
  composing = true
  // An armed hold the composition preempts still owns its release: the
  // finger lands on an active IME, never on a tap.
  if (lpTimer) lpHeld = true
  clearTimeout(lpTimer); lpTimer = undefined
}
const compositionEnd = () => { composing = false }
let suppressCopyContextUntil = 0
function enterCopyMode() {
  lpTimer = undefined
  lpHeld = true
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
  // Cancel both input paths and any pending gesture before freezing.
  cancelTouch()
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
// Touch/hold state only: the wheel's accumulation survives so consecutive
// wheel events keep coalescing — onWheel calls this before each event.
function cancelTouchState() {
  clearTimeout(lpTimer); lpTimer = undefined
  touch.cancel()
  touching = false
  releaseDisqualified = false
  cancelAnimationFrame(raf); raf = 0
  pendingLines = acc = scrollDirection = 0
  // The legacy path too: its queued rows never flush and the cancelled
  // gesture's release is never a tap.
  cancelAnimationFrame(legacyRaf); legacyRaf = 0
  legacyPendingLines = legacyAcc = 0
  legacyLastX = legacyLastY = null
  legacyMoved = true
}
// Full cancellation: input, lifecycle, geometry, a new gesture or copy entry
// also stops the wheel's queued rows — they were measured for a viewport and
// gesture that no longer exist.
function cancelTouch() {
  cancelTouchState()
  cancelAnimationFrame(wheelRaf); wheelRaf = 0
  wheelPendingLines = wheelAcc = 0
}
// A resize (terminal, keyboard, viewport) invalidates coordinates and stops
// inertia, but the finger still owns its gesture: keep the drag/tap state so
// the release cannot turn into a tap, a hold or accidental input. In both
// modes the pending hold dies and the release is disqualified; an already
// opened copy surface is untouched.
let releaseDisqualified = false
function resizeTouch() {
  clearTimeout(lpTimer); lpTimer = undefined
  touch.stopMomentum()
  if (touching) releaseDisqualified = true
  else touch.cancel()
  legacyMoved = true
  cancelAnimationFrame(raf); raf = 0
  pendingLines = acc = scrollDirection = 0
  cancelAnimationFrame(legacyRaf); legacyRaf = 0
  legacyPendingLines = legacyAcc = 0
  cancelAnimationFrame(wheelRaf); wheelRaf = 0
  wheelPendingLines = wheelAcc = 0
}
watch(props.ctl.scrollGeometryVersion, resizeTouch)
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
  if (copyMode.value) return
  lastTouchAt = performance.now()
  // A second finger arriving through a new touchstart kills the pending hold,
  // without waiting for a move.
  if (e.touches.length !== 1) { cancelTouch(); legacyLastY = legacyLastX = null; return }
  lpEntered = false
  lpScale = window.visualViewport?.scale ?? 1
  lpX = e.touches[0]!.clientX; lpY = e.touches[0]!.clientY
  // A new gesture owns the viewport in both modes: queued wheel or drag rows
  // measured for the previous one must never flush into it.
  cancelTouch()
  if (!smoothTouchScrolling.value) { armLongPress(); return legacyOnTouchStart(e) }
  // Android Back can hide the IME while leaving xterm's textarea focused.
  // Release that stale focus before another touch can reactivate the IME —
  // but never while a composition or deferred commit is still in flight
  // (the long-press capture refuses them; the blur must not precede it).
  if (!kbOpen.value && props.ctl.hasFocus() && !props.ctl.imeBusy()) props.ctl.blur()
  // A scrolling finger must never trigger the browser's native focus action.
  // An intentional tap focuses synchronously from touchend instead.
  if (e.cancelable) e.preventDefault()
  // Retain this across pointerdown cancellation, which precedes touchstart.
  // A tap during or just after scrolling only stops the viewport.
  stoppingScroll = lastTouchAt - lastScrollAt < 700
  touching = true
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
  // A release that belongs to a long hold is never a tap — whether the hold
  // opened copy mode or was refused. It must not blur or focus either: an
  // IME composition can still be in flight. Stamp the touch so a stray
  // compatibility mouse cannot reopen the keyboard either.
  if (copyMode.value || lpHeld) { touching = false; lastTouchAt = performance.now(); e.preventDefault(); return }
  lastTouchAt = performance.now()
  clearTimeout(lpTimer); lpTimer = undefined
  if (!smoothTouchScrolling.value) return legacyOnTouchEnd(e)
  touching = false
  const t = e.changedTouches[0]
  // The coalesced release point decides tap versus sub-slop drag — unless a
  // geometry change already disqualified this release.
  const tapped = !releaseDisqualified && touch.end(t ? { x: t.clientX, y: t.clientY } : undefined)
  // Flush the drag before any momentum tick so every sample stays in order.
  if (raf) { cancelAnimationFrame(raf); raf = 0; flush() }
  if (tapped && !stoppingScroll && !lpEntered && t) {
    const linked = props.ctl.tapLink(t.clientX, t.clientY)
    if (!linked) props.ctl.tapMouse(t.clientX, t.clientY)
    // A tap on the cursor's own row is a request to type at the field —
    // focus it. Taps anywhere else act on the pane only: scroll-adjacent
    // taps must not keep reopening the keyboard.
    if (!linked && tapFocuses && props.ctl.tapOnCursor(t.clientX, t.clientY)) props.ctl.focus()
    else {
      props.ctl.blur()
      ;(document.activeElement as HTMLElement | null)?.blur?.()
    }
  }
  // The action already ran in this trusted touch event. Do not depend on a
  // compatibility mouse event, which can be absent or arrive twice on iOS.
  e.preventDefault()
}
// The layer only receives the mouse on a touch screen (main.css): on a
// computer, xterm receives it directly (selection, mouse mode). A
// compatibility mouse after a touch is never a focus request — touchend
// already decided the tap's keyboard intent in both modes.
function onMouseDown(e: MouseEvent) {
  if (copyMode.value) return
  const fromTouch = mouseFromTouch((e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents, performance.now() - lastTouchAt)
  // A touch-derived compatibility mouse is never a focus request: touchend
  // already decided the tap's keyboard intent in both modes.
  if (fromTouch) return
  props.ctl.focus()
}
// Listened on the whole block, before xterm: on a computer the mouse reaches
// xterm (selection), which would otherwise send the wheel to the program in mouse
// mode. Herdr applies the application's mouse mode itself.
function onWheel(e: WheelEvent) {
  if (copyMode.value) return
  // A wheel is another input device acting on the viewport: it cancels any
  // pending touch or hold in either scroll mode — but not the wheel's own
  // accumulation, which coalesces across consecutive events.
  cancelTouchState()
  legacyOnWheel(e)
}

let fitTimer: ReturnType<typeof setTimeout> | undefined
// Throttle rather than debounce: long divider drags must keep fitting while
// the pointer moves, without sending every intermediate pixel to Herdr.
function scheduleFit() {
  // fitNow may resize locally before the echoed frame — there is no resized
  // callback to bump scrollGeometryVersion, so invalidate directly here in
  // both scroll modes: a hold measured against the old geometry dies, the
  // finger's release stays disqualified.
  resizeTouch()
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
      @touchstart="onTouchStart" @touchmove="onTouchMove" @touchend="onTouchEnd" @touchcancel="cancelTouch"
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
