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
  let top = 0             // transcript index of screen row 0
  let prev: string[] = [] // last stored screen rows
  let rows = 24
  const RANGE = 40        // max shift searched per frame
  const KEEP = 400        // rows retained either side of the viewport

  // text rows realign the window; html rows (same indices) paint the strips.
  function frame(screen: string[], styled?: string[]) {
    rows = screen.length
    let delta = 0
    if (prev.length === screen.length) {
      // new[i] == prev[i - d] when the view scrolled up by d (older content).
      let best = -1
      for (let d = -RANGE; d <= RANGE; d++) {
        let score = 0
        for (let i = 0; i < screen.length; i++) {
          const j = i - d
          if (j >= 0 && j < prev.length && screen[i] === prev[j]!) score++
        }
        if (score > best || (score === best && Math.abs(d) < Math.abs(delta))) { best = score; delta = d }
      }
      // An unrelated repaint must not drift the transcript anchor.
      if (best < screen.length * 0.3) delta = 0
    }
    top -= delta
    for (let i = 0; i < screen.length; i++) known.set(top + i, { t: screen[i]!, h: styled?.[i] })
    prev = screen
    for (const k of known.keys()) if (k < top - KEEP || k > top + rows + KEEP) known.delete(k)
  }

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

  function reset() { known.clear(); injected.clear(); top = 0; prev = [] }

  // Prefetched history (a scrollback dump mapped into index space). Painted
  // frames always win when they arrive at the same index.
  function inject(idx: number, e: { t: string, h?: string }) {
    if (!known.has(idx)) injected.set(idx, e)
  }

  // Document-model accessors for the live transcript scroller: the whole
  // known range rendered in index order.
  function range(): [number, number] {
    let mn = Infinity, mx = -Infinity
    for (const k of known.keys()) { if (k < mn) mn = k; if (k > mx) mx = k }
    for (const k of injected.keys()) { if (k < mn) mn = k; if (k > mx) mx = k }
    return [mn, mx]
  }
  function at(idx: number) { const e = known.get(idx) ?? injected.get(idx); return e ? { text: e.t, html: e.h } : null }
  function has(idx: number) { return known.has(idx) || injected.has(idx) }
  function windowTop() { return top }
  function windowRows() { return rows }
  return { frame, available, slice, reset, inject, range, at, has, windowTop, windowRows }
}
