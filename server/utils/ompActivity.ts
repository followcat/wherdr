// omp's activity while it works, read from the screen enrich reads for its gauge:
//
//   ⎋ Sleeping first time                              Run sleep commands     step · session title
//  ⠹ 5s > ◔ Opus 5.5 > 📁 ~/demo > S0.01 ▶─1%──────────────────────────      spinner, elapsed
//
// The step is the label ("intent") of the running tool; "⎋" (Esc interrupts,
// another glyph per symbol preset, see shared/ompSymbols.ts) or the spinner
// leads it, the session title is right-aligned after a wide gap. Before the
// first tool, omp shows a generic "Working…": no step then. The status line
// opens with the spinner and the turn's elapsed time; older layouts put the
// status line under the input field, without a timer.
import type { OmpActivity as OmpActivityState } from '../../shared/types'
import { OMP_ASCII_SPINNER, OMP_ESC, OMP_SPINNER, ompAlt } from '../../shared/ompSymbols'

export interface OmpActivity { step: string | null, elapsed: number | null }

const ESC = ompAlt(OMP_ESC)
const STEP_RE = new RegExp(`^ {0,3}(?:${ESC}|[${OMP_SPINNER}]) +(\\S.*?)(?: {3,}\\S.*)?$`)
// ascii spinner ("- Reading"): only below a status line timer, a markdown bullet otherwise.
const ASCII_STEP_RE = new RegExp(`^ {0,3}[${OMP_ASCII_SPINNER}] +(\\S.*?)(?: {3,}\\S.*)?$`)
const ELAPSED_RE = new RegExp(`^ {0,3}(?:[${OMP_SPINNER}] +((?:\\d+h ?)?(?:\\d+m ?)?\\d+s)(?: +>|$)|[${OMP_ASCII_SPINNER}] +((?:\\d+h ?)?(?:\\d+m ?)?\\d+s) +>)`)
const GENERIC = /^(?:Working|Thinking)(?:…|\.\.\.)?$/i

// "1h 2m 5s" → seconds.
function seconds(s: string): number {
  let n = 0
  for (const m of s.matchAll(/(\d+)([hms])/g)) n += Number(m[1]) * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1)
  return n
}

export function parseOmpActivity(text: string | null | undefined): OmpActivity | null {
  if (!text) return null
  const lines = text.split('\n').map(l => l.trimEnd())
  let step: string | null = null
  let elapsed: number | null = null
  let found = false
  // The activity sits in the screen's last few lines (below it: the status
  // line and the input field, a few lines at most even when it grows).
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 16); i--) {
    const line = lines[i]!
    const e = ELAPSED_RE.exec(line)
    if (e) {
      if (elapsed === null) elapsed = seconds(e[1] ?? e[2]!)
      continue
    }
    const m = STEP_RE.exec(line) || (elapsed !== null ? ASCII_STEP_RE.exec(line) : null)
    if (m) {
      const label = m[1]!.trim()
      step = GENERIC.test(label) ? null : label.slice(0, 120)
      found = true
      break
    }
  }
  return found || elapsed !== null ? { step, elapsed } : null
}

// Elapsed seconds on screen → start of the turn, stable within a few seconds.
export function ompActivityOf(a: OmpActivity | null, prev: OmpActivityState | null | undefined, now = Date.now()): OmpActivityState | null {
  if (!a) return null
  let since = a.elapsed === null ? null : now - a.elapsed * 1000
  if (since !== null && prev?.since != null && Math.abs(since - prev.since) < 3000) since = prev.since
  return { step: a.step, since }
}
