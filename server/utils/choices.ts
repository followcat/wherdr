// Reading agents' blocking prompts (tool approval, AskUserQuestion,
// folder trust…) from Herdr's "detection" text, to offer them
// as buttons on the phone.
//
// Two forms seen in Claude Code:
//
//   What is your favourite colour?            Security guide
//
//   ❯ 1. Red                                  ❯ No, exit
//        The colour red                         Yes, I trust this folder
//     2. Green
//        The colour green                     Enter to confirm · Esc to cancel
//
// The ❯ cursor marks the selected option. We answer by moving the
// cursor (↑/↓) then Enter, which works for both forms.
//
// Claude Code's AskUserQuestion box (v2.1.x), with a "│" bar before the
// question and descriptions wrapped over several lines:
//
//   ☐ Storage                                  tab header (☐ A  ☐ B  ✔ Submit
//                                              with several questions)
//   │ Which approach should the next thread take for the storage layer,
//   │ given that the cache already holds most of the data?
//
//   ❯ 1. Keep the current cache (Recommended)
//        Smallest change: the cache stays the single source of truth and
//        the sync job only fills the gaps.
//     2. Move everything to the database
//        …
//     3. Type something.                        free answer: typed in place
//   ──────────────────────────────────────
//     4. Chat about this
//
//   Enter to select · ↑/↓ to navigate · Esc to cancel
//
// In a short pane only a window of the options is shown, with ↑/↓ before the
// first/last one when more are hidden ("↑ 2.", "↓ 3."), the numbering then has
// gaps ("❯ 1." … "5. Chat about this"). The full question and options come
// from the transcript (pendingClaudeAsk, completeClaudeAsk).
import { createHash } from 'node:crypto'
import type { ChoiceOption, Choices, PromptDetail, InteractiveMenu, MenuEntry, WaitScreen } from '../../shared/types'
import { isPermissionQuestion, screenDetail } from './promptDetail'
import { OMP_CURSOR, OMP_UP_DOWN, ompAlt } from '../../shared/ompSymbols'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

// ❯ in Claude Code, › in Codex; > on Codex's login screen, only taken
// before a numbered option (otherwise a "> …" quote would count).
const CURSOR = /^(\s*)(?:[❯›]|>(?=\s+\d{1,2}\.\s))\s+(\S.*?)\s*$/
const NUMBERED = /^(\s*)(?:[❯›>↑↓]\s+)?(\d{1,2})\.\s+(\S.*?)\s*$/
const RULE = /^[\s─━═—-]+$/
// Start of a neighbouring column: at least 3 spaces or a vertical bar │.
const GAP = /\S(?: {3,}| *│ *)(?=\S)/g

// Columns where text resumes after a gap, on a line.
function gapColumns(line: string): number[] {
  const cols: number[] = []
  for (const m of line.matchAll(GAP)) {
    const bar = m[0].indexOf('│')
    cols.push(m.index! + (bar >= 0 ? bar : m[0].length))
  }
  return cols
}

// Claude Code may show a panel to the right of the dialog box (diff
// view "N files changed"): each screen line then carries both
// columns. The neighbouring column is recognized by a gap on a text line
// outside the options (the question), at the same position as a blank followed by text
// on the cursor line; the aligned descriptions of a list (/model)
// only appear on option lines. We then cut the screen at that
// column.
function dropSidePanel(lines: string[], c: number): string[] {
  const cursor = lines[c]!
  const splitsCursor = (x: number) => x < cursor.length && /[\s│]/.test(cursor[x - 1]!) && /\S/.test(cursor[x]!)
  // Only the two text lines just above the options count:
  // further up, a boxed header (Codex) may line up by chance.
  let split = -1
  let seen = 0
  for (let i = c - 1; i >= Math.max(0, c - 40) && split < 0 && seen < 2; i--) {
    const line = lines[i]!
    if (!line.trim() || NUMBERED.test(line) || CURSOR.test(line)) continue
    seen++
    split = gapColumns(line).find(splitsCursor) ?? -1
  }
  if (split < 0) return lines
  return lines.map((line) => {
    if (line.length <= split || !/[\s│]/.test(line[split - 1]!)) return line
    return line.slice(0, split).replace(/[\s│]+$/, '')
  })
}

// Column (in characters) where the text of an option line starts.
function textColumn(line: string): number {
  const m = line.match(/^(\s*)(?:(?:[❯›]|[>↑↓](?=\s+\d))\s+)?/)
  return m ? m[0].length : 0
}

interface RawOption { n: number | null, label: string, hint: string | null, line: number, end: number }
// Claude's AskUserQuestion: free answer typed in place of its label, and the
// option below the separator.
export const CLAUDE_FREE = 'Type something.'
export const CLAUDE_CHAT = 'Chat about this'
// Claude's multiSelect questions: "[ ] Cat", "[✔] Dog", then Submit.
const CHECKBOX = /^\[([ ✔✓x×])\]\s+/
const SUBMIT = 'Submit'
// Free answer among checkboxes: no final dot there.
const CLAUDE_FREE_BOX = 'Type something'

