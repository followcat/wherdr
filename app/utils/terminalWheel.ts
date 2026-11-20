// Wheel and drag in the terminal -> rows for xterm's local viewport.
// xterm.js only sees the attach's raw stream (never the application's mouse
// modes): left to itself, it converts the wheel into ↑/↓ ("alternate
// scroll") and Claude Code browses its message history. The attach already
// delivered the history, so the wheel scrolls the buffer locally.

// WheelEvent.deltaMode : 0 = pixels, 1 = lignes (Firefox), 2 = pages.
export function wheelPixels(deltaY: number, deltaMode: number, rowHeight: number, pageRows: number): number {
  if (deltaMode === 1) return deltaY * rowHeight
  if (deltaMode === 2) return deltaY * rowHeight * Math.max(1, pageRows)
  return deltaY
}

// Accumulated movement in pixels (positive = towards the top of the history) ->
// whole lines to scroll and remainder kept for the next event.
export function takeLines(acc: number, rowHeight: number): { lines: number, rest: number } {
  const h = rowHeight > 0 ? rowHeight : 16
  const lines = Math.trunc(acc / h)
  return { lines, rest: acc - lines * h }
}

// Touch motion follows the finger through a real local viewport. Round to the
// nearest row for earlier feedback, carrying the signed error into subsequent
// samples and momentum so a small drag does not wait for an entire row.
export function takeTouchLines(acc: number, rowHeight: number, previousDirection = 0): { lines: number, rest: number } {
  const h = rowHeight > 0 ? rowHeight : 16
  // A half-row lead must not turn one pixel of backtracking into an opposite
  // scroll. Require a whole residual row before reversing direction.
  const reversing = previousDirection !== 0 && Math.sign(acc) !== previousDirection
  const lines = Math.sign(acc) * Math.floor(Math.abs(acc) / h + (reversing ? 0 : .5)) || 0
  return { lines, rest: acc - lines * h }
}

import type { Terminal } from '@xterm/xterm'

// herdr-core: a program that tracks the mouse (Claude Code's fullscreen
// renderer, vim, less --mouse) draws in the alternate screen, which has no
// scrollback for xterm to scroll: like a real terminal, the wheel goes to the
// program as mouse wheel reports, one per line (positive = towards the top).
// `sgr`: the program asked for SGR coordinates (DECSET 1006); otherwise the
// X10 encoding, whose coordinates stop at 223.
export function wheelReports(lines: number, cell: { column: number, row: number }, sgr: boolean, max = 200): string {
  const n = Math.min(Math.abs(Math.trunc(lines)), max)
  if (!n) return ''
  const button = lines > 0 ? 64 : 65
  const x = cell.column + 1, y = cell.row + 1
  const one = sgr
    ? `\x1b[<${button};${x};${y}M`
    : `\x1b[M${String.fromCharCode(32 + button, 32 + Math.min(x, 223), 32 + Math.min(y, 223))}`
  return one.repeat(n)
}

// Claude Code's fullscreen view accelerates wheel reports that arrive less
// than 40 ms apart (each one moves 0.3 row more, up to 6 rows) and moves one
// row again after a 40 ms pause; the first report after a reversal moves
// nothing. One report per pixel row, sent in a burst,
// made a fast trackpad scroll fly 6 to 20 times further than the fingers.
const ACCEL_GAP = 40, ACCEL_STEP = 0.3, ACCEL_MAX = 6

// Reports to send for `lines` rows given the program's current multiplier
// (0: rested, the next report moves one row). Never more rows than asked,
// except the first report when the multiplier is already above `lines`.
export function wheelPlan(lines: number, mult: number): { reports: number, rows: number, mult: number } {
  let reports = 0, rows = 0, m = mult
  while (rows < lines) {
    const next = m ? Math.min(ACCEL_MAX, m + ACCEL_STEP) : 1
    if (reports && rows + Math.floor(next) > lines) break
    m = next
    rows += Math.floor(m)
    reports++
  }
  return { reports, rows, mult: m }
}

export interface WheelPacer { push: (lines: number) => void, frame: () => void, cancel: () => void }

// Paces wheel reports to a program tracking the mouse: rows add up while a
// burst waits for its repaint (one burst in flight, never a queue behind a
// busy program) and at most a page is kept. A burst with no repaint within
// `wait` (a stalled program, or an edge with nothing to redraw) sends nothing
// more in that direction until the program paints again, so a stall never
// collects bursts that land at once afterwards. With `accel` (Claude Code),
// rows become reports through its acceleration; otherwise one report per row.
export function createWheelPacer(o: {
  send: (reports: number) => boolean
  page: () => number
  accel?: () => boolean
  now?: () => number
  wait?: number
}): WheelPacer {
  const now = o.now ?? (() => performance.now())
  const wait = o.wait ?? 200
  let pending = 0, mult = 0, sentAt = -Infinity, inFlight = false, stalled = false, dir = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const later = (ms: number) => { clearTimeout(timer); timer = setTimeout(flush, Math.max(0, ms)) }
  function flush() {
    timer = undefined
    const t = now()
    if (inFlight && t - sentAt >= wait) { inFlight = false; stalled = true; pending = 0 }
    if (!pending || stalled) return
    if (inFlight) return later(sentAt + wait - t)
    const sign = Math.sign(pending)
    const accel = o.accel?.() ?? false
    const flip = accel && dir !== 0 && sign !== dir
    const rested = flip || t - sentAt > ACCEL_GAP
    const plan = accel ? wheelPlan(Math.abs(pending), rested ? 0 : mult) : { reports: Math.abs(pending), rows: Math.abs(pending), mult: 0 }
    // Less than one accelerated report left: sent one row at a time after the pause.
    if (!rested && plan.rows > Math.abs(pending)) return later(sentAt + ACCEL_GAP + 1 - t)
    if (!o.send(sign * (plan.reports + (flip ? 1 : 0)))) { pending = 0; return }
    pending -= sign * plan.rows
    mult = plan.mult
    sentAt = t
    dir = sign
    inFlight = true
    later(wait)
  }
  return {
    push(lines) {
      if (!lines) return
      // A reversal drops what the other direction still had to do, and may leave an edge.
      if (dir && Math.sign(lines) !== dir) { pending = 0; inFlight = false; stalled = false }
      else if (pending && Math.sign(lines) !== Math.sign(pending)) pending = 0
      if (stalled) return
      const max = Math.max(1, o.page())
      pending = Math.max(-max, Math.min(max, pending + lines))
      flush()
    },
    frame() {
      stalled = false
      if (!inFlight) return
      inFlight = false
      flush()
    },
    cancel() { clearTimeout(timer); timer = undefined; pending = 0; inFlight = stalled = false; mult = 0; dir = 0 },
  }
}

export interface SgrMouse { on: () => boolean, reset: () => void }

// xterm tracks the mouse modes but does not expose the encoding: follow
// DECSET/DECRST 1006 in stream order. xterm drops the encoding on RIS (ESC c)
// and on term.reset(): the caller calls reset() right after its own resets.
export function trackSgrMouse(term: Pick<Terminal, 'parser'>): SgrMouse {
  let sgr = false
  const mode = (on: boolean) => (params: (number | number[])[]) => {
    if (params.includes(1006)) sgr = on
    return false
  }
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, mode(true))
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, mode(false))
  term.parser.registerEscHandler({ final: 'c' }, () => { sgr = false; return false })
  return { on: () => sgr, reset: () => { sgr = false } }
}
