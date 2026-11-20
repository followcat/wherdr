// Applies one terminal.frame to xterm in stream order.
// xterm parses written bytes later, but resize() and reset() act at once: called
// directly, a resize that arrives right after a paint lands before that paint is
// parsed. Core's exact paint (drawn at the old width, ending with an absolute
// cursor move) is then parsed at the new width, its long lines wrap, the cursor
// lands on an output line and the shell's prompt redraw overwrites it. Queuing
// both behind the earlier writes keeps xterm's screen equal to core's.
export interface FrameTerminal {
  readonly cols: number
  readonly rows: number
  resize(cols: number, rows: number): void
  reset(): void
  write(data: string | Uint8Array, callback?: () => void): void
}

export interface TerminalFrame {
  width?: number
  height?: number
  // Core repaints the screen and its history: start from a clean terminal.
  reset?: boolean
  bytes: Uint8Array
}

// `reset` runs right after term.reset(), in stream order.
export function writeTerminalFrame(term: FrameTerminal, frame: TerminalFrame, hooks: { resized?: () => void, reset?: () => void, written?: () => void } = {}) {
  const { width, height } = frame
  if ((width && height) || frame.reset) {
    term.write('', () => {
      if (width && height && (width !== term.cols || height !== term.rows)) {
        term.resize(width, height)
        hooks.resized?.()
      }
      if (frame.reset) { term.reset(); hooks.reset?.() }
    })
  }
  term.write(frame.bytes, hooks.written)
}