// `strict`: only accept numbered lists. Used when Herdr does not see
// the agent as blocked (Codex's trust screen passes for "idle"):
// an unnumbered list could then just be the input field
// ("› Ask Codex…" followed by the model line, aligned the same way).
export function parseChoices(text: string | null | undefined, { strict = false, full = false }: { strict?: boolean, full?: boolean } = {}): Choices | null {
  if (!text) return null
  let lines = text.replace(/\s+$/, '').split('\n').slice(-60)

  // The last ❯ on screen: the previous ones are history (prompts
  // sent), the active prompt is always at the bottom.
  let c = -1
  for (let i = lines.length - 1; i >= 0; i--) if (CURSOR.test(lines[i]!)) { c = i; break }
  if (c < 0) return null
  lines = dropSidePanel(lines, c)

  const cursorLine = lines[c]!
  const cursorText = cursorLine.match(CURSOR)![2]!
  // Cursor on the "Submit" line of Claude's checkboxes: the list is read from
  // the numbered option just above.
  let anchor = c
  if (cursorText === SUBMIT) {
    for (let i = c - 1; i >= Math.max(0, c - 40) && anchor === c; i--) if (NUMBERED.test(lines[i]!)) anchor = i
  }
  const col = textColumn(lines[anchor]!)
  const options: RawOption[] = []
  let submit: RawOption | null = null

  if (/^\d{1,2}\.\s/.test(cursorText) || anchor !== c) {
    // Numbered options: we take all those aligned on the same column,
    // on both sides of the cursor (a ─── separator may cut them).
    // Upwards, the list ends at the first line that cannot be part of it
    // (the question, a tab header, the agent's previous reply): a numbered
    // list in that reply, at the same column, is not one of the options.
    let first = anchor
    for (let i = anchor - 1; i >= Math.max(0, anchor - 40); i--) {
      const line = lines[i]!
      if (NUMBERED.test(line) && textColumn(line) === col) first = i
      else if (line.trim() && !RULE.test(line) && textColumn(line) <= col) break
    }
    for (let i = first; i < lines.length; i++) {
      const line = lines[i]!
      const m = line.match(NUMBERED)
      if (m && textColumn(line) === col) {
        options.push({ n: Number(m[2]), label: m[3]!, hint: null, line: i, end: i })
      } else if (options.length && !submit && /^\s*(?:❯\s+)?Submit$/.test(line) && textColumn(line) > col) {
        // Claude's checkboxes: "Submit" below them, unnumbered.
        submit = { n: null, label: SUBMIT, hint: null, line: i, end: i }
      } else if (options.length && line.trim() && !RULE.test(line) && textColumn(line) > col) {
        // More indented lines just below an option: its description.
        const o = options[options.length - 1]!
        if (i === o.end + 1) {
          o.hint = o.hint ? `${o.hint} ${line.trim()}` : line.trim()
          o.end = i
        }
      }
    }
    // Safeguard: a real list is numbered 1, 2, 3… without gaps. A window on a
    // longer list (short pane) skips some: then a ↑/↓ marker shows, or the jump
    // crosses the separator above "Chat about this".
    const windowed = options.some(o => /^\s*[↑↓]/.test(lines[o.line]!))
    if (submit && !options.some(o => CHECKBOX.test(o.label))) {
      // Not a list of checkboxes after all: a description.
      const o = [...options].reverse().find(x => x.line < submit!.line)
      if (o && o.end === submit.line - 1 && !o.hint) o.hint = SUBMIT
      submit = null
    }
    for (let i = 0; i < options.length; i++) {
      const o = options[i]!
      const prev = i ? options[i - 1]! : null
      const want = prev ? prev.n! + 1 : 1
      if (o.n === want) continue
      const crossed = prev && lines.slice(prev.end + 1, o.line).some(l => RULE.test(l) && l.trim())
      if (o.n! < want || !(windowed || crossed)) return null
    }
  } else {
    if (strict) return null
    // Unnumbered options: lines adjacent to the cursor, same text column.
    const sameCol = (l: string) => Boolean(l.trim()) && !RULE.test(l) && !/^\s*[❯›]/.test(l) && textColumn(l) === col
    let first = c
    while (first - 1 >= 0 && sameCol(lines[first - 1]!)) first--
    let last = c
    while (last + 1 < lines.length && sameCol(lines[last + 1]!)) last++
    for (let i = first; i <= last; i++) {
      const label = i === c ? cursorText : lines[i]!.trim()
      options.push({ n: null, label, hint: null, line: i, end: i })
    }
  }

  // Checkboxes: Submit takes its place in the order of the list (↑/↓ go
  // through it), the options below it one place further.
  // In a window (short pane) the options hidden above Submit leave a gap: it
  // then takes the number of the option shown below it (Chat about this).
  if (submit) {
    const at = options.findIndex(o => o.line > submit!.line)
    const before = at < 0 ? options[options.length - 1]! : options[at - 1]!
    submit.n = at < 0 ? before.n! + 1 : options[at]!.n!
    for (const o of at < 0 ? [] : options.slice(at)) o.n = o.n! + 1
    options.splice(at < 0 ? options.length : at, 0, submit)
  }
  if (options.length < 2 || options.length > 12) return null
  const cursor = options.findIndex(o => o.line === c)
  if (cursor < 0) return null

  // The question: the closest non-empty line above the options,
  // preferably one ending with "?".
  // Failing that, a line containing a "?", then the closest one.
  let question: { t: string, i: number } | null = null
  let asks: { t: string, i: number } | null = null
  let nearest: { t: string, i: number } | null = null
  const top = options[0]!.line
  for (let i = top - 1; i >= Math.max(0, top - 12); i--) {
    const t = lines[i]!.trim()
    if (!t || RULE.test(t)) continue
    if (/\?\s*$/.test(t)) { question = { t, i }; break }
    if (!asks && t.includes('?')) asks = { t, i }
    if (!nearest) nearest = { t, i }
  }
  question = question || asks || nearest

  const out: Choices = {
    question: question ? (/\?\s*$/.test(question.t) ? joinQuestion(lines, question.i) : question.t).replace(/^[☐☒✔●◆▸•│\s]+/, '').slice(0, full ? undefined : 300) : null,
    cursor,
    options: options.map(o => ({
      label: o.label.slice(0, full ? undefined : 200),
      hint: o.hint ? o.hint.slice(0, full ? undefined : 300) : null,
      ...(o.n !== null ? { n: o.n } : {}),
    })),
  }
  if (out.options.some(o => CHECKBOX.test(o.label))) {
    out.multi = true
    // The last box, just above Submit, is "Type something" (or the text typed
    // in its place, which ticks it).
    const free = submit ? submit.n! - 1 : 0
    out.options = out.options.map((o) => {
      const m = o.label.match(CHECKBOX)
      if (!m) return o
      const label = o.label.slice(m[0].length)
      if (o.n !== free) return { ...o, label, checked: m[1] !== ' ' }
      const typed = label === CLAUDE_FREE_BOX ? null : [label, o.hint].filter(Boolean).join(' ')
      return { ...o, label: CLAUDE_FREE, hint: typed, checked: m[1] !== ' ', free: true }
    })
  } else markClaudeFree(out.options)
  // Last step of several questions ("Review your answers", "● question",
  // "→ answer", then "Ready to submit your answers?"): the answers under Submit.
  const review = lastMatch(lines.slice(0, top), /^\s*Review your answers\s*$/)
  if (review >= 0 && out.options[0] && /^Submit answers$/.test(out.options[0].label)) {
    const answers = lines.slice(review + 1, top).map(l => l.match(/^\s*→\s+(.+?)\s*$/)).filter(Boolean).map(m => m![1]!)
    if (answers.length) out.options[0] = { ...out.options[0], hint: answers.join(' · ').slice(0, full ? undefined : 300) }
  }
  // Permission request: what is requested (tool, command, file).
  if (question && isPermissionQuestion(out.question)) {
    const detail = screenDetail(lines, question.i, top)
    if (detail) out.detail = detail
  }
  return out
}

