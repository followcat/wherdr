// "Cancel" a queued message: it leaves Claude Code's queue and its
// text comes back into wherdr's input field.
//
// Sequence checked on a real Claude Code (2.1.283): during a turn, ↑
// brings the WHOLE queue back into its input field (one `popAll` operation per
// entry in the transcript). We then empty the field (Ctrl+U erases a
// line, Backspace joins the previous one) and queue the other
// messages again. Traps: Escape and Ctrl+C interrupt the turn; `agent.prompt`
// appends to the text already in the field, hence the check that it is
// empty before and after.
import type { ChatItem, ClaudeQueueEntry } from '../../shared/types'
import { HerdrError } from './herdr'
import { isUploadLine } from './queued'
import { sameMsg } from './transcripts'
import { photosLanded, photosOnly } from '../../shared/queuedMatch'
import { lostPhotos } from './sentHistory'

// Message text without photo paths (which became images in Claude).
export const msgText = (t: string) => String(t || '').split('\n').filter(l => !isUploadLine(l)).join('\n').trim()

// wherdr's record of a message to cancel: by id first (a text match could be
// an earlier message starting the same way: "ok" before "ok, and this photo"),
// then by text.
export function findQueued<T extends { id: string, text: string }>(list: T[], text: string, id?: string): T | undefined {
  return (id ? list.find(q => q.id === id) : undefined) || list.find(q => sameMsg(msgText(q.text), msgText(text)))
}

// Content of Claude Code's input field, read from the ANSI screen: the
// "❯" line followed by a non-breaking space (queued messages have a normal
// space), then its continuation lines up to the rule. The grayed-out help text
// ("Press up to edit queued messages") does not count. null: field not found.
// A "!" typed first switches Claude to bash mode (Claude Code 2.1.288): the
// "!" leaves the field and becomes its prompt ("!" + non-breaking space, pink
// rules, "! for shell mode" below). The field then reads as the message that
// was typed, "!" first: "! cmd" typed shows "!\u00a0 cmd" and reads "! cmd";
// bash mode left empty reads "!" (guardedSend.ts leaves it before a normal message).
// Grayed-out text never counts: Claude Code's placeholder ('Try "fix
// typecheck errors"' in a fresh session), its next-message suggestion and
// completions are drawn in SGR 2 (dim), cleared by SGR 0 or 22, possibly
// inside a combined sequence ("\x1b[2;37m").
// Without colors (NO_COLOR, TERM=dumb), Claude draws its placeholders as
// plain text: a field holding one of them alone, on a screen with no SGR at
// all, reads empty. A next-message suggestion cannot be told from a draft
// there and still reads as text.
const ESC = String.fromCharCode(27)
const SGR = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g')
const COLOR_SGR = new RegExp(`${ESC}\\[[0-9;:]*m`)
const RULE = /^\s*─{3,}/
const PLACEHOLDER_HINT = /^(?:Try ".*"|Press up to edit queued messages)$/

// The line without its dim characters nor escape sequences.
function undimmed(line: string): string {
  let out = ''
  let dim = false
  let last = 0
  for (const m of line.matchAll(SGR)) {
    if (!dim) out += line.slice(last, m.index)
    last = m.index! + m[0].length
    if (!m[0].endsWith('m')) continue
    const codes = m[0].slice(2, -1).split(';')
    for (let i = 0; i < codes.length; i++) {
      const c = Number(codes[i] || 0)
      if (c === 0 || c === 22) dim = false
      else if (c === 2) dim = true
      else if (c === 38 || c === 48 || c === 58) i += codes[i + 1] === '5' ? 2 : codes[i + 1] === '2' ? 4 : 0
    }
  }
  if (!dim) out += line.slice(last)
  return out
}

export function inputBox(ansi: string): string | null {
  const lines = String(ansi || '').split('\n').map(l => l.replace(/\r$/, ''))
  let at = -1
  let bash = false
  for (let i = lines.length - 1; i >= 0; i--) {
    const plain = lines[i]!.replace(SGR, '')
    if (plain.startsWith('❯\u00a0')) { at = i; break }
    if (plain.startsWith('!\u00a0') && RULE.test((lines[i - 1] || '').replace(SGR, ''))) { at = i; bash = true; break }
  }
  if (at < 0) return null
  const out: string[] = []
  for (let i = at; i < lines.length; i++) {
    const plain = undimmed(lines[i]!)
    if (i > at && RULE.test(plain)) break
    out.push((i === at ? plain.slice(2) : plain.replace(/^ {1,2}/, '')).replace(/\u00a0/g, ' ').trimEnd())
  }
  let box = out.join('\n').trim()
  if (!bash && PLACEHOLDER_HINT.test(box) && !COLOR_SGR.test(ansi)) box = ''
  return bash ? `!${box && ' '}${box}` : box
}

