<script setup lang="ts">
// Raw terminal of the pane: xterm.js + touch layer (scrolling with a finger or
// the wheel -> terminal.scroll, the history lives in Herdr; never ↑/↓
// sent to the agent; click = keyboard to the terminal).
import '@xterm/xterm/css/xterm.css'
import { createTerminalTouch } from '~/utils/terminalTouch'
import { ansiToLines } from '~/utils/ansiToHtml'
import type { TerminalCopySnapshot } from '~/utils/terminalCopy'

const props = defineProps<{ ctl: TerminalCtl }>()
const emit = defineEmits<{ copying: [active: boolean] }>()
const host = ref<HTMLElement | null>(null)
const copySnapshot = shallowRef<TerminalCopySnapshot | null>(null)
const copyMetrics = shallowRef<Record<string, string>>({})
const copyMode = computed(() => copySnapshot.value !== null)

let legacyLastY: number | null = null
let legacyLastX: number | null = null
let legacyAcc = 0
let legacyPendingLines = 0
let legacyRaf = 0
let legacyMoved = false
let legacyStartX = 0, legacyStartY = 0
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
  if (Math.hypot(x - legacyStartX, y - legacyStartY) >= 5) {
    legacyMoved = true
    if (props.ctl.hasFocus()) props.ctl.blur()
  }
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
  if (!legacyMoved && !lpEntered && t && Math.hypot(t.clientX - legacyStartX, t.clientY - legacyStartY) < 5) {
    if (!props.ctl.tapLink(t.clientX, t.clientY)) props.ctl.tapMouse(t.clientX, t.clientY)
    // Same as the smooth path: taps close the keyboard, never reopen it.
    props.ctl.blur()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
  }
  // Complete intentional taps here; suppress compatibility mouse events for
  // both taps and drags so they cannot reopen the keyboard afterward.
  e.preventDefault()
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
  legacyAcc -= wheelPixels(e.deltaY, e.deltaMode, h, props.ctl.pageRows())
  const { lines, rest } = takeLines(legacyAcc, h)
  legacyAcc = rest
  if (lines) legacyQueue(lines)
}


