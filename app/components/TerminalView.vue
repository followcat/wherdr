<script setup lang="ts">
// Raw terminal of the pane: xterm.js + touch layer (scrolling with a finger or
// the wheel -> terminal.scroll, the history lives in Herdr; never ↑/↓
// sent to the agent; click = keyboard to the terminal).
import '@xterm/xterm/css/xterm.css'
import { createTerminalTouch, touchPreviewOffset } from '~/utils/terminalTouch'
import { ansiToLines, ansiSpansToHtml } from '~/utils/ansiToHtml'
import { THEME16_NAMES } from '~/utils/bufferLineHtml'

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
// Read-ahead overshoot: extra lines sent ahead of the finger so arriving
// frames already hold the rows the reveal needs (the transcript cache picks
// them up). overAcked tracks the confirmed part, which the preview offset
// subtracts to hold the screen at the finger's position.
let overSent = 0, overAcked = 0
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
        if (row?.html) div.innerHTML = row.html
        else if (row) div.textContent = row.text
        return div
      }))
    }
  }
}
const applyOffset = () => {
  const el = screenEl()
  if (!el) return
  if (ltActive.value) { ltTrack(); return }
  const h = props.ctl.rowHeight()
  const raw = acc + (pendingLines + unconfirmed - overAcked) * h
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
    unconfirmed = pendingLines = acc = overSent = overAcked = 0
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
  // Read ahead ~180ms of the current velocity so the frames streaming back
  // contain the rows the reveal is about to need, capped per flush.
  const lead = Math.abs(touch.velocity()) * 180 / props.ctl.rowHeight()
  const extra = Math.max(0, Math.min(8, Math.round(lead - overSent + overAcked)))
  if (props.ctl.scroll(n + Math.sign(n) * extra, scrollX, scrollY, 0, true)) { unconfirmed += n; overSent += Math.sign(n) * extra }
  else unconfirmed = acc = overSent = overAcked = 0
  applyOffset()
  expirePreview()
}
watch(props.ctl.scrollAck, (value, previous) => {
  const n = value - previous
  ltSentOff -= n
  if (!n || !smoothTouchScrolling.value) return
  if (Math.sign(n) === Math.sign(unconfirmed)) {
    const pay = Math.min(Math.abs(n), Math.abs(unconfirmed))
    unconfirmed -= Math.sign(n) * pay
    // Whatever the ack covers past the finger debt is confirmed overshoot.
    overAcked += Math.sign(n) * (Math.abs(n) - pay)
  }
  // Apply in the same task as the covering repaint -- a deferred rAF let the
  // stale offset ride one extra frame, which read as micro-jitter.
  applyOffset()
}, { flush: 'sync' })
const scroller = () => host.value?.querySelector('.xterm') as HTMLElement | null
const touch = createTerminalTouch({
  vertical(pixels, point) {
    lastScrollAt = performance.now()
    // Reversal abandons stale prediction and pending commands first.
    if (unconfirmed && Math.sign(pixels) !== Math.sign(unconfirmed)) {
      props.ctl.cancelTouchScroll()
      unconfirmed = pendingLines = acc = overSent = overAcked = 0
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
    // Momentum predicts like the drag did: the offset keeps gliding while
    // frames catch up -- the cache strips keep the revealed edge real.
    if (lines && props.ctl.scroll(lines, point.x, point.y, 0, true, true)) unconfirmed += lines
    applyOffset()
    expirePreview()
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
  pendingLines = unconfirmed = momentumAcc = acc = overSent = overAcked = 0
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
// Live transcript mode: on a touch screen over a mouse-capable pane, the
// scroller is a real document -- transcript rows above the live view plus a
// transparent slot the REAL screen is translated onto. First-pass scrolls
// ride the app's own repaints sliding through the document; revisits are
// cached rows. Everything on screen is real content and the seam is always
// transcript[top-1] | screen[top] -- adjacent by construction.
const ltActive = computed(() => sbCoarse && smoothTouchScrolling.value && props.ctl.mouseMode.value)
// Distance from the bottom that still counts as the live gap. An empty
// .sb-body keeps a few pixels of CSS padding, so a 2px slop would treat
// rest as "into history" and drop taps on the transparent gap.
const sbRestPx = 8
let sbFetchedAt = 0
let sbWant = 800

const ltSpacer = ref<HTMLElement | null>(null)
const ltDoc = ref<HTMLElement | null>(null)
const ltAbove = ref<HTMLElement | null>(null)
const ltSlot = ref<HTMLElement | null>(null)
const ltBelow = ref<HTMLElement | null>(null)
const ltNodes = new Map<number, HTMLElement>()
let ltAppOff = 0        // app scrollback depth, derived from the transcript
let ltSentOff = 0       // scroll lines in flight (sent, not yet acked)
let ltPrefetchAt = 0
let ltLastTop = -1      // last scrollTop, for delta->app scroll tracking
let ltEdgeAcc = 0       // pending app-scroll lines (fractional)
let ltScreenDy = 0      // transform currently applied to the screen element
let ltTouchY = -1       // last finger Y, for pull-past-top forwarding
let ltSamples: { t: number, y: number }[] = []  // trailing touch samples -> release velocity
let ltTopSeen = NaN     // last transcript window top seen (NaN = none yet; -5 is a real index)
let ltLastMoveAt = 0    // last real view movement or app scroll send, for tap checks
let ltTouchStartTop = -1  // scrollTop at touchstart — view moved mid-touch = momentum-stop
let ltTouchPrevMove = 0   // ltLastMoveAt at touchstart — view moving at touch = momentum-stop
let ltDragging = false  // finger is on the scroller
let ltSettling = false  // settle-glide in progress: not a user scroll
let ltSettleTimer: ReturnType<typeof setTimeout> | undefined
function ltRow(idx: number, h: number) {
  const e = props.ctl.transcriptAt(idx)
  const div = document.createElement('div') as HTMLElement & { _h?: string, _t?: string }
  div.className = 'lt-line'
  div.dataset.li = String(idx)
  div.style.height = `${h}px`
  div.style.lineHeight = `${h}px`
  div._h = e?.html; div._t = e?.text || ' '
  if (e?.html != null) div.innerHTML = e.html
  else div.textContent = div._t
  ltNodes.set(idx, div)
  return div
}
function ltResetDom() {
  ltNodes.clear()
  ltAppOff = ltSentOff = ltEdgeAcc = 0; ltLastTop = -1; ltTouchY = -1
  ltScreenDy = 0; ltTopSeen = NaN; ltSettling = false; ltSamples = []
  const screen = host.value?.querySelector('.xterm-screen') as HTMLElement | null
  if (screen) screen.style.transform = ''
  ltAbove.value?.replaceChildren()
  ltBelow.value?.replaceChildren()
}
// Reconcile one side's children into ascending rows for [lo..hi]. Indices
// enter only at the range edges and rows cross the window boundary as
// contiguous runs, so the merge is O(children) edge work per frame. Rows
// render even without content (placeholders keep positions dense; the
// repaint pass fills them when the row actually lands in the cache).
function ltSyncSide(c: HTMLElement, lo: number, hi: number, h: number) {
  const kids = c.children
  let ki = 0
  for (let i = lo; i <= hi; i++) {
    while (ki < kids.length) {
      const k = kids[ki] as HTMLElement
      const kk = Number(k.dataset.li)
      if (kk >= i) break
      ltNodes.delete(kk); k.remove()
    }
    const k = kids[ki] as HTMLElement | undefined
    if (k && Number(k.dataset.li) === i) { ki++; continue }
    c.insertBefore(ltRow(i, h), k ?? null)
    ki++
  }
  while (ki < kids.length) {
    const n = kids[ki] as HTMLElement
    ltNodes.delete(Number(n.dataset.li)); n.remove()
  }
}
// Document order (ascending index): spacer, rows older than the window,
// the slot the real screen is translated onto, then the trail of rows
// newer than the window. Every visible pixel is real content.
function syncLT() {
  const el = sbEl.value, doc = ltDoc.value, slot = ltSlot.value
  const A = ltAbove.value, B = ltBelow.value
  if (!el || !doc || !slot || !A || !B) return
  const h = props.ctl.rowHeight()
  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < h * 2
  const w = props.ctl.transcriptWindow()
  const [mn, mx] = props.ctl.transcriptRange()
  if (w.top !== ltTopSeen) {
    // Depth below live = accumulated window movement, not the cached range:
    // eviction lowers mx and would understate how far the pane still has to
    // chase back down.
    if (!Number.isNaN(ltTopSeen)) ltAppOff = Math.max(0, ltAppOff + ltTopSeen - w.top)
    ltTopSeen = w.top
  }
  // Anchor: the transcript index under the view top, kept across the
  // reconcile so content shifts don't move what the user is reading.
  const spH0 = ltSpacer.value?.offsetHeight ?? 0
  const aFirst0 = A.firstElementChild ? Number((A.firstElementChild as HTMLElement).dataset.li) : w.top
  const bFirst0 = B.firstElementChild ? Number((B.firstElementChild as HTMLElement).dataset.li) : w.top + w.rows
  const slotH0 = w.rows * h
  const y0 = el.scrollTop - spH0
  let aIdx = Infinity, aFrac = 0
  if (y0 >= 0) {
    const aH0 = A.childElementCount * h
    if (y0 < aH0) { aIdx = aFirst0 + y0 / h; aFrac = aIdx % 1; aIdx = Math.floor(aIdx) }
    else if (y0 < aH0 + slotH0) { aIdx = w.top; aFrac = (y0 - aH0) / h }
    else { const p = (y0 - aH0 - slotH0) / h; aIdx = bFirst0 + Math.floor(p); aFrac = p % 1 }
  }
  ltSyncSide(A, mn, w.top - 1, h)
  ltSyncSide(B, w.top + w.rows, mx, h)
  slot.style.height = `${w.rows * h}px`
  // In-place repaints refresh rows in the document -- the compare is a
  // string-identity check against what was rendered.
  for (const [i, n] of ltNodes) {
    const e = props.ctl.transcriptAt(i)
    const nn = n as HTMLElement & { _h?: string, _t?: string }
    const nh = e?.html, nt = e?.text || ' '
    if (nh !== nn._h || nt !== nn._t) {
      nn._h = nh; nn._t = nt
      if (nh != null) n.innerHTML = nh
      else n.textContent = nt
    }
  }
  // Cold-start pull room: keep at least a viewport of virtual runway above
  // so the first upward drag has somewhere native to go; ltRunway extends it
  // further while the app keeps yielding ground.
  const sp = ltSpacer.value
  if (sp && sp.offsetHeight < el.clientHeight) sp.style.height = `${el.clientHeight}px`
  if (!doc.style.paddingLeft) ltApplyMetrics()
  if (wasAtBottom && ltAppOff <= 0) el.scrollTop = el.scrollHeight
  else if (aIdx !== Infinity) {
    // Re-map the anchor index into the post-sync layout.
    const spH = sp?.offsetHeight ?? 0
    const aH = A.childElementCount * h
    const i = Math.max(mn, Math.min(mx, aIdx))
    const top = w.top
    const rows = w.rows
    const y = i < top
      ? (i - mn) * h
      : i < top + rows ? aH + (i - top) * h : aH + rows * h + (i - (top + rows)) * h
    el.scrollTop = spH + y + aFrac * h
  }
  // The scroll event from the write above must not feed delta sends.
  ltLastTop = el.scrollTop
  // A chase deeper than one page still has distance after the covering
  // frames land: keep walking the app down while the view rests at the edge.
  if (wasAtBottom && ltAppOff + ltSentOff > 0 && performance.now() - ltPrefetchAt > 90) {
    ltPrefetchAt = performance.now()
    const send = -Math.min(ltAppOff + ltSentOff, props.ctl.pageRows())
    ltSentOff += send
    ltScrollSend(send)
  }
  ltTrack()
}
// Scrolls the app the same way a finger drag does -- positioned, paced.
function ltScrollSend(lines: number) {
  const screen = host.value?.querySelector('.xterm-screen')
  if (!screen) return
  // A send moves the pane under the pointer just like a view move does — a
  // tap right after a pull pinned at the clamp must not forward stale
  // coordinates, so sends feed the same recency clock as real movement.
  ltLastMoveAt = performance.now()
  const r = screen.getBoundingClientRect()
  // ctl.scroll maps x/y against the untranslated rect: give it that frame.
  props.ctl.scroll(lines, r.left + r.width / 2, r.top - ltScreenDy + r.height / 2, 0, true, true)
}
// The screen element is translated onto the transcript slot: wherever the
// live window sits in the document, the real canvas is exactly there.
function ltTrack() {
  const el = sbEl.value, slot = ltSlot.value
  const screen = host.value?.querySelector('.xterm-screen') as HTMLElement | null
  if (!el || !slot || !screen) return
  const elR = el.getBoundingClientRect()
  const target = elR.top + slot.offsetTop - el.scrollTop
  const untransformed = screen.getBoundingClientRect().top - ltScreenDy
  ltScreenDy = target - untransformed
  screen.style.transform = ltScreenDy ? `translate3d(0, ${ltScreenDy}px, 0)` : ''
}
// Scroll deltas become app scroll deltas only while the view sits above the
// live slot: pulling into the spacer drives the app up, pushing back down
// chases it toward live. The trail below the slot is pure cached browsing.
// The spacer is a fixed gesture runway: a finger may show ~3 rows of it, and
// released momentum may roam until it has thrown a page of scrolls — then it
// pins too, so a flick can never keep the pane scrolling on its own. At the
// document bottom a chase pulls the app to live.
function ltOnScroll() {
  const el = sbEl.value, slot = ltSlot.value, sp = ltSpacer.value
  if (!el || !slot || !sp) return
  ltTrack()
  const h = props.ctl.rowHeight()
  const now = performance.now()
  // The spacer is gesture runway, never visible content: the view may show
  // at most ~3 rows of it, always. Released momentum pins at the same wall —
  // its energy is thrown as a bounded app scroll on release instead, so a
  // flick can never park the viewport in black space.
  const clampTop = Math.max(0, sp.offsetHeight - 3 * h)
  if (el.scrollTop < clampTop) { el.scrollTop = clampTop; ltLastTop = clampTop }
  if (ltLastTop < 0) ltLastTop = el.scrollTop
  const dy = el.scrollTop - ltLastTop
  ltLastTop = el.scrollTop
  // Real view movement (not the settle glide, not a pinned no-op) is what a
  // later tap check reads to recognize a momentum-stop.
  if (dy && !ltSettling) ltLastMoveAt = now
  if (el.scrollTop >= sp.offsetHeight) ltSettling = false
  if (el.scrollTop < sp.offsetHeight) {
    if (ltSettling) { ltEdgeAcc = 0; return }
    ltEdgeAcc -= dy / h
    const lines = Math.trunc(ltEdgeAcc)
    // Suppressed lines stay pending: deducting before the gate drops the
    // distance a fast drag covered inside a closed interval.
    if (lines && now - ltPrefetchAt > 60) {
      ltEdgeAcc -= lines
      ltPrefetchAt = now
      ltSentOff += lines
      ltScrollSend(lines)
    }
  } else ltEdgeAcc = 0
  const bot = el.scrollHeight - el.scrollTop - el.clientHeight
  if (bot < h && ltAppOff + ltSentOff > 0 && now - ltPrefetchAt > 90) {
    ltPrefetchAt = now
    const send = -Math.min(ltAppOff + ltSentOff, props.ctl.pageRows())
    ltSentOff += send
    ltScrollSend(send)
  }
  // Approaching the top of what we have: pull more history into the doc.
  if (el.scrollTop < el.clientHeight) ltPrefetch()
  // Momentum can rest a few rows inside blank spacer: once scrolling goes
  // quiet with no finger down, spring back to the content edge — a short
  // ~3-row release, never a long glide to the slot.
  clearTimeout(ltSettleTimer)
  ltSettleTimer = setTimeout(() => {
    if (ltDragging || !sbEl.value || !ltSpacer.value) return
    const e = sbEl.value, s = ltSpacer.value
    if (e.scrollTop < s.offsetHeight) {
      ltSettling = true
      ltLastTop = s.offsetHeight
      e.scrollTo({ top: s.offsetHeight, behavior: 'smooth' })
    }
  }, 180)
}
// Pulling down against the document top asks the app for older content:
// the scrollTop is pinned, so finger deltas become the scroll sends and the
// screen repaints inside the slot = the frontier itself.
// Trailing ~120ms of finger movement -> px/ms; positive = finger moving
// down = the pull that asks the app for earlier content.
function ltVelocity() {
  const now = performance.now()
  const s = ltSamples.filter(s => now - s.t < 120)
  if (s.length < 2) return 0
  return (s[s.length - 1]!.y - s[0]!.y) / Math.max(1, s[s.length - 1]!.t - s[0]!.t)
}
function onSbTouchMove(e: TouchEvent) {
  if (!ltActive.value) return
  const el = sbEl.value, t = e.touches[0]
  if (!el || !t) return
  ltSamples.push({ t: performance.now(), y: t.clientY })
  if (ltSamples.length > 12) ltSamples.shift()
  const dyPx = ltTouchY - t.clientY
  ltTouchY = t.clientY
  // The view pins ~3 rows into the spacer while dragging (see ltOnScroll);
  // once pinned, the finger's remaining travel becomes the app scroll.
  const clampTop = Math.max(0, (ltSpacer.value?.offsetHeight ?? 0) - 3 * props.ctl.rowHeight())
  if (el.scrollTop > clampTop + 0.5 || dyPx >= 0) return
  ltEdgeAcc += -dyPx / props.ctl.rowHeight()
  const lines = Math.trunc(ltEdgeAcc)
  const now = performance.now()
  if (lines && now - ltPrefetchAt > 60) {
    ltEdgeAcc -= lines
    ltPrefetchAt = now
    // Read ~180ms ahead of the current velocity: a fast pull asks for more
    // than the finger has covered yet, so the repaint keeps up with it.
    const lead = Math.min(8, Math.trunc(Math.abs(ltVelocity()) * 180 / props.ctl.rowHeight()))
    const send = lines + Math.sign(lines) * lead
    ltSentOff += send
    ltScrollSend(send)
  }
}
function ltApplyMetrics() {
  const el = sbEl.value, doc = ltDoc.value
  const src = host.value?.querySelector('.xterm-screen')
  if (!el || !doc || !src) return
  // Options are the only reliable font source: the DOM renderer keeps them
  // on .xterm-rows, WebGL keeps them off the DOM, and .xterm-screen itself
  // reports the app font.
  const f = props.ctl.termFont?.()
  if (f) Object.assign(el.style, { fontFamily: f.family, fontSize: `${f.size}px`, fontWeight: f.weight, fontStyle: 'normal', letterSpacing: f.letterSpacing, color: f.color || 'inherit' })
  const wrap = el.getBoundingClientRect()
  const sr = src.getBoundingClientRect()
  Object.assign(doc.style, {
    paddingTop: `${Math.max(0, sr.top - wrap.top)}px`,
    paddingLeft: `${Math.max(0, sr.left - wrap.left)}px`,
    paddingRight: `${Math.max(0, wrap.right - sr.right)}px`,
    paddingBottom: '0',
  })
}
// ---- dump prefetch: real history rows merged above the transcript ----
// `recent` (pane-width wrapped) ends with the pane's live screen; line its
// tail up with the transcript's newest painted rows by content, then inject
// everything below the known range. TUI snapshots align inside the window
// and inject nothing; real scrollback extends the document upward, so the
// first upward drag finds real rows instead of waiting on repaints.
let ltDumpWant = 0
let ltDumpAt = 0
function ltTheme16() {
  const t = props.ctl.termTheme()
  return t ? THEME16_NAMES.map(n => (t as Record<string, string | undefined>)[n]) : undefined
}
function ltIngestDump(text: string) {
  if (!text || !ltActive.value) return
  const lines = ansiToLines(text)
  const w = props.ctl.transcriptWindow()
  const [mn, mx] = props.ctl.transcriptRange()
  if (!(mx >= mn) || lines.length < w.rows) return
  const k = w.rows
  const texts = lines.map(l => l.map(s => s.text).join('').trimEnd())
  let best = NaN, bestScore = 0
  for (let a = Math.max(mn, mx - lines.length); a <= mx - k + 1; a++) {
    let s = 0
    for (let j = 0; j < k; j++) {
      const e = props.ctl.transcriptAt(a + j)
      if (e && e.text.trimEnd() === texts[lines.length - k + j]!) s++
    }
    if (s > bestScore) { bestScore = s; best = a }
  }
  // Scrolled-up transcripts sit at negative indices -- a valid alignment can
  // be -5, so not-found has to be a separate signal from the index itself.
  if (Number.isNaN(best) || bestScore < Math.ceil(k * 0.6)) return
  const base = best - (lines.length - k)
  const theme = ltTheme16()
  for (let j = 0; j < lines.length && base + j < mn; j++) {
    props.ctl.transcriptInject(base + j, { t: texts[j]!, h: ansiSpansToHtml(lines[j]!, theme) })
  }
  syncLT()
}
// Ask for the wrapped history once when the document is short, and again
// whenever the user scrolls near the top with a wider window available.
function ltPrefetch() {
  if (!ltActive.value || Date.now() - ltDumpAt < 2500) return
  ltDumpAt = Date.now()
  ltDumpWant = Math.min(4000, Math.max(1500, ltDumpWant * 2))
  props.ctl.requestScrollback(ltDumpWant, 'recent')
}
watch(props.ctl.scrollbackVersion, () => { if (ltActive.value) ltIngestDump(props.ctl.scrollback.value) })
// Taps on the live slot are taps on the real screen -- it is translated
// exactly under the pointer, so raw coordinates forward as-is.
function onSlotTap(e: MouseEvent) {
  // Same order-sensitive contract as tapGap: a momentum-stop click forwards
  // nothing, a link opens quietly, a deliberate click forwards + focuses.
  if (performance.now() - ltLastMoveAt <= 400) { props.ctl.blur(); return }
  if (!props.ctl.tapLink(e.clientX, e.clientY)) {
    props.ctl.tapMouse(e.clientX, e.clientY)
    props.ctl.focus()
  } else {
    props.ctl.blur()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
  }
}
watch(ltActive, on => {
  ltResetDom()
  renderPreview(0)
  ltDumpWant = 0
  if (on) nextTick(() => {
    ltApplyMetrics(); syncLT()
    const el = sbEl.value
    if (el) el.scrollTop = el.scrollHeight
    ltPrefetch()
  })
})
function renderScrollback() {
  if (ltActive.value) return
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
  if (ltActive.value) { syncLT(); return }
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
  if (ltActive.value) { ltOnScroll(); return }
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
watch(props.ctl.scrollInputVersion, () => {
  ltApplyMetrics()
  if (sbEl.value) sbEl.value.scrollTop = sbEl.value.scrollHeight
})
// Coarse-pointer: #scrollback sits above #touch with pointer-events auto,
// so a rest-state tap never reaches onTouchEnd. Stationary touchend on the
// gap is the same path as a tap on #touch; a drag keeps native momentum.
let sbAX = 0, sbAY = 0
let sbTouchSent = false
function tapGap(x: number, y: number) {
  const el = sbEl.value
  // Only taps at the very bottom reach the pane; taps on history do nothing.
  // In live-transcript mode the slot is the live pane wherever it is.
  if (!ltActive.value && el && el.scrollHeight - el.scrollTop - el.clientHeight > sbRestPx) return false
  // The tap contract from the predictive path, order-sensitive. A tap that
  // merely stopped momentum forwards NOTHING (no click could reset the
  // pane's view): the view was already moving when the finger landed, or it
  // moved during the touch. A link opens without the keyboard, and an
  // ordinary deliberate tap forwards the click and focuses for typing.
  if (ltActive.value && el) {
    const movedView = ltTouchStartTop >= 0 && Math.abs(el.scrollTop - ltTouchStartTop) > 2
    const wasScrolling = ltTouchPrevMove > 0 && performance.now() - ltTouchPrevMove < 400
    if (movedView || wasScrolling) { props.ctl.blur(); return true }
  }
  const link = props.ctl.tapLink(x, y)
  if (link || !ltActive.value) {
    if (!link) props.ctl.tapMouse(x, y)
    props.ctl.blur()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    return true
  }
  props.ctl.tapMouse(x, y)
  props.ctl.focus()
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
  ltTouchY = sbAY
  ltSamples = [{ t: performance.now(), y: sbAY }]
  ltTouchStartTop = sbEl.value?.scrollTop ?? -1
  ltTouchPrevMove = ltLastMoveAt
  ltDragging = true
  ltSettling = false
}
function onSbTouchEnd(e: TouchEvent) {
  ltTouchY = -1
  ltDragging = false
  if (ltActive.value) {
    // Release with throttle-suppressed rows still pending: dispatch the tail
    // so the gesture's full distance reaches the pane.
    const lines = Math.trunc(ltEdgeAcc)
    if (lines) { ltEdgeAcc -= lines; ltSentOff += lines; ltScrollSend(lines) }
    // A released pull has nowhere to roam — the spacer is pinned — so the
    // fling's leftover velocity becomes one bounded app scroll: the pane
    // keeps moving (~the flick's worth, capped at two pages) while the view
    // stays on the content edge.
    const el = sbEl.value, sp = ltSpacer.value
    const v = ltVelocity()
    if (el && sp && v > 0.15) {
      const h = props.ctl.rowHeight()
      const clampTop = Math.max(0, sp.offsetHeight - 3 * h)
      if (el.scrollTop <= clampTop + h) {
        const lines = Math.min(2 * props.ctl.pageRows(), Math.trunc(v * 150 / h))
        if (lines > 0) { ltSentOff += lines; ltScrollSend(lines) }
      }
    }
  }
  ltSamples = []
  const t = e.changedTouches[0]
  if (!t || Math.hypot(t.clientX - sbAX, t.clientY - sbAY) > 10) return
  // History rows sit in .sb-body; only the transparent gap/slot is live.
  if (!(e.target as HTMLElement | null)?.closest?.('.sb-gap, .lt-slot')) return
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
    <!-- Scrollback surfaces. Old Herdr panes show a static dump over a live
         gap; mouse-capable panes get the live transcript: a DOM document of
         every painted row, scrolled natively, with server scrolls only
         prefetching at the edges (ltActive). -->
    <div
      id="scrollback" ref="sbEl"
      :style="{ pointerEvents: (sbInteractive || ltActive) ? 'auto' : 'none', visibility: (sbInteractive || ltActive) ? 'visible' : 'hidden' }"
      @scroll.passive="onSbScroll"
      @touchstart.passive="onSbTouchStart"
      @touchmove.passive="onSbTouchMove"
      @touchend="onSbTouchEnd"
    >
      <div ref="ltSpacer" v-show="ltActive" class="lt-spacer" />
      <div ref="sbBody" v-show="!ltActive" class="sb-body" />
      <!-- In live-transcript mode the document is real transcript rows
           around a transparent slot the REAL screen is translated onto. -->
      <div v-if="ltActive" ref="ltDoc" class="lt-doc">
        <div ref="ltAbove" class="lt-lines" />
        <div ref="ltSlot" class="lt-slot" @click="onSlotTap" />
        <div ref="ltBelow" class="lt-lines" />
      </div>
      <div v-else class="sb-gap" @click="onGapTap" />
    </div>
    <div v-if="ctl.loading.value" class="term-loading"><span class="spinner" /></div>
    <div v-if="ctl.selectionHint.visible.value" class="terminal-selection-hint">
      {{ tl('Shift + drag to select', 'Shift + glisser pour sélectionner') }}
      <button type="button" :aria-label="t('Hide')" @click="ctl.selectionHint.dismiss()">×</button>
    </div>
  </div>
</template>
