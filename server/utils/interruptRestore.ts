// Stop pressed right after a message: Claude Code cancels the turn and puts
// the interrupted prompt back into its input field (checked on Claude Code
// 2.1.287: only while nothing of the reply was written yet). Its transcript
// keeps the user message, but the next message is written as its sibling (same
// parentUuid): a dead branch, dropped from the conversation (see parseClaude).
// From the conversation view, wherdr does the same as Claude: the message
// leaves the conversation and goes back into wherdr's field, and Claude's
// field is emptied so that sending it again does not type it twice.
import type { ChatItem } from '../../shared/types'
import { clearKeys, inputBox, msgText } from './unqueue'

// Compared without any whitespace: the field wraps long lines, even mid-word.
const norm = (t: string) => t.replace(/\s+/g, '')
// Claude shows a long paste as "[Pasted text #1 +29 lines]", a photo as "[Image #1]".
const PLACEHOLDER = /\[(?:Pasted text #\d+(?: \+\d+ lines)?|Image #\d+)\]/

// Does Claude's input field (content read by inputBox) hold exactly this message?
export function boxHolds(box: string | null | undefined, text: string): boolean {
  const want = norm(text)
  const parts = String(box || '').replace(/\s+/g, ' ').split(PLACEHOLDER).map(norm)
  if (!want) return false
  // Placeholders only: ours only if the message is long enough to be shown so.
  if (!parts.join('')) return parts.length > 1 && (text.includes('\n') || text.length > 800)
  if (parts.length === 1) return parts[0] === want
  const body = parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${body}$`, 's').test(want)
}

// The conversation's last user message, if nothing of a reply follows it.
export function unansweredLast(items: ChatItem[]): ChatItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!
    if (it.role === 'user') return it
    if (it.role !== 'system') return null
  }
  return null
}

export interface RestoreDeps {
  screen: () => Promise<string> // visible screen, in ANSI
  keys: (keys: string[]) => Promise<void>
  chat: () => Promise<ChatItem[]>
  sleep: (ms: number) => Promise<void>
  // wherdr's own messages for this pane not yet seen in the transcript (as
  // sent). A "!" command Claude puts back is never written as a user message
  // (Claude Code 2.1.294 only writes its caveat line), so it is found here.
  pending?: () => string[]
}

// Bash mode left empty ("!", see inputBox) holds nothing.
const empty = (box: string) => !box || box === '!'

// After an interrupt: the message Claude put back into its field, once that
// field is emptied; null when nothing came back (or it could not be emptied:
// then everything stays as Claude left it).
export async function takeBackInterrupted(d: RestoreDeps): Promise<ChatItem | null> {
  let box = ''
  for (let i = 0; i < 6 && empty(box); i++) {
    box = inputBox(await d.screen().catch(() => '')) || ''
    if (empty(box)) await d.sleep(250)
  }
  if (empty(box)) return null
  const last = unansweredLast(await d.chat())
  const mine = last && boxHolds(box, msgText(last.text))
    ? last
    : (d.pending?.() || []).map(msgText).filter(t => boxHolds(box, t)).map((text): ChatItem => ({ role: 'user', text, ts: null }))[0]
  if (!mine) return null
  const lines = box.split('\n').length
  for (let i = 0; i < 2; i++) {
    // Re-checked before each erase: the user may be typing in the terminal.
    if (i && !boxHolds(box, msgText(mine.text))) return null
    await d.keys(clearKeys(lines))
    await d.sleep(150)
    box = inputBox(await d.screen().catch(() => '')) || ''
    if (empty(box)) return mine
  }
  return null
}

// The conversation without the messages taken back (same text, same time).
export function withoutTakenBack(items: ChatItem[], hidden: { text: string, ts: string | null }[]): ChatItem[] {
  if (!hidden.length) return items
  return items.filter(i => !(i.role === 'user' && hidden.some(h => h.ts === (i.ts || null) && h.text === i.text)))
}