// Question wrapped over several lines: the lines just above in the same
// paragraph, with the same indentation (Claude's "│" bar included), that do not
// end a sentence ("Bash command" above "Do you want to proceed?" stays apart).
const BAR = /^(\s*)(│ ?)?/
function joinQuestion(lines: string[], at: number): string {
  const lead = (l: string) => l.match(BAR)![0]
  const text = (l: string) => l.slice(lead(l).length).trim()
  const parts = [text(lines[at]!)]
  for (let i = at - 1; i >= Math.max(0, at - 6); i--) {
    const l = lines[i]!
    const t = text(l)
    if (!t || RULE.test(l) || lead(l) !== lead(lines[at]!) || /[.?!:)]$/.test(t)) break
    parts.unshift(t)
  }
  return parts.join(' ')
}

// AskUserQuestion: "Type something." (or the text already typed there, which
// replaces its label) is the free answer, just above "Chat about this".
function markClaudeFree(options: ChoiceOption[]) {
  const chat = options.findIndex(o => o.label === CLAUDE_CHAT && o.n)
  for (let i = 0; i < options.length; i++) {
    const o = options[i]!
    if (!o.n) continue
    const typed = chat >= 0 && o.n === options[chat]!.n! - 1
    if (o.label !== CLAUDE_FREE && !typed) continue
    options[i] = { ...o, label: CLAUDE_FREE, hint: o.label === CLAUDE_FREE ? null : [o.label, o.hint].filter(Boolean).join(' '), free: true }
  }
}

// Keys to send to choose option `index` when the cursor is on `cursor`
// (counted on their numbers when the list shown is only a window on it).
// Checkboxes: Space checks or unchecks, without confirming; among them, an
// option without a box (Claude's Submit, Chat about this) is confirmed by Enter.
export function keysFor(choices: Choices, index: number): string[] {
  const from = choices.options[choices.cursor]?.n
  const to = choices.options[index]?.n
  const d = from && to ? to - from : index - choices.cursor
  const keys: string[] = []
  for (let i = 0; i < Math.abs(d); i++) keys.push(d > 0 ? 'down' : 'up')
  keys.push(choices.multi && choices.options[index]?.checked !== undefined ? 'space' : 'enter')
  return keys
}

// omp "Ask" box (ask tool), one question at a time:
//
//   ╭─ Ask ───────────────────────────╮
//   │  color    size    Submit        │   tabs (several questions only)
//   │ Favourite colour?               │
//   ├─────────────────────────────────┤
//   │ ❯ ○ Red                         │   ○ ◉ single choice, ☐ ☑ checkboxes
//   │       warm                      │   description
//   │   ○ Other (type your own)       │   free answer (always the last one)
//   │       Teal                      │   … and the text already given
//   ├─────────────────────────────────┤
//   │ ⏎ select · ↑/↓ move · ⎋ cancel  │
//   ╰─────────────────────────────────╯
//
// Last step with several questions: "Review answers", the numbered
// answers then "❯ Submit".
// Glyphs of omp's three symbol sets (unicode, nerd font, ascii; see
// shared/ompSymbols.ts): cursor, radio buttons, checkboxes, box borders.
const OMP_RADIO = ['○', '◉', '\uf10c', '\uf192', '( )', '(o)']
const OMP_CHECK = ['☐', '☑', '\uf096', '\uf14a', '[ ]', '[x]']
const OMP_CHECKED = new Set(['☑', '\uf14a', '[x]'])
const OMP_OPTION = new RegExp(`^(?:(${ompAlt(OMP_CURSOR)}) | {2})(${ompAlt([...OMP_RADIO, ...OMP_CHECK])}) (.+)$`)
const OMP_RULE = /^\s*[├╰+][─-]{3,}/
const OMP_ASK = /^\s*[╭+][─-]+ Ask\b/
const OMP_OTHER = 'Other (type your own)'
// Enter on "Other" replaces the box with the free-answer field:
//
//   ╭─ Custom answer: Favourite colour? ────────╮
//   │                                            │
//   │ > Teal                                     │   typed text, continued with a 2-space indent
//   │   with a hint of grey                      │
//   │                                            │
//   │ ⏎ or ⌃Q submit  ⎋ cancel  ⌃G external editor │
//   │                                            │
//   ╰────────────────────────────────────────────╯
const OMP_FIELD = /^\s*[╭+][─-]+ Custom answer: (.*?)\s*[─-]*[╮+]\s*$/
// Content of a box line, without its borders ("│ text   │").
function ompBoxText(line: string): string | null {
  let s = line.trimStart()
  if (s[0] !== '│' && s[0] !== '|') return null
  s = s.slice(s[1] === ' ' ? 2 : 1).trimEnd()
  if (s.endsWith('│') || s.endsWith('|')) s = s.slice(0, -1).trimEnd()
  return s
}
const lastMatch = (lines: string[], re: RegExp) => {
  for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i]!)) return i
  return -1
}

