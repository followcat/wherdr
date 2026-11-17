// Cline CLI's screen (tested with 3.0.74): the message field is
// `❯ Ask anything...` between full-width rules, above a status footer (the
// model line, the workspace, `Auto-approve all …`). A running turn shows a
// braille spinner such as `⠏ Thinking... (esc to cancel)` above the blank tail;
// a tool call awaiting permission replaces the field with a box offering
// `[y] Approve` and `[n] Deny`. Pure, shared by the server and its tests.
import type { ChoiceOption, Choices, PromptDetail } from './types'

// The message field's placeholder (the caret is `❯`, as in Claude Code).
export const CLINE_PROMPT = /^\s*❯\s+Ask anything/
// Full-width rule above and below the field.
const RULE = /^[ \t]*─{10,}[ \t]*$/
// The status footer under the field or the box, recognised by its structure
// rather than by a provider name (another provider prints its own where the
// capture says `ClinePass:`): a meter line — `██████ (7,596)` — then, within two
// lines, the auto-approve line that ends the screen.
const METER = /█{2,}\s*\(\d[\d,]*\)/
const AUTO_APPROVE = /\bAuto-approve all (?:enabled|disabled)\b/i
// A running turn's spinner: a braille glyph, the stage, then the escape hint.
const SPINNER = /^\s*[\u2800-\u28FF]\s+\S.*\besc(?:ape)? to cancel\b/
// The permission box's last line: `[y] Approve   [n] Deny`.
const APPROVE = /\[y\]\s+Approve\b/
const DENY = /\[n\]\s+Deny\b/
const OPTION = /\[([A-Za-z])\]\s+([^[]+?)(?=\s{2,}\[|$)/g

const linesOf = (text: string) => String(text || '').replace(/\s+$/, '').split('\n')
const frameOf = (lines: string[]) => lines.findLastIndex(l => CLINE_PROMPT.test(l))

// First line of the trailing status footer, or -1. Searched from the bottom, so
// a footer quoted in the conversation above never counts.
function footerStart(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!METER.test(lines[i]!)) continue
    for (let k = i + 1; k <= Math.min(i + 2, lines.length - 1); k++) if (AUTO_APPROVE.test(lines[k]!)) return i
  }
  return -1
}

// Index of the field's placeholder line (`❯ Ask anything...`), or -1.
export function clineFrame(text: string): number {
  return frameOf(linesOf(text))
}

// Whether the visible turn is running: the last content line above the field is
// the spinner. A spinner left in the scrollback by an earlier turn stays above
// other content, so it never counts.
export function clineWorking(text: string): boolean {
  const lines = linesOf(text)
  const frame = frameOf(lines)
  const above = frame < 0 ? lines : lines.slice(0, Math.max(0, frame - 1))
  const last = above.findLast(l => l.trim())
  return Boolean(last && SPINNER.test(last))
}

// The screen without the field and the status footer under it: what a card
// preview should read (the reply, the spinner, or the permission box).
export function clinePreviewText(text: string): string {
  const lines = linesOf(text)
  const frame = frameOf(lines)
  if (frame >= 0) {
    for (let i = frame - 1; i >= 0; i--) if (RULE.test(lines[i]!)) return lines.slice(0, i).join('\n')
  }
  const footer = footerStart(lines)
  return footer > 0 ? lines.slice(0, footer).join('\n') : text
}

// The permission box, as a question with two literal-key options:
//
//   Cline needs permission
//
//   Approve tool call?
//
//   run_commands
//
//     $ ls
//
//    [y] Approve   [n] Deny
//
//   … blank lines, then the status footer.
//
// Fail-closed: both options, in that order, and the question line are required;
// the options are the last non-blank line before the footer, and no message
// field is anywhere on the screen. A box quoted in a reply, a tool result, a
// fixture being edited or a pasted capture sits above the field, or with text
// after it, and is never offered as a live request — the real box replaces the
// field and ends the screen.
export function parseClineApproval(text: string | null | undefined): Choices | null {
  if (!text) return null
  const lines = linesOf(String(text))
  if (lines.some(l => CLINE_PROMPT.test(l))) return null
  const footer = footerStart(lines)
  if (footer < 0) return null
  let at = footer - 1
  while (at >= 0 && !lines[at]!.trim()) at--
  if (at < 0 || !APPROVE.test(lines[at]!) || !DENY.test(lines[at]!)) return null
  const before = lines.slice(Math.max(0, at - 8), at)
  const qi = before.findLastIndex(l => /Approve\b[^?]*\?/.test(l))
  if (qi < 0) return null
  const question = before[qi]!.trim()
  const rest = before.slice(qi + 1).map(l => l.trim()).filter(Boolean)
  const tool = rest.shift() || ''
  const command = rest.find(l => l.startsWith('$ '))?.slice(2).trim()
  const body = rest.filter(l => !l.startsWith('$ ')).join('\n')
  const detail: PromptDetail | undefined = tool
    ? { tool, ...(command ? { command } : {}), ...(!command && body ? { description: body } : {}) }
    : undefined
  const options: ChoiceOption[] = []
  for (const m of lines[at]!.matchAll(OPTION)) options.push({ label: m[2]!.trim(), hint: null, key: m[1]!.toLowerCase() })
  if (options.length !== 2 || options[0]!.key !== 'y' || options[1]!.key !== 'n') return null
  return { question, cursor: 0, options, ...(detail ? { detail } : {}) }
}
