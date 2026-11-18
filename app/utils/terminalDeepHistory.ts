// When to fetch the deep history of a terminal, and where to put the view
// afterwards. Plain functions: the decisions are unit-tested, the controller
// (useTerminal.ts) only supplies the state.
//
// A cold open asks the core for COLD_HISTORY lines (shared/terminalHistory.ts).
// When the person scrolls back to the top of what the xterm holds, one deep
// fetch asks for the rest on the same socket, and the relay re-attaches at the
// same size. The deep paint replaces every buffer row, so the viewport is
// restored by its distance from the bottom, not by a buffer coordinate.

// How long a `terminal.history` may stay unanswered before the client gives up
// on it. The measured deep reveal on a phone-sized view is ~1 s (the attach plus
// the reveal gate's 150 ms quiet window and its 2 s bound); a slow link adds the
// relay's own attach round trip and the paint. Six seconds leaves room for that
// without letting a relay that ignored the message (an older server after a
// rollback, or a viewer with no channel) freeze the view for good.
export const DEEP_FETCH_TIMEOUT_MS = 6000

export interface DeepFetchInput {
  // The reader's own seek reached the oldest row xterm holds.
  atTop: boolean
  // The reveal gate is holding the screen: a replay is being written.
  covered: boolean
  // buffer.active.type === 'alternate': a full-screen app keeps its own history.
  alternate: boolean
  // The app takes the mouse wheel (see appTakesWheel): scrolling is its own.
  appTakesWheel: boolean
  // One deep fetch per xterm, whatever happened to it.
  alreadyAsked: boolean
  // The fetch is in flight.
  pending: boolean
  // What the cold paint delivered: buffer.baseY and the grid's rows.
  scrollbackRows: number
  rows: number
  // The amount the cold attach asked for.
  cold: number
}

// A seek to the top is the only trigger, and only when the core may hold more:
// never while covered (the replay is not written), never on the alternate
// screen, never when the program owns the wheel, and never twice.
export function shouldFetchDeep(i: DeepFetchInput): boolean {
  return i.atTop
    && !i.covered
    && !i.alternate
    && !i.appTakesWheel
    && !i.alreadyAsked
    && !i.pending
    && coreMayHoldMore(i.scrollbackRows, i.rows, i.cold)
}

// The core was cut off at the cold amount when the paint filled the scrollback
// it was asked for. A paint that ended earlier means the core held nothing
// older, so there is nothing to fetch. The core keeps 5 MiB per terminal, so
// this is "may hold more", never a promise.
export function coreMayHoldMore(scrollbackRows: number, rows: number, cold: number): boolean {
  return scrollbackRows > 0 && scrollbackRows + rows >= cold
}

// The reader's row, measured from the live tail: an integer buffer distance
// that survives the deep paint, unlike a buffer coordinate.
export function restoreFromBottom(baseY: number, viewportY: number): number {
  return Math.max(0, baseY - viewportY)
}

// The window top to restore after the deep paint: the same distance from the
// new tail. Clamped to the oldest row the new buffer holds.
export function viewForRestore(newBaseY: number, fromBottom: number): number {
  return Math.max(0, newBaseY - Math.max(0, fromBottom))
}
