// Claude Code's screen while working: what the transcript does not say yet.
// A "!" command is only written there at the end; while it runs,
// the screen already shows the command, its output and a counter (Claude Code 2.1.x):
//
//   ! ./build.sh
//     ⎿  step 16 of 60
//        step 17 of 60
//        +15 lines (19s)
//        (ctrl+b to run in background)
//
//   ❯ a queued message
//     ctrl+enter to send now
//
//   ────────────────────────
//   ❯ Press up to edit queued messages
//   ────────────────────────
//
// No output yet: "⎿  Running… (7s)". Queued messages are the
// "❯" lines just above the input field frame; further up, the
// "❯" / "!" lines at column 0 are messages already sent.
import type { ClaudeScreen, ShellRun } from '../../shared/types'

const RULE_RE = /^\s*[─━]{8,}\s*$/
const SEND_NOW = /^ctrl\+enter to send now$/i
const RUNNING = /^Running…(?:\s*\(([^)]*)\))?$/
const MORE = /^\+(\d+) lines?(?:\s*\(([^)]*)\))?$/
const BACKGROUND = /^\(ctrl\+b to run in background\)$/i

// "1m 14s" → ms.
export function elapsedMs(s: string | null | undefined): number | null {
  const m = /^(?:(\d+)h\s*)?(?:(\d+)m\s*)?(\d+)s$/.exec(String(s || '').trim())
  if (!m) return null
  return ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3])) * 1000
}

// "❯ text" or "! command" entry and its continuation lines (indented by 2).
function entryAt(lines: string[], i: number): { text: string, next: number } {
  // "!  cmd": sent as "! cmd", Claude keeps the space after the "!".
  const out = [lines[i]!.slice(2).trimStart()]
  let j = i + 1
  for (; j < lines.length; j++) {
    const l = lines[j]!
    if (!/^ {2}\S/.test(l) || /^ {2}⎿/.test(l) || SEND_NOW.test(l.trim())) break
    out.push(l.slice(2))
  }
  return { text: out.join('\n').trim(), next: j }
}

export function parseClaudeScreen(text: string | null | undefined, now = Date.now()): ClaudeScreen | null {
  if (!text) return null
  const lines = text.split('\n').map(l => l.replace(/\s+$/, ''))
  // Input field frame: we only read what is above it.
  const rules: number[] = []
  for (let i = lines.length - 1; i >= 0 && rules.length < 2; i--) if (RULE_RE.test(lines[i]!)) rules.push(i)
  const end = rules.length === 2 ? rules[1]! : lines.length

  // Queue: block of "❯" lines (and their continuations, the "ctrl+enter" hint) right against the frame.
  let top = end
  for (let i = end - 1; i >= 0; i--) {
    const l = lines[i]!
    if (!l.trim() || /^ {2}\S/.test(l)) continue
    if (!l.startsWith('❯ ')) break
    top = i
  }
  const queued: string[] = []
  for (let i = top; i < end;) {
    if (lines[i]!.startsWith('❯ ')) {
      const e = entryAt(lines, i)
      if (e.text) queued.push(e.text)
      i = e.next
    } else i++
  }

  const capability = queued.length && lines.slice(top, end).some(l => SEND_NOW.test(l.trim())) ? { sendNow: true } : {}

  // Dernier message parti, au-dessus de la file.
  let last = -1
  for (let i = top - 1; i >= 0; i--) if (/^(?:❯ \S|! +\S)/.test(lines[i]!)) { last = i; break }
  if (last < 0) return { shell: null, sent: null, queued, ...capability }
  const entry = entryAt(lines, last)
  const bash = lines[last]!.startsWith('! ')
  const sent = bash ? `!${entry.text}` : entry.text

  let shell: ShellRun | null = null
  if (bash) {
    // Output: "⎿  " then indented lines, up to the first line at column 0.
    const out: string[] = []
    let running = false
    let hidden = 0
    let elapsed: string | null = null
    for (let j = entry.next; j < top; j++) {
      const l = lines[j]!
      if (l && !l.startsWith(' ')) break
      // Output at column 5 ("··⎿··text", then 5 spaces): its own indentation is kept.
      const t = /^ {2}⎿|^ {5}/.test(l) ? l.slice(5) : l.trim()
      const s = t.trim()
      let m: RegExpExecArray | null
      if ((m = RUNNING.exec(s))) { running = true; elapsed = m[1] || elapsed; continue }
      if ((m = MORE.exec(s)) && m[2]) { running = true; hidden = Number(m[1]); elapsed = m[2]; continue }
      if (BACKGROUND.test(s)) { running = true; continue }
      out.push(t)
    }
    while (out.length && !out[out.length - 1]!.trim()) out.pop()
    while (out.length && !out[0]!.trim()) out.shift()
    if (running) {
      const ms = elapsedMs(elapsed)
      shell = { command: entry.text, lines: out.slice(-12), hidden, since: ms === null ? null : now - ms }
    }
  }
  return { shell, sent, queued, ...capability }
}

