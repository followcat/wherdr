// Reveal gate of a core attach's replay.
//
// herdr-core paints an attach as a soft reset, the retained history and the
// screen, and sends it as several DATA frames with no end marker (see
// server/utils/coreTerm.ts). Rendering those pieces as they arrive shows the
// blank screen after the reset, then a partly written history scrolling down
// to the tail. The gate keeps the terminal covered from the attach's
// `full: true` frame until xterm has written every queued frame and no new one
// has arrived for `quietMs`, bounded by `maxMs` so a program that prints
// nonstop is still shown.
export const REVEAL_QUIET_MS = 150
export const REVEAL_MAX_MS = 2000

export interface RevealGateHooks {
  // A replay starts: the view covers the terminal.
  onBegin?: () => void
  // The replay is over: the view uncovers it and takes its position once.
  onReveal: () => void
}

export interface RevealTiming {
  quietMs?: number
  maxMs?: number
}

export function createRevealGate(hooks: RevealGateHooks, timing: RevealTiming = {}) {
  const quietMs = timing.quietMs ?? REVEAL_QUIET_MS
  const maxMs = timing.maxMs ?? REVEAL_MAX_MS
  let covering = false
  // Frames handed to xterm whose write callback has not run yet.
  let queued = 0
  let quiet: ReturnType<typeof setTimeout> | undefined
  let bound: ReturnType<typeof setTimeout> | undefined

  function stop() {
    if (quiet !== undefined) clearTimeout(quiet)
    if (bound !== undefined) clearTimeout(bound)
    quiet = undefined
    bound = undefined
  }
  function reveal() {
    if (!covering) return
    covering = false
    queued = 0
    stop()
    hooks.onReveal()
  }
  function armQuiet() {
    if (quiet !== undefined) clearTimeout(quiet)
    quiet = setTimeout(() => {
      quiet = undefined
      if (queued === 0) reveal()
    }, quietMs)
  }

  return {
    isCovering: () => covering,
    // A full repaint starts (or restarts) the hold.
    begin() {
      queued = 0
      if (!covering) {
        covering = true
        hooks.onBegin?.()
      }
      if (bound !== undefined) clearTimeout(bound)
      bound = setTimeout(reveal, maxMs)
      armQuiet()
    },
    // A frame's bytes are queued in xterm; nothing has been written yet.
    pushed() {
      if (!covering) return
      queued++
      if (quiet !== undefined) {
        clearTimeout(quiet)
        quiet = undefined
      }
    },
    // xterm finished writing a frame: the quiet period starts once the last
    // queued write has landed, and the next frame postpones it.
    written() {
      if (!covering) return
      if (queued > 0) queued--
      if (queued === 0) armQuiet()
    },
    // A new socket, a reset or a disposed view owns its own paint.
    cancel() {
      covering = false
      queued = 0
      stop()
    },
  }
}

export type RevealGate = ReturnType<typeof createRevealGate>