// Free-answer field on screen (below any "Ask" box: the ones in the
// conversation are higher up): its question, its text, its rows on screen
// (wrapping included). Empty: `value` === ''.
export interface OmpField { question: string | null, value: string, rows: number }
function readOmpField(lines: string[]): OmpField | null {
  const top = lastMatch(lines, OMP_FIELD)
  if (top < 0 || top < lastMatch(lines, OMP_ASK)) return null
  const body: string[] = []
  for (const line of lines.slice(top + 1)) {
    const s = ompBoxText(line)
    if (s === null) break
    body.push(s)
  }
  const start = body.findIndex(l => /^>(?: |$)/.test(l))
  if (start < 0) return null
  // From the bottom: margin, legend (⏎ submit · ⎋ cancel, on two rows in a
  // narrow pane), a blank row, then the text, blank lines included.
  let end = body.length
  while (end > start && !body[end - 1]!.trim()) end--
  const legend = end
  while (end > start && body[end - 1]!.trim()) end--
  if (end === legend || end - 1 <= start) return null
  const rows = body.slice(start, end - 1)
  return {
    question: lines[top]!.match(OMP_FIELD)![1]!.trim() || null,
    value: rows.map((l, i) => (i ? l.replace(/^ {2}/, '') : l.replace(/^> ?/, ''))).join('\n'),
    rows: rows.length,
  }
}
export function parseOmpField(text: string | null | undefined): OmpField | null {
  return text ? readOmpField(text.replace(/\s+$/, '').split('\n')) : null
}

export function parseOmpAsk(text: string | null | undefined, full = false): Choices | null {
  if (!text) return null
  const lines = text.replace(/\s+$/, '').split('\n')
  const field = readOmpField(lines)
  if (field) {
    const hint = field.value.replace(/\s+/g, ' ').trim().slice(0, full ? undefined : 200) || null
    return { question: field.question, cursor: 0, options: [{ label: OMP_OTHER, hint, free: true }], typing: true }
  }
  const top = lastMatch(lines, OMP_ASK)
  if (top < 0) return null
  // Header, options, legend: separated by rules (the last one closes the box).
  const sections: string[][] = [[]]
  for (const line of lines.slice(top + 1)) {
    if (OMP_RULE.test(line)) { sections.push([]); continue }
    const s = ompBoxText(line)
    if (s === null) break
    sections[sections.length - 1]!.push(s)
  }
  if (sections.length < 3) return null
  const header = sections[0]!.filter(l => l.trim())
  // Tabs (several questions, or checkboxes): "color    size    Submit", on
  // several rows in a narrow pane, always ending with Submit.
  const bar = header.slice(0, 3).findIndex(l => /(?:^| {2,})Submit$/.test(l.trim()))
  const tabs = bar >= 0 ? header.splice(0, bar + 1).join('  ').trim().split(/ {2,}/) : null
  const question = header.map(l => l.trim()).join(' ').slice(0, full ? undefined : 300) || null
  const list = sections[1]!
  const options: ChoiceOption[] = []
  let cursor = -1
  let multi = false
  for (const line of list) {
    const m = OMP_OPTION.exec(line)
    if (m) {
      if (m[1]) cursor = options.length
      multi ||= OMP_CHECK.includes(m[2]!)
      options.push({ label: m[3]!.slice(0, full ? undefined : 200), hint: null, ...(OMP_CHECKED.has(m[2]!) ? { checked: true } : {}), ...(m[3] === OMP_OTHER ? { free: true } : {}) })
    } else if (options.length && line.trim() && !options[options.length - 1]!.hint) {
      options[options.length - 1]!.hint = line.trim().replace(/^↳\s*/, '').slice(0, full ? undefined : 200)
    }
  }
  if (!options.length) {
    // "Review answers" step: the answers as Submit's description.
    if (!list.some(l => OMP_CURSOR.some(c => l.trim() === `${c} Submit`))) return null
    const answers = list.map(l => l.trim()).filter(l => /^\d+\.\s/.test(l)).map(l => l.replace(/^\d+\.\s+/, ''))
    return { question, cursor: 0, options: [{ label: 'Submit', hint: answers.join(' · ').slice(0, full ? undefined : 200) || null }], ...(tabs ? { tabs, tab: tabs.length - 1 } : {}) }
  }
  if (cursor < 0) return null
  const shown = multi ? options.map(o => ({ ...o, checked: Boolean(o.checked) })) : options
  // Tab shown: only the ANSI screen tells (see ompActiveTab).
  return { question, cursor, options: shown, ...(multi ? { multi: true } : {}), ...(tabs ? { tabs } : {}) }
}

