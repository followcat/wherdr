// Devin's screen (v3000.x): what the transcript does not say yet.
// Messages sent while the composer cannot take them (/compact running, a
// connection retry…) sit in its own queue, above the boxed input field:
//
//   ❭ earlier sent message            ← scrollback echo of a sent/steered one
//   ⠀⣠ Compacting…
//   ── 1 queued ─────────── ↑ edit · ↵ send now ──
//   ○ DURING-COMPACT probe message
//   ─── Run a 60-Second Sleep Command ───     ← composer box top rule
//   ❭ Ask Devin to build features, fix bugs…  ← input field
//   ─────────────────────────────────────     ← box bottom rule
//   SWE-2 Max        Context: 16k / 262k tokens (6%)
//
// "○" rows are the queued messages (newest last); "↵ send now" in the header
// is Devin's flush (Enter on the empty field). A steered or sent message is
// echoed "❭" in the scrollback — the last such row above the queue section.
import type { ClaudeScreen, OmpStatus } from '../../shared/types'

const FIELD = /^❭(?: |$)/
const BOX_RULE = /^─{2,}/
const QUEUE_HEAD = /^─+\s*\d+\s+queued\b/
const ENTRY = /^○\s?/
const SEND_NOW = /↵ send now/
// A row wider than the pane wraps: its continuation is indented ~2 cells
// (measured on live screens: "  queued-entry-… TAIL" under a "❭"/"○" row).
const CONTINUED = /^\s{2,}\S/

export function parseDevinScreen(text: string | null | undefined): ClaudeScreen | null {
  if (!text) return null
  const lines = String(text).split('\n').map(l => l.replace(/\s+$/, ''))

  // The composer field: the LAST "❭" line followed (first non-blank below)
  // by the box's bottom rule — the same anchor as devinFieldLine (unqueue.ts).
  // Without it the composer is not on this screen (a dialog, or scrolled
  // away): say nothing rather than guess.
  let field = -1
  for (let i = lines.length - 1; i >= 0 && field < 0; i--) if (FIELD.test(lines[i]!)) field = i
  if (field < 0) return null
  const belowField = lines.slice(field + 1).find(l => l.trim() !== '')
  if (!belowField || !BOX_RULE.test(belowField)) return null

  // The box's top rule: the first ─── line directly above the field.
  let boxTop = -1
  for (let i = field - 1; i >= 0; i--) {
    if (!lines[i]!.trim()) continue
    if (BOX_RULE.test(lines[i]!)) boxTop = i
    break
  }

  // The queue section, if any, sits right above the box top: its "○" rows
  // hug it and its header — a ─── rule that reads "N queued" — tops them.
  // Walking up only through entry rows keeps a "── N queued ──" replayed in
  // the scrollback (an older turn's) from counting.
  let head = -1
  if (boxTop >= 0) {
    let i = boxTop - 1
    for (; i >= 0; i--) {
      const l = lines[i]!
      if (ENTRY.test(l) || !l.trim() || CONTINUED.test(l)) continue
      break
    }
    if (i >= 0 && QUEUE_HEAD.test(lines[i]!)) head = i
  }
  const queued: string[] = []
  if (head >= 0) {
    for (let i = head + 1; i < boxTop; i++) {
      const l = lines[i]!
      if (ENTRY.test(l)) queued.push(l.replace(ENTRY, '').trim())
      // A wrapped row joins the entry it continues.
      else if (CONTINUED.test(l) && queued.length) queued[queued.length - 1] += ' ' + l.trim()
    }
  }
  const sendNow = queued.length && head >= 0 && lines.slice(head, boxTop).some(l => SEND_NOW.test(l))
    ? { sendNow: true } : {}

  // The last sent message echoed in the scrollback, above the queue section.
  // Its wrapped rows (indented, no marker) join it too.
  let sent: string | null = null
  const top = head >= 0 ? head : (boxTop >= 0 ? boxTop : field)
  for (let i = top - 1; i >= 0; i--) {
    const m = /^❭\s?(.*)$/.exec(lines[i]!)
    if (!m) continue
    sent = m[1]!.trim()
    for (let j = i + 1; j < top && CONTINUED.test(lines[j]!); j++) sent += ' ' + lines[j]!.trim()
    break
  }

  return { shell: null, sent, queued, ...sendNow }
}

// Devin's status footer, the last row under the composer's bottom rule:
//
//   SWE-2 Max                    Context: 16k / 262k tokens (6%)
//   Model · mode · 1 shell ↓     Context: 12k / 262k tokens (4%)
//
// `line` carries the left side (model, mode, shells); `meters` the context
// gauge — the same split OmpStatus makes and Composer renders for omp.
// Devin rotates that right slot: a turn can put its shortcut hints
// ("ctrl+o details · alt+t thinking") where the gauge was — the left side
// is still the footer, so it stays published and only the meter drops out.
// A null there would blink the whole line away and back as it rotates.
export function parseDevinStatus(text: string | null | undefined): OmpStatus | null {
  if (!text) return null
  const lines = String(text).split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim() !== '')
  const last = lines[lines.length - 1] || ''
  const i = last.indexOf('Context:')
  if (i > 0) {
    const line = last.slice(0, i).trim()
    const meters = last.slice(i).trim()
    // The gauge has a fixed shape — "Context: 16k / 262k tokens (6%)"; prose
    // mentioning "Context:" must not publish as a status footer.
    if (!line || !/^Context:\s*[\d.]+[kM]?\s*\/\s*[\d.]+[kM]?\s*tokens?\s*\(\s*\d+%\s*\)/.test(meters)) return null
    return { line: line.slice(0, 300), meters: meters.slice(0, 200) }
  }
  // No gauge: still the footer when the left half is its status text and the
  // right half is a shortcut-hint slot — anything else is not a status line.
  const [left, right, ...rest] = last.split(/\s{2,}/).map(s => s.trim()).filter(Boolean)
  if (rest.length || !left || !right || !/·/.test(left) || !/↓\s*$/.test(left) || !/^(?:ctrl|alt|shift)\+\S/i.test(right)) return null
  return { line: left.slice(0, 300), meters: null }
}