// First line of Codex's input field (0.16x), read from the ANSI screen.
// '' empty, null: field not found. Codex also marks its earlier user messages
// with "›" in the history (drawn bold + dim) and the selected row of a menu
// (reverse video), so the field is anchored on its place, never on any "›":
// - it is the LAST line starting with "›" (followed by a space or nothing);
// - its "›" is neither dim nor reversed: otherwise that last "›" belongs to
//   the history or a menu and the field is not on screen (no earlier line is
//   tried);
// - below it come only blank lines and indented ones (its continuation lines,
//   then the footer: model · folder, shortcuts), never history.
// Its grayed-out placeholder ("Ask Codex to do anything") reads as empty.
// Checked on Codex 0.162.1: fresh, after a turn, popup of commands (drawn
// above the field), panes of 6 to 70 rows.
const CODEX_FIELD = /^›(?: |$)/
export function codexFieldLine(ansi: string): string | null {
  const lines = String(ansi || '').split('\n').map(l => l.replace(/\r$/, ''))
  let at = -1
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (CODEX_FIELD.test(lines[i]!.replace(SGR, ''))) at = i
  if (at < 0) return null
  const line = lines[at]!
  const mark = sgrState(line.slice(0, line.indexOf('›')))
  if (mark.dim || mark.reverse) return null
  for (const below of lines.slice(at + 1)) {
    const plain = below.replace(SGR, '')
    if (plain.trim() && !plain.startsWith('  ')) return null
  }
  return undimmed(line).replace(/^›\s?/, '').replace(/\u00a0/g, ' ').trim()
}

// First line of Devin's input field (v3000.x), read from the ANSI screen.
// '' empty, null: field not found. Its marker "❭" (U+276D — a different
// glyph from Claude's "❯") also leads every sent message in the history,
// so the field is anchored on position, never on the glyph alone:
// - it is the LAST line starting with "❭" (followed by a space or nothing);
// - below it come only the box's bottom rule, blanks, and the status footer
//   (Context: … tokens), never history or queued rows.
// Its hint lines ("Ask Devin to build…", "Guide Devin while it works",
// "Press Enter to send queued messages now") read as empty. Checked on
// v3000.11.234: idle, working with a queued message, after a turn.
const DEVIN_FIELD = /^❭(?: |$)/
const DEVIN_BOX = /^─{2,}/
const DEVIN_HINTS = /^(?:Ask Devin to build|Guide Devin while it works|Press Enter to send queued messages)/
export function devinFieldLine(ansi: string): string | null {
  const lines = String(ansi || '').split('\n').map(l => l.replace(/\r$/, ''))
  let at = -1
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (DEVIN_FIELD.test(lines[i]!.replace(SGR, ''))) at = i
  if (at < 0) return null
  // The prompt is boxed: a ─ separator closes it. Below it sits whatever
  // status block the running Devin draws (model line, token gauge, key
  // hints) — its wording changes between versions, so only the box's own
  // separator proves the ❭ line is the field and not a replayed message.
  const below = lines.slice(at + 1).map(l => l.replace(SGR, ''))
  const border = below.find(l => l.trim() !== '')
  if (!border || !DEVIN_BOX.test(border)) return null
  const line = undimmed(lines[at]!).replace(/^❭\s?/, '').replace(/\u00a0/g, ' ').trim()
  return DEVIN_HINTS.test(line) ? '' : line
}

// Dim and reverse video in effect at the end of `prefix` (SGR sequences only).
function sgrState(prefix: string): { dim: boolean, reverse: boolean } {
  let dim = false
  let reverse = false
  for (const m of prefix.matchAll(SGR)) {
    if (!m[0].endsWith('m')) continue
    const codes = m[0].slice(2, -1).split(';')
    for (let i = 0; i < codes.length; i++) {
      const c = Number(codes[i] || 0)
      if (c === 0) { dim = false; reverse = false }
      else if (c === 2) dim = true
      else if (c === 22) dim = false
      else if (c === 7) reverse = true
      else if (c === 27) reverse = false
      else if (c === 38 || c === 48 || c === 58) i += codes[i + 1] === '5' ? 2 : codes[i + 1] === '2' ? 4 : 0
    }
  }
  return { dim, reverse }
}