// omp's select dialog (tool approval, "Always for this session"…), a box
// whose title is the question, then the details, then the options:
//
//   ╭─ Allow tool: eval ──────────────╮
//   │                                 │
//   │ Language: python                │   details (the tool's input), cut by omp
//   │ Code:                           │   past 2000 characters; a long one scrolls
//   │ print(6*7)                      │   the title off the top of the screen
//   │                                 │
//   │  ❯ Approve                      │   options, cursor on the selected one
//   │    Deny                         │
//   │                                 │
//   │ ↑/↓ navigate  ⏎ select  ⎋ cancel│
//   ╰─────────────────────────────────╯
//
// Answered with ↑/↓ then Enter (keysFor). Never typed into: Enter would pick
// the selected option (Approve) in the user's place.
const OMP_SELECT_TOP = /^\s*[╭+][─-] (.+?) [─-]+[╮+]\s*$/
const OMP_SELECT_LEGEND = new RegExp(`^\\s*[│|] ${ompAlt(OMP_UP_DOWN)} navigate\\b.*\\bselect\\b`)
const OMP_SELECT_OPTION = new RegExp(`^ (?:(${ompAlt(OMP_CURSOR)})|\\s)\\s(\\S.*)$`)
export function parseOmpSelect(text: string | null | undefined, full = false): Choices | null {
  if (!text) return null
  const lines = text.replace(/\s+$/, '').split('\n')
  return readOmpSelect(lines, full) || readOmpApproval(lines, full)
}
function readOmpSelect(lines: string[], full: boolean): Choices | null {
  const legend = lastMatch(lines, OMP_SELECT_LEGEND)
  if (legend < 0) return null
  // Only the box's margin and bottom below the legend: the dialog is open.
  const below = lines.slice(legend + 1).filter(l => l.trim() && ompBoxText(l) !== '').map(l => l.trim())
  if (!below.length || !/^[╰+]/.test(below[0]!) || below.slice(1).some(l => /^[│|╭]/.test(l))) return null
  let i = legend - 1
  while (i >= 0 && ompBoxText(lines[i]!) === '') i--
  const options: ChoiceOption[] = []
  let cursor = -1
  for (; i >= 0; i--) {
    const s = ompBoxText(lines[i]!)
    const m = s ? OMP_SELECT_OPTION.exec(s) : null
    if (!m) break
    if (m[1]) cursor = options.length
    options.unshift({ label: m[2]!.trim().slice(0, full ? undefined : 200), hint: null })
  }
  if (cursor < 0) return null
  cursor = options.length - 1 - cursor
  // Details up to the title (or the top of the screen).
  const body: string[] = []
  let title: string | null = null
  for (; i >= 0; i--) {
    const top = OMP_SELECT_TOP.exec(lines[i]!)
    if (top) { title = top[1]!.trim(); break }
    const s = ompBoxText(lines[i]!)
    if (s === null) break
    body.unshift(s)
  }
  while (body.length && !body[0]!.trim()) body.shift()
  while (body.length && !body[body.length - 1]!.trim()) body.pop()
  const tool = title ? /^Allow tool: (\S+)/.exec(title)?.[1] : undefined
  // Title scrolled off: still a tool approval (omp's only select with details).
  const detail: PromptDetail | undefined = tool || (!title && body.length)
    ? { tool: tool || 'tool', ...(body.length ? { command: body.join('\n') } : {}) }
    : undefined
  return { question: title, cursor, options, ...(detail ? { detail } : {}) }
}

