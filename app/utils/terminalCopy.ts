// Frozen copy of the visible terminal and the scoped clipboard helpers of the
// phone copy surface. Only the visible grid, captured once: no history read,
// no guess about whether unrelated TUI rows belong to the same paragraph.
import type { Terminal } from '@xterm/xterm'
import { screenSpans } from './screenSpans'
import { trimSelection } from './terminalSelection'

export function captureTerminalScreen(term: Terminal) {
  return {
    lines: screenSpans(term),
    columns: term.cols,
    fontFamily: term.options.fontFamily,
    fontSize: term.options.fontSize,
  }
}
export type TerminalCopySnapshot = ReturnType<typeof captureTerminalScreen>

// Text of the current native selection restricted to the frozen snapshot
// `root`. Android's system Select all can cover the whole page, including the
// hidden xterm grid: each range is intersected with the snapshot, without
// rewriting the selection or disturbing its native handles.
export function selectedCopyText(root: HTMLElement, selection: Selection | null = document.getSelection()): string {
  if (!selection?.rangeCount || selection.isCollapsed) return ''
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

// Copies `text`: the Clipboard API first, synchronously inside the caller's
// gesture, then `execCommand('copy')` on the existing native selection. The
// fallback never creates or focuses a temporary input (which would lose the
// handles and can open the phone IME) and never rewrites the selection; a
// refusal leaves it intact so the user can use the system's Copy.
export async function copyNativeSelection(text: string, stillSelected: () => boolean): Promise<boolean> {
  if (!text) return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* Keep the native selection for the synchronous fallback. */ }
  // A failed async write may complete after the selection changed or the
  // layer closed: without a live target there is nothing safe to copy.
  if (!stillSelected()) return false
  try { return document.execCommand('copy') } catch { return false }
}