// The application owns the viewport. Only real frames move its contents:
// translating a screenshot exposes missing rows and jumps when an ack arrives.
let acc = 0, pendingLines = 0
let raf = 0
let scrollX = 0, scrollY = 0, scrollDirection = 0
let lastTouchAt = -Infinity, lastScrollAt = -Infinity
let stoppingScroll = false, hadScroll = false, touching = false
// Momentum clip bookkeeping: the glide is only worth frames while the pane
// keeps up; scroll.ack (delivered lines, drag + momentum) is the feedback.
let momStartAt = 0, momAckBase = 0, momSent = 0
function flush() {
  raf = 0
  if (!pendingLines) return
  const n = pendingLines
  pendingLines = 0
  if (!props.ctl.scroll(n, scrollX, scrollY, 0, true)) acc = 0
}
const scroller = () => host.value?.querySelector('.xterm') as HTMLElement | null
const touch = createTerminalTouch({
  vertical(pixels, point) {
    if (!pixels) return
    if (props.ctl.hasFocus()) props.ctl.blur()
    lastScrollAt = performance.now()
    scrollX = point.x; scrollY = point.y
    acc += pixels
    const { lines, rest } = takeTouchLines(acc, props.ctl.rowHeight(), scrollDirection)
    acc = rest
    // Reverse on an actual wheel step, not sensor noise or sub-row motion.
    if (lines && scrollDirection && Math.sign(lines) !== scrollDirection) {
      props.ctl.cancelTouchScroll()
      cancelAnimationFrame(raf); raf = 0
      pendingLines = 0
    }
    if (lines) scrollDirection = Math.sign(lines)
    momStartAt = 0 // a new drag re-arms the momentum clip baseline
    pendingLines += lines
    hadScroll = true
    if (lines && !raf) {
      // Send the first useful sample now. Subsequent motion in this rendering
      // frame is coalesced; the server still owns wheel pacing/backpressure.
      flush()
      raf = requestAnimationFrame(flush)
    }
  },
  momentum(pixels, point) {
    lastScrollAt = performance.now()
    if (!momStartAt) { momStartAt = lastScrollAt; momAckBase = props.ctl.scrollAck.value; momSent = 0 }
    acc += pixels
    const { lines, rest } = takeTouchLines(acc, props.ctl.rowHeight(), scrollDirection)
    acc = rest
    // After release there is no finger to follow. Let real application
    // frames show the glide instead of accumulating a translated afterimage.
    if (!lines) return
    props.ctl.scroll(lines, point.x, point.y, 0, true, false)
    momSent += Math.abs(lines)
    // A delivered share far below what we sent means the tail is only
    // queue noise expiring server-side: end the glide instead of ghosting.
    if (lastScrollAt - momStartAt > 140 && momSent >= 6
      && Math.abs(props.ctl.scrollAck.value - momAckBase) < momSent * .35) {
      momStartAt = 0
      // The queued momentum tail is expendable; cancel that phase only —
      // any drag still owed to a finger is untouched.
      props.ctl.cancelTouchScroll('momentum')
      return false
    }
  },
  horizontal(pixels) { lastScrollAt = performance.now(); const el = scroller(); if (el) el.scrollLeft -= pixels },
  canHorizontal: () => { const el = scroller(); return !!el && el.scrollWidth > el.clientWidth },
  // A harder flick earns a longer glide: one page minimum, up to three.
  maxMomentum: (speed) => props.ctl.rowHeight() * props.ctl.pageRows() * Math.min(3, 1 + Math.abs(speed) * 1.5),
  // Axis lock means a drag exists — however small the total displacement
  // ends up — so a held finger can no longer become a long press.
  dragStart: () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = undefined } },
})
// Long press on the gesture surface opens copy mode; it must not be mistaken
// for a slow tap or leak into the tap->focus path on release.
let lpTimer: ReturnType<typeof setTimeout> | undefined, lpX = 0, lpY = 0, lpEntered = false
const armLongPress = () => { clearTimeout(lpTimer); lpTimer = setTimeout(enterCopyMode, 480) }
let entryFinger = false
let composing = false
const compositionStart = () => { composing = true; clearTimeout(lpTimer) }
const compositionEnd = () => { composing = false }
let suppressCopyContextUntil = 0
function enterCopyMode() {
  lpTimer = undefined
  if (copyMode.value || composing || (window.visualViewport?.scale ?? 1) !== lpScale) return
  const snapshot = props.ctl.captureScreen()
  const screen = host.value?.querySelector('.xterm-screen')
  if (!snapshot || !screen) return
  const cs = getComputedStyle(screen)
  copyMetrics.value = {
    fontFamily: snapshot.fontFamily || cs.fontFamily, fontSize: snapshot.fontSize ? `${snapshot.fontSize}px` : cs.fontSize, lineHeight: `${props.ctl.rowHeight()}px`,
    letterSpacing: cs.letterSpacing, color: cs.color, width: `${screen.getBoundingClientRect().width}px`,
  }
  lpEntered = entryFinger = true
  suppressCopyContextUntil = performance.now() + 1000
  // Cancel both input paths and the remote queue, even if the last drag was
  // already acknowledged. Capture before blur can resize the live terminal.
  cancelTouch()
  sbHeld = false
  cancelAnimationFrame(legacyRaf); legacyRaf = 0
  legacyPendingLines = legacyAcc = 0
  legacyLastX = legacyLastY = null
  props.ctl.cancelTouchScroll()
  props.ctl.blur()
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  copySnapshot.value = snapshot
  emit('copying', true)
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
let lpScale = 1
function cancelTouch() {
  clearTimeout(lpTimer); lpTimer = undefined
  touch.cancel()
  touching = false
  cancelAnimationFrame(raf); raf = 0
  pendingLines = acc = scrollDirection = 0
  if (hadScroll) props.ctl.cancelTouchScroll()
  hadScroll = false
}
// Keyboard and terminal resizing invalidate coordinates and inertia, but the
// finger still owns its gesture. Keep its last position and drag/tap state.
function resizeTouch() {
  touch.stopMomentum()
  if (!touching) touch.cancel()
  cancelAnimationFrame(raf); raf = 0
  pendingLines = acc = scrollDirection = 0
  if (hadScroll) props.ctl.cancelTouchScroll()
  hadScroll = false
}
watch(props.ctl.scrollGeometryVersion, resizeTouch)
watch(props.ctl.scrollInputVersion, cancelTouch)
watch(pageVisible, visible => { if (!visible) cancelTouch() })
watch(smoothTouchScrolling, () => {
  cancelTouch()
  cancelAnimationFrame(legacyRaf); legacyRaf = 0
  legacyPendingLines = legacyAcc = 0
  legacyLastX = legacyLastY = null
}, { flush: 'sync' })
function onTouchStart(e: TouchEvent) {
  if (copyMode.value) return
  // Android Back can hide the IME while leaving xterm's textarea focused.
  // Release that stale focus before another touch can reactivate the IME.
  if (!kbOpen.value && props.ctl.hasFocus()) props.ctl.blur()
  lastTouchAt = performance.now()
  // A scrolling finger must never trigger the browser's native focus action.
  // An intentional tap focuses synchronously from touchend instead.
  if (e.cancelable) e.preventDefault()
  if (e.touches.length !== 1) { cancelTouch(); legacyLastY = legacyLastX = null; return }
  lpEntered = false
  lpScale = window.visualViewport?.scale ?? 1
  lpX = e.touches[0]!.clientX; lpY = e.touches[0]!.clientY
  if (!smoothTouchScrolling.value) { armLongPress(); return legacyOnTouchStart(e) }
  // pointerdown has already stopped local momentum; keep its recency so the
  // stopping tap cannot become a click or open the keyboard.
  stoppingScroll = lastTouchAt - lastScrollAt < 700
  cancelTouch()
  touching = true
  touch.start(e.touches[0]!.clientX, e.touches[0]!.clientY)
  armLongPress()
}
function onTouchMove(e: TouchEvent) {
  if (copyMode.value) return
  e.preventDefault()
  const tm = e.touches[0]
  if (tm && Math.hypot(tm.clientX - lpX, tm.clientY - lpY) > 8) { clearTimeout(lpTimer); lpTimer = undefined }
  if (e.touches.length !== 1) { cancelTouch(); legacyLastX = legacyLastY = null; return }
  if (!smoothTouchScrolling.value) return legacyOnTouchMove(e)
  touch.move(e.touches[0]!.clientX, e.touches[0]!.clientY)
}
function onTouchEnd(e: TouchEvent) {
  if (copyMode.value || lpEntered) { e.preventDefault(); return }
  lastTouchAt = performance.now()
  clearTimeout(lpTimer); lpTimer = undefined
  if (!smoothTouchScrolling.value) return legacyOnTouchEnd(e)
  touching = false
  const t = e.changedTouches[0]
  const tapped = touch.end(t ? { x: t.clientX, y: t.clientY } : undefined)
  // Flush the drag before any momentum tick so both directions retain order.
  if (raf) { cancelAnimationFrame(raf); raf = 0; flush() }
  if (tapped && !stoppingScroll && !lpEntered && t) {
    if (!props.ctl.tapLink(t.clientX, t.clientY)) props.ctl.tapMouse(t.clientX, t.clientY)
    // A simple tap never opens the keyboard — scroll-adjacent taps would
    // keep reopening it. Typing starts from the keybar ⌨ instead.
    props.ctl.blur()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
  }
  // The action has already run in this trusted touch event. Do not depend on
  // a compatibility mouse event, which can be absent or arrive twice on iOS.
  e.preventDefault()
}
function onMouseDown(e: MouseEvent) {
  const fromTouch = (e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents
  if (fromTouch || (fromTouch === undefined && performance.now() - lastTouchAt < 700)) return
  props.ctl.focus()
}
function onWheel(e: WheelEvent) {
  if (copyMode.value) return
  if (smoothTouchScrolling.value) cancelTouch()
  legacyOnWheel(e)
}

// Older Herdr panes without mouse support retain their native history dump.
// Mouse-capable panes keep the gesture surface over the real live terminal.
const sbEl = ref<HTMLElement | null>(null)
const sbBody = ref<HTMLElement | null>(null)
const sbCoarse = typeof matchMedia !== 'undefined' && matchMedia('(hover: none) and (pointer: coarse)').matches
const sbInteractive = computed(() => sbCoarse && !props.ctl.mouseMode.value)
const sbOpen = sbInteractive
const sbRestPx = 8
let sbFetchedAt = 0, sbWant = 800
function lineDiv(spans: { text: string, color?: string, background?: string, bold?: boolean, dim?: boolean, italic?: boolean, underline?: boolean, strike?: boolean }[]) {
  const line = document.createElement('div')
  line.className = 'sb-line'
  for (const s of spans) {
    const span = document.createElement('span')
    span.textContent = s.text
    if (s.color) span.style.color = s.color
    if (s.background) span.style.backgroundColor = s.background
    if (s.bold) span.style.fontWeight = '600'
    if (s.dim) span.style.opacity = '.55'
    if (s.italic) span.style.fontStyle = 'italic'
    if (s.underline || s.strike) span.style.textDecoration = [s.underline && 'underline', s.strike && 'line-through'].filter(Boolean).join(' ')
    line.appendChild(span)
  }
  return line
}
function renderScrollback() {
  const el = sbEl.value, body = sbBody.value
  if (!el || !body) return
  const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  const holder = document.createDocumentFragment()
  for (const spans of ansiToLines(props.ctl.scrollback.value)) holder.appendChild(lineDiv(spans))
  body.replaceChildren(holder)
  // Match the terminal's metrics and geometry so history rows continue the
  // live grid pixel-exactly (the term is centered/inset on phones).
  const src = host.value?.querySelector('.xterm-screen')
  if (src) {
    const cs = getComputedStyle(src)
    Object.assign(el.style, { fontFamily: cs.fontFamily, fontSize: cs.fontSize, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, color: cs.color })
    el.style.setProperty('--sb-lh', cs.lineHeight)
    // The screen canvas paints its own bg; the element itself is transparent,
    // so take the page surface to hide the live grid behind history.
    const bg = getComputedStyle(document.body).getPropertyValue('--bg') || 'black'
    body.style.background = bg
    const gap = el.querySelector('.sb-gap') as HTMLElement | null
    if (gap) gap.style.background = ''
    const wrap = el.getBoundingClientRect()
    const sr = src.getBoundingClientRect()
    Object.assign(body.style, {
      paddingTop: `${Math.max(0, sr.top - wrap.top)}px`,
      paddingLeft: `${Math.max(0, sr.left - wrap.left)}px`,
      paddingRight: `${Math.max(0, wrap.right - sr.right)}px`,
    })
  }
  // Keep the same distance from the bottom across refetches: the live view
  // stays anchored at the gap, a wider window only grows lines above it.
  // Near rest, snap to the gap so padding on an empty body cannot leave a
  // few pixels of history peeking and blocking rest-state taps.
  el.scrollTop = distFromBottom <= sbRestPx
    ? el.scrollHeight
    : Math.max(0, el.scrollHeight - el.clientHeight - distFromBottom)
}
// A chunk that lands mid-gesture rebuilds the DOM under a tracking finger
// (or a native fling) and its scrollTop write fights the scroller. Hold it
// until the gesture settles, bounded so a long read is not starved.
let sbHeld = false, sbDirty = false
let sbDeferTimer: ReturnType<typeof setTimeout> | undefined
function flushScrollback() {
  sbDeferTimer = undefined
  if (!sbDirty) return
  sbDirty = false
  renderScrollback()
}
function deferScrollback() {
  sbDirty = true
  if (!sbDeferTimer) sbDeferTimer = setTimeout(flushScrollback, 600)
}
watch(props.ctl.scrollbackVersion, () => {
  if (sbHeld || performance.now() - sbLastMoveAt < 500) return deferScrollback()
  renderScrollback()
})
watch(props.ctl.frameTick, () => {
  if (!sbFetchedAt && !props.ctl.mouseMode.value) {
    sbFetchedAt = Date.now()
    props.ctl.requestScrollback(sbWant)
  }
})
watch(props.ctl.mouseMode, mouseCapable => {
  if (sbEl.value && !copyMode.value) sbEl.value.scrollTop = sbEl.value.scrollHeight
  if (!mouseCapable && !sbFetchedAt) {
    sbFetchedAt = Date.now()
    props.ctl.requestScrollback(sbWant)
  }
})
let sbLastMoveAt = -Infinity, sbLastTop = -1
function onSbScroll() {
  const el = sbEl.value
  if (!el || !sbOpen.value) return
  if (sbLastTop >= 0 && Math.abs(el.scrollTop - sbLastTop) > 2) sbLastMoveAt = performance.now()
  sbLastTop = el.scrollTop
  // A refetch rebuilds the text surface and would destroy a live selection.
  if (copyMode.value) return
  const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  if (distFromBottom > sbRestPx && Date.now() - sbFetchedAt > 2500) {
    sbFetchedAt = Date.now()
    props.ctl.requestScrollback(sbWant)
  }
  if (el.scrollTop < el.clientHeight && sbWant < 4000) {
    sbWant = Math.min(4000, sbWant + 1000)
    sbFetchedAt = Date.now()
    props.ctl.requestScrollback(sbWant)
  }
}
watch(props.ctl.scrollInputVersion, () => {
  // Copy mode is a still document: inputs and reconnects must not yank the
  // reading position out from under an in-progress selection.
  if (sbEl.value && !copyMode.value) sbEl.value.scrollTop = sbEl.value.scrollHeight
})
let sbAX = 0, sbAY = 0, sbStartTop = 0
let sbTouchSent = false, sbWasMoving = false
function tapGap(x: number, y: number) {
  const el = sbEl.value
  if (el && el.scrollHeight - el.scrollTop - el.clientHeight > sbRestPx) return false
  if (sbWasMoving || (el && Math.abs(el.scrollTop - sbStartTop) > 2)) return true
  if (!props.ctl.tapLink(x, y)) props.ctl.tapMouse(x, y)
  props.ctl.blur()
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  return true
}
function onGapTap(e: MouseEvent) {
  if (sbTouchSent) { sbTouchSent = false; return }
  tapGap(e.clientX, e.clientY)
}
function onSbTouchStart(e: TouchEvent) {
  if (e.touches.length !== 1) { cancelTouch(); return }
  lpEntered = false
  lpX = e.touches[0]!.clientX; lpY = e.touches[0]!.clientY
  lpScale = window.visualViewport?.scale ?? 1
  // Only the live gap enters screen-copy. History above it retains ordinary
  // native scrolling/selection; it must never be mislabelled as a live capture.
  if ((e.target as HTMLElement)?.closest('.sb-gap')) armLongPress()
  sbTouchSent = false
  sbHeld = true
  sbAX = e.touches[0]!.clientX
  sbAY = e.touches[0]!.clientY
  sbStartTop = sbEl.value?.scrollTop ?? 0
  sbWasMoving = performance.now() - sbLastMoveAt < 400
}
function onSbTouchMove(e: TouchEvent) {
  // Same contract as the xterm axis lock: past the 5px slop it is a drag,
  // not a hold — a short move must not become a long press.
  if (e.touches.length !== 1 || Math.hypot(e.touches[0]!.clientX - lpX, e.touches[0]!.clientY - lpY) > 5) {
    clearTimeout(lpTimer); lpTimer = undefined
  }
}
function onSbTouchEnd(e: TouchEvent) {
  clearTimeout(lpTimer); lpTimer = undefined
  if (copyMode.value || lpEntered) { e.preventDefault(); return }
  sbHeld = false
  if (sbDirty && !sbDeferTimer) sbDeferTimer = setTimeout(flushScrollback, 300)
  const t = e.changedTouches[0]
  if (!t || Math.hypot(t.clientX - sbAX, t.clientY - sbAY) > 10) return
  if (!(e.target as HTMLElement | null)?.closest?.('.sb-gap')) return
  if (tapGap(t.clientX, t.clientY)) { sbTouchSent = true; e.preventDefault() }
}

let fitTimer: ReturnType<typeof setTimeout> | undefined
// Throttle rather than debounce: long divider drags must keep fitting while
// the pointer moves, without sending every intermediate pixel to Herdr.
function scheduleFit() {
  if (smoothTouchScrolling.value) resizeTouch()
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
  props.ctl.mount(host.value!)
  nextTick(() => {
    props.ctl.fitNow(false)
    if (!props.ctl.hasBanner()) props.ctl.connect(false)
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
  clearTimeout(sbDeferTimer)
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
    <div
      id="scrollback" ref="sbEl" :inert="copyMode"
      :style="{ pointerEvents: sbOpen ? 'auto' : 'none', visibility: sbOpen ? 'visible' : 'hidden' }"
      @scroll.passive="onSbScroll"
      @touchstart.passive="onSbTouchStart" @touchmove.passive="onSbTouchMove"
      @touchend="onSbTouchEnd"
      @touchcancel.passive="sbHeld = false; cancelTouch()"
    >
      <div ref="sbBody" class="sb-body" />
      <div class="sb-gap" @click="onGapTap" />
    </div>
    <TerminalCopyLayer v-if="copySnapshot" :snapshot="copySnapshot" :metrics="copyMetrics" @close="exitCopyMode" />
    <div v-if="ctl.loading.value" class="term-loading"><span class="spinner" /></div>
    <div v-if="ctl.selectionHint.visible.value" class="terminal-selection-hint">
      {{ tl('Shift + drag to select', 'Shift + glisser pour sélectionner') }}
      <button type="button" :aria-label="t('Hide')" @click="ctl.selectionHint.dismiss()">×</button>
    </div>
  </div>
</template>
