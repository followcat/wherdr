// Rate limit of terminal.scroll towards Herdr.
// When the program tracks the mouse (Codex 0.16x does, on its main screen),
// Herdr turns each terminal.scroll into one wheel report written to the
// program's terminal (`ESC [ < 65 ; col ; row M`, whatever `lines` says).
// A trackpad flick gives one scroll per animation frame: 60 reports a second.
// If the program is slow to read them, they pile up in the tty's input
// buffer (about 1 KB on macOS, 4 KB on Linux) and a read can end right
// after the ESC of a report: Codex takes that lone ESC for the Escape key,
// interrupts its turn, and types the rest ("[<65;76;23M") into its field.
// Scrolls are therefore merged and sent at most every SCROLL_MS: a gesture
// stays a few hundred bytes, far from the buffer's size. In the pane's own
// history (program without the mouse), the merged lines keep the distance.
export const SCROLL_MS = 75
const MAX_LINES = 500

export interface ScrollThrottle {
  push: (direction: 'up' | 'down', lines: number) => void
  // Drop queued lines without sending (touch interrupted by typing).
  cancel: () => void
  dispose: () => void
}

export function createScrollThrottle(
  send: (direction: 'up' | 'down', lines: number) => void,
  { intervalMs = SCROLL_MS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }: {
    intervalMs?: number
    now?: () => number
    setTimer?: (fn: () => void, ms: number) => unknown
    clearTimer?: (t: never) => void
  } = {},
): ScrollThrottle {
  let net = 0 // lines, positive = up
  let last = -Infinity
  let timer: unknown = null
  const flush = () => {
    timer = null
    if (!net) return
    send(net > 0 ? 'up' : 'down', Math.min(Math.abs(net), MAX_LINES))
    net = 0
    last = now()
  }
  const cancel = () => {
    if (timer) clearTimer(timer as never)
    timer = null
    net = 0
  }
  return {
    push(direction, lines) {
      net += direction === 'up' ? lines : -lines
      if (timer) return
      const wait = last + intervalMs - now()
      if (wait <= 0) flush()
      else timer = setTimer(flush, wait)
    },
    cancel,
    dispose: cancel,
  }
}
