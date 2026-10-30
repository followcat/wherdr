import type { Terminal } from '@xterm/xterm'
import { screenSpans } from './screenSpans'
import { trimSelection } from './terminalSelection'

// Only the visible grid, captured once. No history requests or guesses about
// whether unrelated TUI rows belong to the same paragraph.
export function captureTerminalScreen(term: Terminal) {
  return { lines: screenSpans(term), columns: term.cols, fontFamily: term.options.fontFamily, fontSize: term.options.fontSize }
}
export type TerminalCopySnapshot = ReturnType<typeof captureTerminalScreen>

export function selectedCopyText(root: HTMLElement, selection = document.getSelection()): string {
  if (!selection?.rangeCount || selection.isCollapsed) return ''
  // Android's system Select all can cover the entire page, including the
  // hidden xterm grid. Intersect ranges with the snapshot without rewriting
  // the browser selection or disturbing its native handles.
  const bounds = document.createRange()
  bounds.selectNodeContents(root)
  const pieces: string[] = []
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i).cloneRange()
    if (!range.intersectsNode(root)) continue
    if (range.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) range.setStart(bounds.startContainer, bounds.startOffset)
    if (range.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) range.setEnd(bounds.endContainer, bounds.endOffset)
    pieces.push(range.toString())
  }
  return trimSelection(pieces.join('\n'))
}

// The fallback acts on the existing native selection: never create/focus an
// offscreen input (which would lose the handles and can open the phone IME).
export async function copyNativeSelection(text: string, stillSelected: () => boolean): Promise<boolean> {
  if (!text) return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* Keep the native selection for the synchronous fallback. */ }
  if (!stillSelected()) return false
  try { return document.execCommand('copy') } catch { return false }
}
