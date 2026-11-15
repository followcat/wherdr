import { isRefLine } from '../../shared/reference'
import type { KeyInfo } from './cardKeys'

export const PROMPT_HISTORY_MAX = 100
export interface HistoryDraft { text: string, start: number, end: number }

// Only the field's own words: attachments live separately, references are lines.
export const historyText = (text: string) => text.split('\n').filter(line => !isRefLine(line)).join('\n').trim()

export function addPromptHistory(entries: string[], text: string): string[] {
  const plain = historyText(text)
  if (!plain || entries.at(-1) === plain) return entries
  return [...entries, plain].slice(-PROMPT_HISTORY_MAX)
}

// Selection, modified arrows and IME belong to the editor. Up recalls only on
// the first visual line and Down only on the last: `onEdge` checks wrapping.
export function historyDirection(e: KeyInfo & { keyCode?: number }, draft: HistoryDraft, onEdge: (direction: -1 | 1) => boolean = () => true): -1 | 1 | null {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || draft.start !== draft.end) return null
  if (e.key === 'ArrowUp' && !draft.text.slice(0, draft.start).includes('\n') && onEdge(-1)) return -1
  if (e.key === 'ArrowDown' && !draft.text.slice(draft.end).includes('\n') && onEdge(1)) return 1
  return null
}

const MIRRORED = ['fontFamily', 'fontSize', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'lineHeight', 'letterSpacing', 'wordSpacing',
  'textTransform', 'textIndent', 'tabSize', 'wordBreak', 'overflowWrap', 'direction', 'paddingLeft', 'paddingRight'] as const

// Lays out the caret's paragraph in a hidden copy of the field (same width and
// font) and tells whether the caret sits on its first (-1) or last (1) wrapped line.
export function caretOnVisualEdge(el: HTMLTextAreaElement, direction: -1 | 1): boolean {
  const text = el.value, caret = el.selectionStart
  const end = text.indexOf('\n', caret)
  const before = text.slice(text.lastIndexOf('\n', caret - 1) + 1, caret)
  const after = text.slice(caret, end < 0 ? text.length : end)
  if (direction === -1 ? !before : !after) return true
  const style = getComputedStyle(el)
  const mirror = document.createElement('div')
  for (const key of MIRRORED) mirror.style[key] = style[key]
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', boxSizing: 'border-box', width: `${el.clientWidth}px`, whiteSpace: 'pre-wrap' })
  const head = document.createElement('span'), tail = document.createElement('span')
  head.textContent = before
  tail.textContent = after || '\u200B'
  mirror.append(head, tail)
  document.body.append(mirror)
  try {
    const tails = tail.getClientRects(), first = head.getClientRects()[0]
    if (!tails.length || !first) return true
    const top = tails[0]!.top
    return Math.abs((direction === -1 ? first.top : tails[tails.length - 1]!.top) - top) < 1
  } finally {
    mirror.remove()
  }
}

export class PromptHistory {
  private snapshot: string[] = []
  private index = 0
  draft: HistoryDraft | null = null

  reset() { this.draft = null; this.snapshot = []; this.index = 0 }

  move(direction: -1 | 1, current: HistoryDraft, entries: string[]): HistoryDraft | null {
    if (!this.draft) {
      if (direction === 1 || !entries.length) return null
      this.draft = { ...current }
      this.snapshot = [...entries]
      this.index = entries.length
    }
    const index = Math.max(0, this.index + direction)
    if (index === this.index) return null
    if (index >= this.snapshot.length) {
      const original = this.draft
      this.reset()
      return original
    }
    this.index = index
    const text = this.snapshot[index]!
    return { text, start: text.length, end: text.length }
  }
}
