import type { Writable } from 'node:stream'

// Ordered writer for the Herdr child stdin. Node's write() returning false
// means the kernel buffer is full — the chunk itself is already queued and
// MUST NOT be resent; only later writes wait for 'drain'.
//
// Two facts per chunk, reported honestly:
//   onSubmit — the chunk actually entered the stream (stream.write ran)
//   onFlush  — the stream's write callback fired (kernel accepted it)
// A chunk still inside THIS queue has not been submitted: callers must not
// advance delivery accounting for it.
export function createTerminalWriter(stream: Writable, { maxPending = 256 }: { maxPending?: number } = {}) {
  let pending: { data: string, expendable?: boolean, onSubmit?: () => void, onFlush?: (err?: Error | null) => void }[] = []
  let blocked = false
  let dead = false
  const pump = () => {
    while (pending.length && !blocked && !dead) {
      const { data, onSubmit, onFlush } = pending.shift()!
      const ok = stream.write(data, onFlush)
      onSubmit?.()
      if (!ok) blocked = true
    }
    if (dead) pending = []
  }
  const onDrain = () => { blocked = false; pump() }
  stream.on('drain', onDrain)
  return {
    write(data: string, opts?: { expendable?: boolean, onSubmit?: () => void, onFlush?: (err?: Error | null) => void } | ((err?: Error | null) => void)) {
      if (dead) return
      const { expendable, onSubmit, onFlush } = typeof opts === 'function' ? { expendable: undefined, onSubmit: undefined, onFlush: opts } : (opts ?? {})
      // FIFO: anything already waiting must go first, even if this write
      // would still fit.
      if (blocked || pending.length) {
        // A stalled child must not grow memory without bound. When the
        // bound hits, shed what is safe to lose first — scroll commands are
        // superseded by the next gesture; typed input, resizes and mouse
        // releases are not.
        if (pending.length >= maxPending) {
          const expendableAt = pending.findIndex(p => p.expendable)
          if (expendableAt >= 0) pending.splice(expendableAt, 1)
          else if (expendable) return // drop the incoming scroll, keep input
          else pending.shift() // hard bound: everything queued is protected
        }
        pending.push({ data, expendable, onSubmit, onFlush })
        return
      }
      const ok = stream.write(data, onFlush)
      onSubmit?.()
      if (!ok) blocked = true
    },
    // Queued-but-unwritten chunks vanish with the pipe; already-submitted
    // ones are never replayed. Removes the drain listener too.
    dispose() { dead = true; pending = []; stream.off('drain', onDrain) },
    pendingCount: () => pending.length,
  }
}