// omp 18.14+: the approval prompt takes the composer's place (the composer
// stays below it), one row per detail, a rule, then a footer:
//
//   ╭─ Allow tool: eval ─────────────────────────────╮   " (12s)" while a timeout runs
//   │ Language: python · Code: import os …           │   details summarized (Ctrl+O: in full, scrolled)
//   │ ❯ Approve                                      │   choices: Approve, "Approve eval for this
//   │   Approve eval for this session                │   session", Deny ("Approve Once" under the
//   │   Deny                                         │   grants and their "Remember" toggle)
//   ├────────────────────────────────────────────────┤
//   │ ↑/↓ choose · ⏎ select · Ctrl+⏎/Ctrl+Q approve · ⎋ deny · Ctrl+O details · … │
//   ╰────────────────────────────────────────────────╯
//    π > Opus > ~/demo ▶──────────────────────────────
//   ╰─
//
// Also read without the frame (title, details, choices and footer at the
// same indent). Only at the bottom of the screen: the footer is among its
// last rows, with only the frame's bottom and the composer below it.
// While the composer holds a draft, the arrows and Enter edit and send it:
// the only choice then is the highlighted "Deny and send message".
const OMP_APPROVAL_FOOTER = /^\S+ choose · \S+ select\b|^\S+ deny and send\b/
const OMP_APPROVAL_DRAFT = /^\S+ deny and send\b/
const OMP_APPROVAL_TITLE = /^(Allow tool: (\S+))(?: \(\d+s\))?$/
const OMP_APPROVAL_OPTION = new RegExp(`^(?:(${ompAlt([...OMP_CURSOR, '›'])}) | {2})(\\S.*)$`)
const OMP_APPROVAL_RULE = /^\s*[├+][─-]+[┤+]\s*$/
const OMP_APPROVAL_BOTTOM = /^\s*[╰+][─-]+[╯+]\s*$/
const OMP_APPROVAL_SCROLLBAR = /\s[█│|▐▌]$/
function ompApprovalFooter(lines: string[]): { at: number, boxed: boolean } | null {
  let rows = 0
  for (let i = lines.length - 1; i >= 0 && rows < 8; i--) {
    if (!lines[i]!.trim()) continue
    rows++
    const boxed = ompBoxText(lines[i]!)
    if (!OMP_APPROVAL_FOOTER.test(boxed ?? lines[i]!.trim())) continue
    const below = lines.slice(i + 1).filter(l => l.trim())
    if (boxed !== null && !OMP_APPROVAL_BOTTOM.test(below.shift() || '')) return null
    return below.length <= 6 ? { at: i, boxed: boxed !== null } : null
  }
  return null
}
function readOmpApproval(lines: string[], full: boolean): Choices | null {
  const footer = ompApprovalFooter(lines)
  if (!footer) return null
  let i = footer.at - 1
  if (footer.boxed) {
    if (!OMP_APPROVAL_RULE.test(lines[i] || '')) return null
    i--
  } else {
    while (i >= 0 && (!lines[i]!.trim() || /^\s*[─-]{3,}\s*$/.test(lines[i]!))) i--
  }
  // Unframed: rows at the footer's indent.
  const pad = /^\s*/.exec(lines[footer.at]!)![0]
  const row = (line: string) => footer.boxed ? ompBoxText(line) : line.startsWith(pad) ? line.slice(pad.length).trimEnd() : null
  // Choices, up from Deny to Approve (or to the grants' "Remember" toggle
  // above "Approve Once"): detail rows above may look like choices ("  - src/").
  const options: ChoiceOption[] = []
  let cursor = -1
  let once = false
  for (; i >= 0; i--) {
    const s = row(lines[i]!)
    const m = s === null ? null : OMP_APPROVAL_OPTION.exec(s)
    if (!m) break
    const label = m[2]!.trim()
    if (m[1]) cursor = options.length
    options.unshift({ label: label.slice(0, full ? undefined : 200), hint: null })
    once ||= label === 'Approve Once'
    if (once ? / Remember across sessions$/.test(label) : label === 'Approve') { i--; break }
  }
  if (cursor < 0 || !/^Deny\b/.test(options[options.length - 1]!.label) || !options.some(o => /^Approve\b/.test(o.label))) return null
  cursor = options.length - 1 - cursor
  // Details up to the title (framed: in the top border).
  const body: string[] = []
  let title: RegExpExecArray | null = null
  for (; i >= 0 && body.length < 40; i--) {
    const top = footer.boxed ? OMP_SELECT_TOP.exec(lines[i]!) : null
    const s = top ? top[1]!.trim() : row(lines[i]!)
    if (s === null) break
    title = OMP_APPROVAL_TITLE.exec(s)
    if (title || top) break
    body.unshift(s)
  }
  // Unframed, the title is the only sign this is omp's dialog.
  if (!footer.boxed && !title) return null
  while (body.length && !body[0]!.trim()) body.shift()
  while (body.length && !body[body.length - 1]!.trim()) body.pop()
  // Details scrolled (Ctrl+O): the scrollbar's column ends every row.
  const details = body.length > 1 && body.every(l => OMP_APPROVAL_SCROLLBAR.test(l)) ? body.map(l => l.slice(0, -1).trimEnd()) : body
  const tool = title?.[2]
  const detail: PromptDetail = { tool: tool || 'tool', ...(details.length ? { command: details.join('\n') } : {}) }
  const drafting = OMP_APPROVAL_DRAFT.test(row(lines[footer.at]!) ?? '')
  return drafting
    ? { question: title?.[1] ?? null, cursor: 0, options: [options[cursor]!], detail }
    : { question: title?.[1] ?? null, cursor, options, detail }
}
// omp 18.14's approval prompt open at the bottom of the screen, over its composer.
export function ompApprovalOpen(text: string | null | undefined): boolean {
  return Boolean(text && readOmpApproval(text.replace(/\s+$/, '').split('\n'), false))
}

// omp's blocking prompt on screen: an open select dialog (its legend is at the
// bottom of the screen), otherwise its "Ask" box.
export function parseOmpPrompt(text: string | null | undefined, full = false): Choices | null {
  return parseOmpSelect(text, full) || parseOmpAsk(text, full)
}

// Tab shown in the "Ask" box (ANSI screen): the only one of the bar on a
// different background from the box border (or in reverse video). null if the
// bar does not have exactly these tabs, or without a single highlighted tab.
export function ompActiveTab(ansi: string | null | undefined, tabs: string[]): number | null {
  const rows = String(ansi || '').split('\n').map(ansiCells)
  const top = lastMatch(rows.map(r => r.text), OMP_ASK)
  if (top < 0) return null
  const end = rows.slice(top + 1, top + 4).findIndex(r => /(?:^| {2,})Submit$/.test((ompBoxText(r.text) || '').trim()))
  const bar = rows.slice(top + 1, top + 2 + end)
  if (end < 0 || bar.map(r => ompBoxText(r.text)).join('  ').trim().split(/ {2,}/).join('\n') !== tabs.join('\n')) return null
  const lit: number[] = []
  let k = 0
  for (const row of bar) {
    for (let at = 0; k < tabs.length; k++) {
      const i = row.text.indexOf(tabs[k]!, at)
      if (i < 0) break
      if (row.marks[i] !== row.marks[0]) lit.push(k)
      at = i + tabs[k]!.length
    }
  }
  return lit.length === 1 ? lit[0]! : null
}

// Text of an ANSI line and, for each character (UTF-16 unit), its background:
// a color (SGR 40-47, 100-107, 48;5;n, 48;2;r;g;b) or "inv" (SGR 7).
function ansiCells(line: string): { text: string, marks: string[] } {
  let text = ''
  const marks: string[] = []
  let bg = ''
  let inv = false
  let last = 0
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[([0-9;:]*)m|\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])|\r/g
  const plain = (s: string) => {
    text += s
    for (let i = 0; i < s.length; i++) marks.push(inv ? 'inv' : bg)
  }
  for (let m = re.exec(line); m; m = re.exec(line)) {
    plain(line.slice(last, m.index))
    last = re.lastIndex
    if (m[1] === undefined) continue
    const p = m[1] ? m[1].split(/[;:]/).map(Number) : [0]
    for (let i = 0; i < p.length; i++) {
      const n = p[i]!
      if (n === 0) { bg = ''; inv = false }
      else if (n === 7) inv = true
      else if (n === 27) inv = false
      else if (n === 49) bg = ''
      else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) bg = String(n)
      else if (n === 38 || n === 48) {
        const len = p[i + 1] === 5 ? 2 : p[i + 1] === 2 ? 4 : 0
        if (n === 48) bg = p.slice(i + 1, i + 1 + len).join(';')
        i += len
      }
    }
  }
  plain(line.slice(last))
  return { text, marks }
}

