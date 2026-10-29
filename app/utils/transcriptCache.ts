// A per-attach cache of the rows the terminal has already painted, indexed
// by position in the pane's "transcript" -- the linear content a program
// scrolls through. It lets the touch preview fill the edge it reveals with
// real lines instead of void, so the predictive offset can track the finger
// far past the rows the network could repaint in time.
//
// Indices are relative -- only deltas matter. Each frame realigns against
// the previous screen by best-match shift, which self-corrects at scroll
// edges where the program clamps the view and survives in-place repaints
// (spinners, streaming output) that shift nothing.
export function createTranscriptCache() {
  const known = new Map<number, { t: string, h?: string }>()
  // Rows injected from a scrollback dump (prefetched history): they live
  // outside the frame-pruned window until the app repaints over them.
  const injected = new Map<number, { t: string, h?: string }>()
  let top = 0               // transcript index of screen row 0
  let prev: string[] = []   // last stored screen rows
  let prevPrev: string[] = [] // screen before prev: re-scores the last shift
  let rows = 24
  const RANGE = 40        // max shift searched per frame
  const KEEP = 400        // rows retained either side of the viewport
  // Ground truth for the previous frame's shift: the server's scroll.ack
  // trails its covering frame on the wire, so every acked line since the
  // last frame() call describes that frame's requested movement. Text
  // matching alone misanchors on repetitive screens (identical rows score
  // a wrong shift as well as the true one). The ack is a *request*, not an
  // applied delta — the pane clamps at its edges — so it only arbitrates
  // ties: the delivered shift wins when it matches the screen at least as
  // well as the shift the matcher picked.
  let pendingAck = 0
  let sawAck = false
  let lastDelta = 0
  let lastTop = 0         // where the last frame's rows were stored

  const scoreShift = (next: string[], prior: string[], d: number) => {
    let s = 0
    for (let i = 0; i < next.length; i++) {
      const j = i - d
      if (j >= 0 && j < prior.length && next[i] === prior[j]!) s++
    }
    return s
  }

  // text rows realign the window; html rows (same indices) paint the strips.
  // `hint` = scroll lines the client sent since the last frame. It only sets
  // how much evidence a shift needs: TUI panes redraw in place constantly
  // (a status list sliding internally looks identical to a scroll on
  // periodic content), so send-free frames must clear a high bar before any
  // nonzero delta is believed. The hint never picks the delta itself —
  // sends are inflated whenever the pane clamps.
  function frame(screen: string[], styled?: string[], hint?: number) {
    // Re-anchor the previous frame before matching this one. Every cached
    // index was minted under an anchor chain containing a mistaken step, so
    // a correction remaps ALL of them — including the rows the last frame
    // stored at wrong positions. Scores are normalized by coverable rows (a
    // shifted window cannot match the rows that entered). The ack counts
    // *requested* lines — at a clamp the pane does not move, so it only ever
    // overstates: trust it when it explains the transition strictly better,
    // or — on a periodic-content tie — when it asks for less than the match
    // did. And if the two screens were identical, no acked shift happened at
    // all: the pending count is pure clamp inflation.
    const fit = (d: number) => {
      const coverable = prev.length - Math.abs(d)
      return coverable > 0 ? scoreShift(prev, prevPrev, d) / coverable : 0
    }
    if (sawAck && prevPrev.length === prev.length && pendingAck !== lastDelta) {
      const stationary = scoreShift(prev, prevPrev, 0) === prev.length
      const fAck = fit(pendingAck), fLast = fit(lastDelta)
      const better = fAck > fLast + 0.05
      const humbler = fAck > fLast - 0.05 && Math.abs(pendingAck) < Math.abs(lastDelta)
      if (!stationary && (better || humbler)) {
        const shift = pendingAck - lastDelta
        for (const map of [known, injected]) {
          const entries = [...map]
          map.clear()
          for (const [k, v] of entries) map.set(k - shift, v)
        }
        top -= shift
        lastTop -= shift
      }
    }
    pendingAck = 0; sawAck = false
    rows = screen.length
    let delta = 0
    if (prev.length === screen.length && scoreShift(screen, prev, 0) < prev.length) {
      // A screen identical to its predecessor means the pane visibly did not
      // move — any pending send was clamped at a history edge, so delta MUST
      // stay 0 regardless of requested lines.
      // Otherwise: candidates must beat the "in place" hypothesis — a real
      // scroll keeps its unchanged middle band, which inflates f0. Without a
      // pending send the prior is "repaint", so the bar is much higher.
      // Among winners take the smallest |d|: sends are only ever inflated by
      // clamping, so under-anchoring is safe while over-anchoring mints
      // phantom history.
      const coverable = (d: number) => prev.length - Math.abs(d)
      const f0 = scoreShift(screen, prev, 0) / prev.length
      const margin = hint ? 0.02 : 0.15
      let dist = Infinity
      for (let d = -RANGE; d <= RANGE; d++) {
        if (scoreShift(screen, prev, d) / coverable(d) > f0 + margin && Math.abs(d) < dist) { dist = Math.abs(d); delta = d }
      }
    }
    top -= delta
    lastDelta = delta
    for (let i = 0; i < screen.length; i++) known.set(top + i, { t: screen[i]!, h: styled?.[i] })
    lastTop = top
    prevPrev = prev
    prev = screen
    for (const k of known.keys()) if (k < top - KEEP || k > top + rows + KEEP) known.delete(k)
  }

  // scroll.ack lines: positive = the pane was asked up by that many rows.
  function ack(lines: number) { pendingAck += lines; sawAck = true }

  // Contiguous cached rows available in a reveal direction:
  // dir > 0 reveals rows above the top (older), dir < 0 below the bottom.
  function available(dir: number): number {
    let n = 0
    if (dir > 0) while (known.has(top - 1 - n)) n++
    else while (known.has(top + rows + n)) n++
    return n
  }

  // The rows a reveal would show, oldest first for dir > 0 (so index 0 sits
  // furthest from the live screen edge). Each entry is { text, html? }.
  function slice(dir: number, count: number): ({ text: string, html?: string } | null)[] {
    const out: ({ text: string, html?: string } | null)[] = []
    const get = (idx: number) => { const e = known.get(idx); return e ? { text: e.t, html: e.h } : null }
    if (dir > 0) for (let i = count; i >= 1; i--) out.push(get(top - i))
    else for (let i = 0; i < count; i++) out.push(get(top + rows + i))
    return out
  }

  function reset() { known.clear(); injected.clear(); top = 0; prev = []; prevPrev = []; pendingAck = 0; sawAck = false; lastDelta = 0; lastTop = 0 }

  // Prefetched history (a scrollback dump mapped into index space). Painted
  // frames always win when they arrive at the same index.
  function inject(idx: number, e: { t: string, h?: string }) {
    if (!known.has(idx)) injected.set(idx, e)
  }

  // Document-model accessors for the live transcript scroller: the dense
  // envelope around the window. A detached island (a dump tail far below the
  // painted region after streaming evicts the overlap) must not open a hole
  // of placeholder rows in the document, so the range only grows through
  // indices that actually connect.
  function range(): [number, number] {
    let mn = top, mx = top + rows - 1
    while (known.has(mn - 1) || injected.has(mn - 1)) mn--
    while (known.has(mx + 1) || injected.has(mx + 1)) mx++
    return [mn, mx]
  }
  function at(idx: number) { const e = known.get(idx) ?? injected.get(idx); return e ? { text: e.t, html: e.h } : null }
  function has(idx: number) { return known.has(idx) || injected.has(idx) }
  function windowTop() { return top }
  function windowRows() { return rows }
  return { frame, ack, available, slice, reset, inject, range, at, has, windowTop, windowRows }
}
