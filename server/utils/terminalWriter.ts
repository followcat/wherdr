import type { Writable } from 'node:stream'

// Ordered stdin writer for the Herdr child. `write()` returning false means
// the kernel buffer is full — the chunk WAS accepted and must never be sent
// again; only later chunks wait for 'drain'.
//
// A queued chunk carries enough of its own lifecycle to be revoked before
// submission:
//   tag        — caller-defined handle (e.g. scroll phase/direction) matched
//                by cancelWhere(); unsubmitted work stays cancellable
//   expiresAt  — deadline; an expired chunk is dropped, never written
//   expendable — may be shed when the queue is full (scroll commands only:
//                superseded by the next gesture)
//   onSubmit   — the chunk entered the stream (delivery accounting point)
//   onFlush    — the stream's write callback fired (kernel accepted it)
// Protected input is never silently deleted: a queue holding only protected
// chunks still accepts more — the real bound on a stalled pipe is the
// session dying, not keystrokes vanishing mid-type. Past `maxProtected`
// chunks the pipe is pronounced dead and destroyed loudly instead.
export function createTerminalWriter(stream: Writable, { maxPending = 256, maxProtected = 8192 }: { maxPending?: number, maxProtected?: number } = {}) {
  type Entry = {
    data: string, expendable?: boolean, tag?: unknown, expiresAt?: number
    onSubmit?: () => void, onFlush?: (err?: Error | null) => void
  }
  let pending: Entry[] = []
  let blocked = false
  let dead = false
  const pump = () => {
    while (pending.length && !blocked && !dead) {
      const entry = pending[0]!
      // A chunk past its own deadline was never submitted — drop it rather
      // than deliver stale scroll work late.
      if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) { pending.shift(); continue }
      pending.shift()
      const ok = stream.write(entry.data, entry.onFlush)
      entry.onSubmit?.()
      if (!ok) blocked = true
    }
    if (dead) pending = []
  }
  const onDrain = () => { blocked = false; pump() }
  stream.on('drain', onDrain)
  return {
    write(data: string, opts?: { expendable?: boolean, tag?: unknown, expiresAt?: number, onSubmit?: () => void, onFlush?: (err?: Error | null) => void } | ((err?: Error | null) => void)) {
      if (dead) return
      const { expendable, tag, expiresAt, onSubmit, onFlush } = typeof opts === 'function' ? { onFlush: opts } as Entry : (opts ?? {})
      // FIFO: anything already waiting must go first, even if this write
      // would still fit.
      if (blocked || pending.length) {
        if (pending.length >= maxPending) {
          // Shed only what is safe to lose. An incoming expendable chunk is
          // dropped before protected input is evicted; protected input is
          // never silently deleted — a pipe stalled past maxProtected is
          // dead and is destroyed loudly, not kept eating keystrokes.
          const expendableAt = pending.findIndex(p => p.expendable)
          if (expendableAt >= 0) pending.splice(expendableAt, 1)
          else if (expendable) return
          else if (pending.length >= maxProtected) { dead = true; pending = []; stream.destroy() ; return }
        }
        pending.push({ data, expendable, tag, expiresAt, onSubmit, onFlush })
        return
      }
      // The direct path honors the same deadline: stale scroll work is
      // never submitted, queued or not.
      if (expiresAt !== undefined && expiresAt <= Date.now()) return
      const ok = stream.write(data, onFlush)
      onSubmit?.()
      if (!ok) blocked = true
    },
    // Drop queued, never-submitted chunks matching the predicate — e.g. all
    // scroll work on a full cancel, or only momentum on a phase cancel.
    // Chunks already in the stream are past revocation by definition.
    cancelWhere(drop: (entry: { expendable?: boolean, tag?: unknown }) => boolean) {
      pending = pending.filter(p => !drop(p))
    },
    // Queued-but-unwritten chunks vanish with the pipe; already-submitted
    // ones are never replayed. Removes the drain listener too.
    dispose() { dead = true; pending = []; stream.off('drain', onDrain) },
    pendingCount: () => pending.length,
  }
}