// omp's "ask" call still unanswered (JSON lines of its transcript):
// its full questions and descriptions. The box folds a long question
// ("…", ^O to unfold) and only the 1st line of a description can be read there.
export interface OmpAsked { question: string, options: { label: string, description: string | null }[] }
export function pendingOmpAsk(lines: string[]): OmpAsked[] {
  const pending = new Map<string, OmpAsked[]>()
  for (const line of lines) {
    if (!line || !line.includes('"message"')) continue
    let d: Json
    try { d = JSON.parse(line) }
    catch { continue }
    const m = d && d.type === 'message' && d.message
    if (!m) continue
    if (m.role === 'toolResult') pending.delete(m.toolCallId)
    else if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part || part.type !== 'toolCall' || part.name !== 'ask' || !part.id) continue
        const qs: Json[] = part.arguments && Array.isArray(part.arguments.questions) ? part.arguments.questions : []
        pending.set(part.id, qs.filter(q => q && typeof q.question === 'string').map(q => ({
          question: q.question.trim(),
          options: (Array.isArray(q.options) ? q.options : []).filter((o: Json) => o && typeof o.label === 'string')
            .map((o: Json) => ({ label: o.label, description: typeof o.description === 'string' && o.description.trim() ? o.description.trim() : null })),
        })))
      }
    }
  }
  return [...pending.values()].pop() || []
}

// Question recognized by its start, ignoring whitespace: omp joins the
// question's lines on display, and cuts a long question ("…").
const questionKey = (s: string | null | undefined) => (s || '').replace(/…$/, '').replace(/\s+/g, '')

// On-screen question completed by the call.
export function completeOmpAsk(choices: Choices, asked: OmpAsked[]): Choices {
  const shown = questionKey(choices.question)
  const q = shown && asked.find(a => questionKey(a.question).startsWith(shown))
  if (!q) return choices
  const desc = new Map(q.options.map(o => [o.label, o.description]))
  return {
    ...choices,
    question: q.question,
    options: choices.options.map((o) => {
      const d = desc.get(o.label.replace(/ \(Recommended\)$/, ''))
      return d ? { ...o, hint: d } : o
    }),
  }
}

// Claude's AskUserQuestion call still unanswered (JSON lines of its
// transcript): its questions, in full, with every option. The box may show
// only a window of the options (short pane) and wraps the question.
export interface ClaudeAsked extends OmpAsked { multi: boolean }
export function pendingClaudeAsk(lines: string[]): ClaudeAsked[] {
  const pending = new Map<string, ClaudeAsked[]>()
  for (const line of lines) {
    if (!line || !line.includes('"type"')) continue
    let d: Json
    try { d = JSON.parse(line) }
    catch { continue }
    if (!d || d.isSidechain) continue
    const content = d.message && d.message.content
    if (d.type === 'user') {
      if (typeof content === 'string') { pending.clear(); continue }
      if (Array.isArray(content)) for (const part of content) if (part && part.type === 'tool_result') pending.delete(part.tool_use_id)
    } else if (d.type === 'assistant' && Array.isArray(content)) {
      for (const part of content) {
        if (!part || part.type !== 'tool_use' || part.name !== 'AskUserQuestion' || !part.id) continue
        const qs: Json[] = part.input && Array.isArray(part.input.questions) ? part.input.questions : []
        pending.set(part.id, qs.filter(q => q && typeof q.question === 'string').map(q => ({
          question: q.question.trim(),
          multi: Boolean(q.multiSelect),
          options: (Array.isArray(q.options) ? q.options : []).filter((o: Json) => o && typeof o.label === 'string')
            .map((o: Json) => ({ label: o.label, description: typeof o.description === 'string' && o.description.trim() ? o.description.trim() : null })),
        })))
      }
    }
  }
  return [...pending.values()].pop() || []
}

