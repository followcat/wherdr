<script setup lang="ts">
// Raw terminal of the pane: xterm.js + touch layer (scrolling with a finger or
// the wheel -> terminal.scroll, the history lives in Herdr; never ↑/↓
// sent to the agent; click = keyboard to the terminal).
import '@xterm/xterm/css/xterm.css'
import { createTerminalTouch, touchPreviewOffset } from '~/utils/terminalTouch'
import { ansiToLines } from '~/utils/ansiToHtml'

const props = defineProps<{ ctl: TerminalCtl }>()
const host = ref<HTMLElement | null>(null)

let legacyLastY: number | null = null
let legacyLastX: number | null = null
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
function legacyOnTouchStart(e: TouchEvent) {
  legacyLastY = e.touches[0]!.clientY
  legacyLastX = e.touches[0]!.clientX
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
  // terminal stays readable in full.
  if (!legacyMoved) {
    // No keyboard for a link: cancels the mousedown that follows the tap.
    if (t) {
      if (props.ctl.tapLink(t.clientX, t.clientY)) e.preventDefault()
      else props.ctl.tapMouse(t.clientX, t.clientY)
    }
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
const pvTop = ref<HTMLElement | null>(null)
const pvBot = ref<HTMLElement | null>(null)
let pvKey = ''
// Cached rows filling the edge the preview reveals: the strip sits in the
// gap the translated screen leaves, painted from the transcript cache so a
// lead wider than the frame rate still shows real content.
const renderPreview = (px: number) => {
  const screen = screenEl(), wrap = host.value
  if (!screen || !wrap || !pvTop.value || !pvBot.value) return
  const h = props.ctl.rowHeight()
  const wrapRect = wrap.getBoundingClientRect()
  const sRect = screen.getBoundingClientRect()
  const top0 = sRect.top - wrapRect.top - px
  for (const [el, dir] of [[pvTop.value, 1], [pvBot.value, -1]] as const) {
    const show = Math.sign(px) === dir
    const size = show ? Math.abs(px) : 0
    const need = Math.ceil(size / h)
    const key = show ? `${dir}:${need}:${props.ctl.frameTick.value}` : ''
    el.style.top = `${dir > 0 ? top0 : top0 + sRect.height - size}px`
    el.style.left = `${sRect.left - wrapRect.left}px`
    el.style.width = `${sRect.width}px`
    el.style.height = `${size}px`
    if (show && key !== pvKey) {
      pvKey = key
      const cs = getComputedStyle(screen)
      Object.assign(el.style, { fontFamily: cs.fontFamily, fontSize: cs.fontSize, letterSpacing: cs.letterSpacing, color: cs.color })
      el.replaceChildren(...props.ctl.previewRows(dir, need).map(row => {
        const div = document.createElement('div')
        div.className = 'pv-line'
        div.style.height = `${h}px`
        div.style.lineHeight = `${h}px`
        if (row) div.textContent = row
        return div
      }))
    }
  }
}
const applyOffset = () => {
  const el = screenEl()
  if (!el) return
  const h = props.ctl.rowHeight()
  const raw = acc + (pendingLines + unconfirmed) * h
  const px = smoothTouchScrolling.value ? touchPreviewOffset(raw, h, props.ctl.previewExtra(Math.sign(raw)) * h) : 0
  el.style.willChange = px ? 'transform' : ''
  el.style.transform = px ? `translate3d(0, ${px}px, 0)` : ''
  renderPreview(px)
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
})
function cancelTouch() {
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
watch(pageVisible, visible => { if (!visible) cancelTouch() })
watch(smoothTouchScrolling, () => {
  cancelTouch()
  cancelAnimationFrame(legacyRaf); legacyRaf = 0
  legacyPendingLines = legacyAcc = 0
  legacyLastX = legacyLastY = null
}, { flush: 'sync' })
function onTouchStart(e: TouchEvent) {
  if (!smoothTouchScrolling.value) return legacyOnTouchStart(e)
  lastTouchAt = performance.now()
  // Retain this across pointerdown cancellation, which precedes touchstart.
  // A tap during or just after scrolling only stops the viewport.
  stoppingScroll = lastTouchAt - lastScrollAt < 700
  allowTouchFocus = false
  cancelTouch()
  if (e.touches.length === 1) touch.start(e.touches[0]!.clientX, e.touches[0]!.clientY)
}
function onTouchMove(e: TouchEvent) {
  if (!smoothTouchScrolling.value) return legacyOnTouchMove(e)
  e.preventDefault()
  if (e.touches.length !== 1) { cancelTouch(); return }
  touch.move(e.touches[0]!.clientX, e.touches[0]!.clientY)
}
function onTouchEnd(e: TouchEvent) {
  if (!smoothTouchScrolling.value) return legacyOnTouchEnd(e)
  lastTouchAt = performance.now()
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
  if (!smoothTouchScrolling.value) return legacyOnMouseDown()
  const fromTouch = (e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents
  // Preserve keyboard access for an intentional tap, but never refocus after
  // a drag, a link, or the tap that stopped inertia.
  if ((fromTouch || (fromTouch === undefined && performance.now() - lastTouchAt < 700)) && !allowTouchFocus) return
  allowTouchFocus = false
  props.ctl.focus()
}
// Listened on the whole block, before xterm: on a computer the mouse reaches
// xterm (selection), which would otherwise send the wheel to the program in mouse
// mode. Herdr applies the application's mouse mode itself.
function onWheel(e: WheelEvent) {
  if (smoothTouchScrolling.value) cancelTouch()
  legacyOnWheel(e)
}

// ---------------------------------------------------------------- scrollback
// A native scroller stacked over the terminal: history lines at the top,
// a one-viewport transparent gap at the bottom. At rest the gap fills the
// view (the live terminal shows through); dragging up reveals local history
// with the browser's own momentum -- the same mechanism as the chat view.
// On touch this is the scroller for panes on old Herdr without mouse
// capability; mouse-capable panes keep touches for ctl.scroll (see
// sbInteractive). The wheel path (computers) always goes through
// terminal.scroll.
const sbEl = ref<HTMLElement | null>(null)
const sbBody = ref<HTMLElement | null>(null)
const sbCoarse = typeof matchMedia !== 'undefined' && matchMedia('(hover: none) and (pointer: coarse)').matches
// Panes whose Herdr speaks terminal.mouse keep their touches: their drags
// reach #touch -> ctl.scroll, so TUI programs scroll in-app and plain panes
// scroll the server-side buffer. Overlaying the dump on those panes reads
// as a copy of the screen sliding over the live one, with no real scroll.
const sbInteractive = computed(() => sbCoarse && !props.ctl.mouseMode.value)
// Distance from the bottom that still counts as the live gap. An empty
// .sb-body keeps a few pixels of CSS padding, so a 2px slop would treat
// rest as "into history" and drop taps on the transparent gap.
const sbRestPx = 8
let sbFetchedAt = 0
let sbWant = 800
function renderScrollback() {
  const el = sbEl.value, body = sbBody.value
  if (!el || !body) return
  const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  const holder = document.createDocumentFragment()
  for (const spans of ansiToLines(props.ctl.scrollback.value)) {
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
    holder.appendChild(line)
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
    // grid behind it (the gap below stays transparent on purpose).
    body.style.background = getComputedStyle(document.body).getPropertyValue('--bg') || 'black'
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
watch(props.ctl.scrollbackVersion, renderScrollback)
watch(props.ctl.frameTick, () => {
  // Prefetch once the pane is alive so the first upward drag has content.
  if (!sbFetchedAt && !props.ctl.mouseMode.value) { sbFetchedAt = Date.now(); props.ctl.requestScrollback(sbWant) }
})
watch(props.ctl.mouseMode, mouseCapable => {
  // Re-enter at the live view: a dump scrolled mid-history must not
  // resurface over the terminal when the overlay turns interactive again.
  const el = sbEl.value
  if (el) el.scrollTop = el.scrollHeight
  if (!mouseCapable && !sbFetchedAt) { sbFetchedAt = Date.now(); props.ctl.requestScrollback(sbWant) }
})
function onSbScroll() {
  const el = sbEl.value
  if (!el) return
  const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  // Into history with a stale dump: refresh it quietly once in a while.
  if (distFromBottom > sbRestPx && Date.now() - sbFetchedAt > 2500) {
    sbFetchedAt = Date.now()
    props.ctl.requestScrollback(sbWant)
  }
  // Near the top of what we have: widen the window, older lines land above.
  if (el.scrollTop < el.clientHeight && sbWant < 4000) {
    sbWant = Math.min(4000, sbWant + 1000)
    sbFetchedAt = Date.now()
    props.ctl.requestScrollback(sbWant)
  }
}
// Typing should land on the live terminal: pull the overlay back to the gap.
watch(props.ctl.scrollInputVersion, () => { if (sbEl.value) sbEl.value.scrollTop = sbEl.value.scrollHeight })
// Coarse-pointer: #scrollback sits above #touch with pointer-events auto,
// so a rest-state tap never reaches onTouchEnd. Stationary touchend on the
// gap is the same path as a tap on #touch; a drag keeps native momentum.
let sbAX = 0, sbAY = 0
let sbTouchSent = false
function tapGap(x: number, y: number) {
  const el = sbEl.value
  // Only taps at the very bottom reach the pane; taps on history do nothing.
  if (el && el.scrollHeight - el.scrollTop - el.clientHeight > sbRestPx) return false
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
}
function onSbTouchEnd(e: TouchEvent) {
  const t = e.changedTouches[0]
  if (!t || Math.hypot(t.clientX - sbAX, t.clientY - sbAY) > 10) return
  // History rows sit in .sb-body; only the transparent gap is the live pane.
  if (!(e.target as HTMLElement | null)?.closest?.('.sb-gap')) return
  if (tapGap(t.clientX, t.clientY)) {
    sbTouchSent = true
    e.preventDefault()
  }
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
    <div id="term" ref="host">
      <!-- Predicted scroll edges: cached rows revealed by the translated
           screen, filled from the transcript cache (see renderPreview). -->
      <div ref="pvTop" class="pv-strip pv-top" />
      <div ref="pvBot" class="pv-strip pv-bot" />
    </div>
    <div
      id="touch" aria-hidden="true"
      @touchstart.passive="onTouchStart" @touchmove="onTouchMove" @touchend="onTouchEnd" @touchcancel="cancelTouch"
      @mousedown.prevent="onMouseDown"
    />
    <!-- Local scrollback: a real scroller like the chat view. Its lines fill
         the top, a transparent one-viewport gap sits at the bottom over the
         live terminal -- scrolling up just reveals history, natively. -->
    <div
      id="scrollback" ref="sbEl"
      :style="{ pointerEvents: sbInteractive ? 'auto' : 'none', visibility: sbInteractive ? 'visible' : 'hidden' }"
      @scroll.passive="onSbScroll"
      @touchstart.passive="onSbTouchStart"
      @touchend="onSbTouchEnd"
    >
      <div ref="sbBody" class="sb-body" />
      <div class="sb-gap" @click="onGapTap" />
    </div>
    <div v-if="ctl.loading.value" class="term-loading"><span class="spinner" /></div>
    <div v-if="ctl.selectionHint.visible.value" class="terminal-selection-hint">
      {{ tl('Shift + drag to select', 'Shift + glisser pour sélectionner') }}
      <button type="button" :aria-label="t('Hide')" @click="ctl.selectionHint.dismiss()">×</button>
    </div>
  </div>
</template>
