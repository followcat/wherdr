// Reading position of a conversation, kept for the duration of the app
// session: coming back from Settings (or another view) reopens the conversation at
// the same place. Measured from the bottom: on return, only the end of the
// conversation is reloaded (older slices come back when
// scrolling up). At the bottom of the conversation, we stay stuck to the bottom.

interface ReadingPosition { file: string, fromBottom: number }

const NEAR_END = 120
const MAX_KEPT = 50
const positions = new Map<string, ReadingPosition>()

export function saveReadingPosition(paneId: string, file: string | null, box: { scrollTop: number, scrollHeight: number, clientHeight: number }) {
  positions.delete(paneId)
  if (!file || box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_END) return
  positions.set(paneId, { file, fromBottom: box.scrollHeight - box.scrollTop })
  if (positions.size > MAX_KEPT) positions.delete(positions.keys().next().value!)
}

// Scroll to restore, or null (nothing kept, other session: we go to the bottom).
// file undefined: not known (a copy kept on this device before files were kept),
// matched on the pane alone.
export function restoredScrollTop(paneId: string, file: string | null | undefined, scrollHeight: number): number | null {
  const p = positions.get(paneId)
  if (!p || (file !== undefined && p.file !== file)) return null
  return Math.max(0, scrollHeight - p.fromBottom)
}