// Claude Code status next to the input field ("✔ Update installed ·
// Restart to update"…), right-aligned in the last lines. Only
// known statuses are kept: the rest of these lines (tips, shortcuts,
// status bar) is not reliable.
const NOTICES = [
  /✔?\s*Update installed\s*·\s*Restart to update\b/,
  /Update available!?\s*(?:·\s*)?Run[^\n]*?update\b/i,
  /✗?\s*Auto-update failed\b(?:\s*·[^\n]*)?/,
]
export function parseClaudeNotice(text: string | null | undefined): string | null {
  if (!text) return null
  const lines = text.split('\n').map(l => l.replace(/\s+$/, ''))
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  // Dernier cadre du champ de saisie : on regarde de 3 lignes au-dessus jusqu'au bas.
  let rule = -1
  for (let i = lines.length - 1; i >= 0 && rule < 0; i--) if (RULE_RE.test(lines[i]!)) rule = i
  const from = Math.max(0, (rule < 0 ? lines.length : rule) - 8)
  for (let i = lines.length - 1; i >= from; i--) {
    for (const re of NOTICES) {
      const m = re.exec(lines[i]!)
      if (m) return m[0].trim().replace(/\s+/g, ' ')
    }
  }
  return null
}

// Claude Code's next-message suggestion: grayed-out text (SGR 2) alone in
// its input field, which Tab accepts. Read from the ANSI screen:
//
//   ────────────────────────
//   ❯  ESC[0mESC[2mYes, push the branchESC[0m
//   ────────────────────────
//
// Typed text is not grayed out; the "Press up to edit queued messages" hint
// is too, but it is not a suggestion. null: no suggestion.
// eslint-disable-next-line no-control-regex
const SGR_ANY = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const HINTS = /^Press up to edit queued messages$|^Try "|^Type your message/i
export function parseClaudeSuggestion(ansi: string | null | undefined): string | null {
  if (!ansi) return null
  const lines = String(ansi).split('\n').map(l => l.replace(/\r$/, ''))
  const plain = lines.map(l => l.replace(SGR_ANY, '').trimEnd())
  // Last frame of the field: "❯" line (non-breaking space) between two rules.
  let at = -1
  for (let i = plain.length - 1; i > 0; i--) {
    if (plain[i]!.startsWith('❯ ')) { at = i; break }
  }
  if (at < 1 || !RULE_RE.test(plain[at - 1]!) || !RULE_RE.test(plain[at + 1] || '')) return null
  // All content after the prompt must be grayed out: a single SGR 2 segment.
  const rest = lines[at]!.slice(lines[at]!.indexOf('❯') + 2)
  const m = /^\s*(?:\x1b\[0m)*\x1b\[2m([^\x1b]*)(?:\x1b\[0m)?\s*$/.exec(rest) // eslint-disable-line no-control-regex
  if (!m) return null
  const text = m[1]!.replace(/ /g, ' ').trim()
  if (!text || HINTS.test(text)) return null
  return text
}