// Keys that empty a field of `lines` lines.
export function clearKeys(lines: number): string[] {
  const keys: string[] = []
  for (let i = 0; i < Math.min(Math.max(lines, 1) + 2, 200); i++) keys.push('ctrl+u', 'backspace')
  return keys
}

export interface UnqueueDeps {
  screen: () => Promise<string> // visible screen, in ANSI
  keys: (keys: string[]) => Promise<void>
  chat: () => Promise<{ queue: ClaudeQueueEntry[], items: ChatItem[] }>
  prompt: (text: string) => Promise<void> // agent.prompt
  sleep: (ms: number) => Promise<void>
  // Original text (with photo paths) of an entry queued again; null when
  // unknown for photos alone (nothing to type back).
  original?: (entry: ClaudeQueueEntry) => string | null
}

const already = () => new HerdrError('already_read', 'Already read by the agent')

// Removes the message `text` from Claude's queue. Returns the messages queued
// again, the number of photos Claude's entry of the message had, and the
// photos of the other entries that could not be typed back (no path known:
// Claude keeps none).
export async function unqueueClaude(d: UnqueueDeps, text: string): Promise<{ requeued: string[], images: number, lost: number }> {
  const wanted = msgText(text)
  // Photos alone: Claude's entry has no text, only images (see shared/queuedMatch.ts).
  const photos = photosOnly(text)
  const isIt = (q: ClaudeQueueEntry) => (photos ? !q.text && (q.images || 0) > 0 : sameMsg(q.text, wanted) || sameMsg(wanted, q.text))
  const before = await d.chat()
  if ((!wanted && !photos) || !before.queue.some(isIt)) throw already()
  const box0 = inputBox(await d.screen())
  if (box0 === null) throw new HerdrError('no_input', 'Agent input field not found')
  if (box0) throw new HerdrError('input_busy', 'The agent’s input field is not empty')

  await d.keys(['up'])
  let box = ''
  for (let i = 0; i < 8 && !box; i++) {
    await d.sleep(150)
    box = inputBox(await d.screen()) || ''
  }
  if (!box) throw already() // queue already emptied: ↑ brought nothing back

  // ↑ brings back the whole queue. But if the turn took it in the meantime, it is
  // the history that comes back: our message is then in the conversation.
  const saidCount = (items: ChatItem[], q: string) => items.filter(i => (i.role === 'user' || i.role === 'bash') && sameMsg(q, i.text)).length
  const saidNew = (a: ChatItem[], q: string) => saidCount(a, q) > saidCount(before.items, q)
  const photosSaid = (items: ChatItem[]) => items.filter(i => photosLanded(text, i)).length
  const wantedSaid = (a: ChatItem[]) => (photos ? photosSaid(a) > photosSaid(before.items) : saidNew(a, wanted))
  let after = before
  for (let i = 0; i < 15; i++) {
    after = await d.chat()
    if (!after.queue.some(isIt) || wantedSaid(after.items)) break
    await d.sleep(200)
  }
  const read = wantedSaid(after.items)
  const popped = read
    ? before.queue.filter(q => !after.queue.some(a => a.text === q.text) && !saidNew(after.items, q.text))
    : before.queue

  // Empty the field, checked (two attempts).
  const lines = box.split('\n').length + popped.reduce((s, q) => s + q.text.split('\n').length, 0)
  for (let i = 0; i < 2; i++) {
    await d.keys(clearKeys(lines))
    await d.sleep(150)
    box = inputBox(await d.screen()) || ''
    if (!box) break
  }
  if (box) throw new HerdrError('clear_failed', 'Agent input not cleared: check its terminal')
  if (read) throw already()

  const requeued: string[] = []
  let skipped = false
  let images = 0
  let lost = 0
  for (const q of popped) {
    if (!skipped && isIt(q)) { skipped = true; images = q.images || 0; continue }
    const t = d.original ? d.original(q) : q.text
    lost += lostPhotos(q.images, t)
    if (!t) continue
    await d.prompt(t)
    requeued.push(t)
  }
  return { requeued, images, lost }
}
