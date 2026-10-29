<script setup lang="ts">
// Raw terminal of the pane: xterm.js + touch layer (scrolling with a finger or
// the wheel -> terminal.scroll, the history lives in Herdr; never ↑/↓
// sent to the agent; click = keyboard to the terminal).
import '@xterm/xterm/css/xterm.css'
import { createTerminalTouch } from '~/utils/terminalTouch'
import { ansiToLines } from '~/utils/ansiToHtml'

const props = defineProps<{ ctl: TerminalCtl }>()
const host = ref<HTMLElement | null>(null)

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
    if (!props.ctl.tapLink(t.clientX, t.clientY)) {
      props.ctl.tapMouse(t.clientX, t.clientY)
      props.ctl.focus()
    } else props.ctl.blur()
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
    acc += pixels
    const { lines, rest } = takeTouchLines(acc, props.ctl.rowHeight(), scrollDirection)
    acc = rest
    // After release there is no finger to follow. Let real application
    // frames show the glide instead of accumulating a translated afterimage.
    if (lines) props.ctl.scroll(lines, point.x, point.y, 0, true, false)
  },
  horizontal(pixels) { lastScrollAt = performance.now(); const el = scroller(); if (el) el.scrollLeft -= pixels },
  canHorizontal: () => { const el = scroller(); return !!el && el.scrollWidth > el.clientWidth },
  maxMomentum: () => props.ctl.rowHeight() * props.ctl.pageRows(),
})
// Long press on the gesture surface opens copy mode; it must not be mistaken
// for a slow tap or leak into the tap->focus path on release.
let lpTimer: ReturnType<typeof setTimeout> | undefined, lpX = 0, lpY = 0, lpEntered = false
const armLongPress = () => { clearTimeout(lpTimer); lpTimer = setTimeout(enterCopyMode, 480) }
const cpSelLen = ref(0), cpCopied = ref(false)
let cpCopiedTimer: ReturnType<typeof setTimeout> | undefined
function onSelChange() {
  const sel = document.getSelection()
  cpSelLen.value = sel && !sel.isCollapsed ? sel.toString().length : 0
}
function selectAllCopy() {
  const sel = document.getSelection()
  if (sbBody.value && sel) sel.selectAllChildren(sbBody.value)
}
async function copySelection() {
  const text = document.getSelection()?.toString() ?? ''
  if (!text) return
  try { await navigator.clipboard.writeText(text) } catch { try { document.execCommand('copy') } catch { /* no clipboard */ } }
  cpCopied.value = true
  clearTimeout(cpCopiedTimer); cpCopiedTimer = setTimeout(() => { cpCopied.value = false }, 1200)
}
function enterCopyMode() {
  lpTimer = undefined
  lpEntered = true
  if (copyMode.value) return
  copyMode.value = true
  cpSelLen.value = 0
  cpCopied.value = false
  haptic()
  // The finger may still be down: drop the gesture so it cannot scroll the
  // live pane behind the copy surface.
  cancelTouch()
  document.addEventListener('selectionchange', onSelChange)
  if (!sbFetchedAt) { sbFetchedAt = Date.now(); props.ctl.requestScrollback(sbWant) }
  nextTick(() => {
    renderScrollback()
    if (sbEl.value) sbEl.value.scrollTop = sbEl.value.scrollHeight
  })
}
function exitCopyMode() {
  if (!copyMode.value) return
  copyMode.value = false
  document.removeEventListener('selectionchange', onSelChange)
  document.getSelection()?.removeAllRanges()
  cpSelLen.value = 0
  cpCopied.value = false
  clearTimeout(cpCopiedTimer)
  renderScrollback()
}
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
  // Android Back can hide the IME while leaving xterm's textarea focused.
  // Release that stale focus before another touch can reactivate the IME.
  if (!kbOpen.value && props.ctl.hasFocus()) props.ctl.blur()
  lastTouchAt = performance.now()
  // A scrolling finger must never trigger the browser's native focus action.
  // An intentional tap focuses synchronously from touchend instead.
  if (e.cancelable) e.preventDefault()
  if (e.touches.length !== 1) { cancelTouch(); legacyLastY = legacyLastX = null; return }
  lpEntered = false
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
  e.preventDefault()
  const tm = e.touches[0]
  if (tm && Math.hypot(tm.clientX - lpX, tm.clientY - lpY) > 10) { clearTimeout(lpTimer); lpTimer = undefined }
  if (e.touches.length !== 1) { cancelTouch(); legacyLastX = legacyLastY = null; return }
  if (!smoothTouchScrolling.value) return legacyOnTouchMove(e)
  touch.move(e.touches[0]!.clientX, e.touches[0]!.clientY)
}
function onTouchEnd(e: TouchEvent) {
  lastTouchAt = performance.now()
  clearTimeout(lpTimer); lpTimer = undefined
  if (!smoothTouchScrolling.value) return legacyOnTouchEnd(e)
  touching = false
  const t = e.changedTouches[0]
  const tapped = touch.end(t ? { x: t.clientX, y: t.clientY } : undefined)
  // Flush the drag before any momentum tick so both directions retain order.
  if (raf) { cancelAnimationFrame(raf); raf = 0; flush() }
  if (tapped && !stoppingScroll && !lpEntered && t) {
    if (!props.ctl.tapLink(t.clientX, t.clientY)) {
      props.ctl.tapMouse(t.clientX, t.clientY)
      props.ctl.focus()
    } else props.ctl.blur()
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
  if (smoothTouchScrolling.value) cancelTouch()
  legacyOnWheel(e)
}

// Older Herdr panes without mouse support retain their native history dump.
// Mouse-capable panes keep the gesture surface over the real live terminal.
const sbEl = ref<HTMLElement | null>(null)
const sbBody = ref<HTMLElement | null>(null)
const sbCoarse = typeof matchMedia !== 'undefined' && matchMedia('(hover: none) and (pointer: coarse)').matches
const sbInteractive = computed(() => sbCoarse && !props.ctl.mouseMode.value)
// Copy mode (long press): the overlay becomes an opaque, selectable snapshot
// of history plus the live screen, so a selection can cross page boundaries.
const copyMode = ref(false)
const sbOpen = computed(() => sbInteractive.value || copyMode.value)
const sbRestPx = 8
let sbFetchedAt = 0, sbWant = 800
function lineDiv(spans: { text: string, color?: string, background?: string, bold?: boolean, dim?: boolean, italic?: boolean, underline?: boolean, strike?: boolean }[]) {
  const line = document.createElement('div')
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
  if (copyMode.value) {
    const live = document.createElement('div')
    live.className = 'sb-live'
    live.dataset.label = t('current screen')
    for (const spans of props.ctl.liveScreenSpans()) live.appendChild(lineDiv(spans))
    holder.appendChild(live)
  }
  body.replaceChildren(holder)
  // Match the terminal's metrics and geometry so history rows continue the
  // live grid pixel-exactly (the term is centered/inset on phones).
  const src = host.value?.querySelector('.xterm-screen')
  if (src) {
    const cs = getComputedStyle(src)
    Object.assign(el.style, { fontFamily: cs.fontFamily, fontSize: cs.fontSize, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, color: cs.color })
    // The screen canvas paints its own bg; the element itself is transparent,
    // so take the page surface -- an opaque history region must hide the live
    // grid behind it. In copy mode the snapshot inside the body owns the live
    // rows and the gap is hidden, so the whole surface is one solid document.
    const bg = getComputedStyle(document.body).getPropertyValue('--bg') || 'black'
    body.style.background = bg
    const gap = el.querySelector('.sb-gap') as HTMLElement | null
    if (gap) gap.style.background = copyMode.value ? bg : ''
    const wrap = el.getBoundingClientRect()
    const sr = src.getBoundingClientRect()
    Object.assign(body.style, {
      // In copy mode a fixed bar overlays the top of the snapshot surface.
      paddingTop: `${Math.max(0, sr.top - wrap.top) + (copyMode.value ? 40 : 0)}px`,
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
watch(props.ctl.scrollbackVersion, () => {
  // A re-render rebuilds the snapshot DOM and would destroy a live selection;
  // late history chunks still land while nothing is selected yet.
  if (copyMode.value && cpSelLen.value > 0) return
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
  if (copyMode.value) { exitCopyMode(); return true }
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
  sbTouchSent = false
  sbAX = e.touches[0]!.clientX
  sbAY = e.touches[0]!.clientY
  sbStartTop = sbEl.value?.scrollTop ?? 0
  sbWasMoving = performance.now() - sbLastMoveAt < 400
}
function onSbTouchEnd(e: TouchEvent) {
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
  cancelTouch()
  ro?.disconnect()
  clearTimeout(fitTimer)
  cancelAnimationFrame(legacyRaf)
  props.ctl.dispose()
})
</script>

<template>
  <div id="termWrap" :class="{ 'smooth-touch': smoothTouchScrolling }" @wheel.capture="onWheel">
    <div id="term" ref="host" />
    <div
      id="touch" aria-hidden="true"
      @touchstart="onTouchStart" @touchmove="onTouchMove" @touchend="onTouchEnd" @touchcancel="cancelTouch"
      @mousedown.prevent="onMouseDown"
    />
    <div
      id="scrollback" ref="sbEl" :class="{ 'copy-mode': copyMode }"
      :style="{ pointerEvents: sbOpen ? 'auto' : 'none', visibility: sbOpen ? 'visible' : 'hidden' }"
      @scroll.passive="onSbScroll"
      @touchstart.passive="onSbTouchStart"
      @touchend="onSbTouchEnd"
    >
      <div ref="sbBody" class="sb-body" />
      <div class="sb-gap" @click="onGapTap" />
    </div>
    <div v-if="copyMode" class="cp-bar">
      <span class="cp-title">{{ t('Copy mode') }}</span>
      <div class="cp-actions">
        <button type="button" class="cp-btn" :disabled="!cpSelLen" @click="copySelection">
          {{ cpCopied ? t('Copied') : cpSelLen ? `${t('Copy')} ${cpSelLen}` : t('Copy') }}
        </button>
        <button type="button" class="cp-btn" @click="selectAllCopy">{{ t('Select all') }}</button>
        <button type="button" class="cp-btn done" @click="exitCopyMode">{{ t('Done') }}</button>
      </div>
    </div>
    <div v-if="ctl.loading.value" class="term-loading"><span class="spinner" /></div>
    <div v-if="ctl.selectionHint.visible.value" class="terminal-selection-hint">
      {{ tl('Shift + drag to select', 'Shift + glisser pour sélectionner') }}
      <button type="button" :aria-label="t('Hide')" @click="ctl.selectionHint.dismiss()">×</button>
    </div>
  </div>
</template>
