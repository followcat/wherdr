import type { Writable } from 'node:stream'

// Ordered writer for the Herdr child stdin. Node's write() returning false
// means the kernel buffer is full — the chunk itself is already queued and
// MUST NOT be resent; only later writes wait for 'drain'. Keeps every
// callback attached so 'flushed' stages stay honest under backpressure.
export function createTerminalWriter(stream: Writable) {
  let pending: { data: string, cb?: () => void }[] = []
  let blocked = false
  let dead = false
  const pump = () => {
    while (pending.length && !blocked && !dead) {
      const { data, cb } = pending.shift()!
      if (!stream.write(data, cb)) blocked = true
    }
    if (dead) pending = []
  }
  stream.on('drain', () => { blocked = false; pump() })
  return {
    write(data: string, cb?: () => void) {
      if (dead) return
      // FIFO: anything already waiting must go first, even if this write
      // would still fit.
      if (blocked || pending.length) { pending.push({ data, cb }); return }
      if (!stream.write(data, cb)) blocked = true
    },
    // Queued-but-unwritten chunks vanish with the pipe; already-submitted
    // ones are never replayed.
    dispose() { dead = true; pending = [] },
    pendingCount: () => pending.length,
  }
}