// On-screen AskUserQuestion box completed by the call: full question, every
// option with its whole description, then "Type something." and "Chat about
// this" (checkboxes: "Type something", Submit, then "Chat about this"). Only
// when the options shown are those of one of its questions.
const sameLabel = (shown: string, full: string) => {
  const a = shown.replace(/\s+/g, '')
  const b = full.replace(/\s+/g, '')
  return a === b || b.startsWith(a)
}
// Boxes of a checkbox question last seen ticked, by question then label: a
// window (short pane) hides some of them. Kept by the caller per pane, and
// forgotten when the question goes away.
export type AskChecks = Map<string, { checked: boolean, hint: string | null }>
export function completeClaudeAsk(choices: Choices, asked: ClaudeAsked[], checks?: AskChecks): Choices {
  if (!asked.length || choices.options.some(o => !o.n)) return choices
  const cur = choices.options[choices.cursor]!
  const multi = Boolean(choices.multi)
  const fits = (q: ClaudeAsked) => {
    const k = q.options.length
    if (q.multi !== multi || !k) return false
    const tail = multi ? [SUBMIT, CLAUDE_CHAT] : [CLAUDE_CHAT]
    return choices.options.every(o => (o.n! <= k
      ? !o.free && sameLabel(o.label, q.options[o.n! - 1]!.label)
      : o.n === k + 1 ? Boolean(o.free) : o.label === tail[o.n! - k - 2] && !o.free && o.checked === undefined))
  }
  const q = asked.find(a => sameQuestion(choices.question, a.question) && fits(a)) || asked.find(fits)
  if (!q) return choices
  const k = q.options.length
  const free = choices.options.find(o => o.free)
  if (!multi) {
    const options: ChoiceOption[] = [
      ...q.options.map((o, i) => ({ label: o.label.slice(0, 200), hint: o.description ? o.description.slice(0, 600) : null, n: i + 1 })),
      { label: CLAUDE_FREE, hint: free ? free.hint : null, free: true, n: k + 1 },
      { label: CLAUDE_CHAT, hint: null, n: k + 2 },
    ]
    return { ...choices, question: q.question, cursor: cur.n! - 1, options }
  }
  // Checkboxes: those on screen as read (and remembered), the hidden ones as last seen.
  const key = (label: string) => `${q.question}\n${label}`
  for (const o of choices.options) if (o.checked !== undefined) checks?.set(key(o.label), { checked: o.checked, hint: o.free ? o.hint : null })
  const seen = (label: string) => checks?.get(key(label))
  const box = (label: string) => Boolean(choices.options.find(o => o.label === label && o.checked !== undefined)?.checked ?? seen(label)?.checked)
  const options: ChoiceOption[] = [
    ...q.options.map((o, i) => ({ label: o.label.slice(0, 200), hint: o.description ? o.description.slice(0, 600) : null, n: i + 1, checked: box(choices.options.find(s => s.n === i + 1)?.label ?? o.label) })),
    { label: CLAUDE_FREE, hint: free ? free.hint : seen(CLAUDE_FREE)?.hint ?? null, free: true, n: k + 1, checked: free ? Boolean(free.checked) : Boolean(seen(CLAUDE_FREE)?.checked) },
    { label: SUBMIT, hint: null, n: k + 2 },
    { label: CLAUDE_CHAT, hint: null, n: k + 3 },
  ]
  return { ...choices, question: q.question, cursor: cur.n! - 1, options }
}

// Same question on the re-read screen and on the phone: either one may be
// cut, or completed from the transcript (completeOmpAsk).
export function sameQuestion(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = questionKey(a)
  const y = questionKey(b)
  return x && y ? x.startsWith(y) || y.startsWith(x) : x === y
}

// Identity describes the native question, not surrounding output or selection.
// Permission details are part of the question; checkbox/cursor state is not.
const identity = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function promptIdentity(text: string | null | undefined, agent?: string | null): string {
  const c = agent === 'omp' ? parseOmpPrompt(text, true) : agent ? parseChoices(text, { full: true }) : parseChoices(text, { full: true }) || parseOmpPrompt(text, true)
  return identity(c ? { question: c.question, options: c.options.map(({ label, hint, n, free }) => ({ label, hint, n, free })), detail: c.detail, multi: c.multi, tabs: c.tabs } : null)
}
export function menuIdentity(menu: InteractiveMenu, target: MenuEntry | undefined = menu.cursor === null ? undefined : menu.items[menu.cursor]): string {
  return identity({ title: menu.title, target: target ? { label: target.label, hint: target.hint, header: target.header } : null, actions: menu.actions })
}
export function waitIdentity(screen: WaitScreen): string {
  return identity({ kind: screen.kind, title: screen.title, lines: screen.lines, actions: screen.actions })
}

// On-screen prompt re-read before choose/nav; Claude questions can be
// completed by the pending transcript call after their screen identity is set.
export function screenChoices(text: string | null | undefined, agent: string | null | undefined, asked: ClaudeAsked[] = []): Choices | null {
  const c = agent === 'omp' ? parseOmpPrompt(text) : parseChoices(text) || parseChoices(text, { strict: true })
  if (c) c.identity = promptIdentity(text, agent)
  return c && agent === 'claude' ? completeClaudeAsk(c, asked) : c
}

// Visible input field = a "❯" (Claude) or "›" (Codex) line at the bottom of
// the screen. Some commands (/usage, /context all…) open a full-screen
// panel that hides it until Escape is pressed.
// Full-screen panel (/usage…) hiding the input, closed by Esc before a send:
// no prompt line at all. A menu's cursor line keeps it open (the user may be
// going through it, e.g. an /mcp authentication). Claude and Codex only: other
// agents' input has no "❯"/"›" line (omp: "╰─"), and Escape twice on an idle
// omp opens its branch selector, which then swallows the message.
export function panelOpen(text: string | null | undefined, agent: string | null | undefined): boolean {
  if (agent !== 'claude' && agent !== 'codex') return false
  const lines = String(text || '').replace(/\s+$/, '').split('\n').slice(-12)
  return !lines.some((l, i) => /^\s*[❯›](\s|$)/.test(l) || bashInput(l, lines[i - 1]))
}

// Claude's input field in bash mode (a "!" typed first): "!" prompt right
// under the (pink) rule, "! for shell mode" below. Not a panel or a menu:
// Escape there would throw away what the field holds.
const bashInput = (line: string, above: string | undefined) => /^!(\s|$)/.test(line) && /^\s*─{3,}/.test(above || '')

// Claude's input line sits right under a ─── rule: a menu's cursor line
// ("❯ 1. Yes, proceed", /mcp, /hooks…) is not its input field. omp's field
// ends with a "╰─" line followed by the text typed, under its status line
// ("π > Opus > ~/demo ▶─1%────1M─"); a box's bottom is a longer rule.
export function inputVisible(text: string | null | undefined): boolean {
  if (ompApprovalOpen(text)) return false
  const lines = String(text || '').replace(/\s+$/, '').split('\n').slice(-12)
  return lines.some((l, i) => /^\s*›(\s|$)/.test(l)
    || (/^\s*❯(\s|$)/.test(l) && /^\s*─{3,}/.test(lines[i - 1] || ''))
    || /^╰─(\s|$)/.test(l)
    || bashInput(l, lines[i - 1]))
}
