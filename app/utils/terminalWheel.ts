// Wheel and drag in the terminal -> terminal.scroll lines for Herdr.
// xterm.js only sees the frames redrawn by Herdr (never the application's
// mouse modes): left to itself, it converts the wheel into ↑/↓ ("alternate
// scroll") and Claude Code browses its message history. Herdr, for its part,
// knows the real mode: it scrolls the pane's history, or passes the
// wheel on as mouse events if the application tracks the mouse.

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

// Touch motion has no local pixel viewport to follow. Round to the nearest
// row for earlier feedback, carrying the signed error into subsequent samples
// and momentum so a small drag does not wait for an entire row to accumulate.
export function takeTouchLines(acc: number, rowHeight: number, previousDirection = 0): { lines: number, rest: number } {
  const h = rowHeight > 0 ? rowHeight : 16
  // A half-row lead must not turn one pixel of backtracking into an opposite
  // wheel event. Require a whole residual row before reversing direction.
  const reversing = previousDirection !== 0 && Math.sign(acc) !== previousDirection
  const lines = Math.sign(acc) * Math.floor(Math.abs(acc) / h + (reversing ? 0 : .5)) || 0
  return { lines, rest: acc - lines * h }
}
