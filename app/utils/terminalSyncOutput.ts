// DEC Mode 2026, synchronized output, for the terminal stream.
//
// A program that supports it brackets a complete repaint between CSI ? 2026 h
// and CSI ? 2026 l, so a capable terminal swaps from the previous frame to the
// new one in one step. @xterm/xterm 5.5 ignores the mode, and herdr-core relays
// the program's bytes in arbitrary chunks: fed straight to xterm, an
// Antigravity (`agy`) resize repaint (`\x1b[2J\x1b[3J\x1b[H`, then hundreds of
// lines) scrolls the whole conversation down the screen before it settles.
//
// This gate keeps the bytes of an open frame back and hands the complete frame
// to the writer at once, in wire order. Two more details of real streams:
// - the marker itself can be split across chunks, so a trailing prefix of
//   `\x1b[?2026` waits for the next chunk to resolve it (`h`, `l`, or another
//   sequence such as `\x1b[?2004h`);
// - a clear (`\x1b[2J\x1b[3J\x1b[H` or `\x1b[H\x1b[2J\x1b[3J`) often arrives at
//   the end of its own chunk, right before the frame's `h`: holding it briefly
//   lets the clear and the frame reach xterm in a single write, without the
//   blank screen (and scroll-to-top) between the two.
//
// Two bounds keep a broken or hostile program from freezing the terminal: an
// unclosed frame is flushed after SYNC_OUTPUT_TIMEOUT_MS, and a frame holding
// more than SYNC_OUTPUT_MAX_BYTES is flushed at once.
export const SYNC_OUTPUT_TIMEOUT_MS = 1000
export const SYNC_OUTPUT_MAX_BYTES = 1024 * 1024
export const CLEAR_HOLD_MS = 32

export interface SyncOutputMeta {
  width?: number
  height?: number
  reset?: boolean
}

export interface SyncOutputWrites {
  // Write one complete run of bytes to xterm. `done` runs once xterm has
  // written them (its own write callback).
  write: (bytes: Uint8Array, meta: SyncOutputMeta, done: () => void) => void
  // Bytes are now held behind a marker: the flow-control credit of the chunk
  // that carried them can be returned now (the caller does so itself).
  onHold?: () => void
  // Held bytes have been handed to a write (or dropped by reset()).
  onDrain?: () => void
}

export interface SyncOutputOptions {
  timeoutMs?: number
  maxBytes?: number
  clearHoldMs?: number
}

export interface SyncPushResult {
  // Bytes of this chunk still held after the push.
  held: number
}

const ESC = 0x1b
const CR = 0x0d
const OPEN = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68]) // \x1b[?2026h
const CLOSE = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c]) // \x1b[?2026l
// \x1b[2J\x1b[3J\x1b[H and \x1b[H\x1b[2J\x1b[3J
const CLEARS = [
  new Uint8Array([0x1b, 0x5b, 0x32, 0x4a, 0x1b, 0x5b, 0x33, 0x4a, 0x1b, 0x5b, 0x48]),
  new Uint8Array([0x1b, 0x5b, 0x48, 0x1b, 0x5b, 0x32, 0x4a, 0x1b, 0x5b, 0x33, 0x4a]),
]

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const last = hay.length - needle.length
  for (let i = Math.max(0, from); i <= last; i++) {
    let k = 0
    while (k < needle.length && hay[i + k] === needle[k]) k++
    if (k === needle.length) return i
  }
  return -1
}

function startsWith(hay: Uint8Array, at: number, needle: Uint8Array): boolean {
  if (hay.length - at < needle.length) return false
  for (let k = 0; k < needle.length; k++) if (hay[at + k] !== needle[k]) return false
  return true
}

// What starts at `at`: a complete open marker, a prefix of one that may still
// be completed by the next chunk, or neither.
function openAt(data: Uint8Array, at: number): 'full' | 'partial' | 'none' {
  const rest = data.length - at
  if (rest <= 0) return 'none'
  if (rest >= OPEN.length) return startsWith(data, at, OPEN) ? 'full' : 'none'
  for (let k = 0; k < rest; k++) if (data[at + k] !== OPEN[k]) return 'none'
  return 'partial'
}

// Longest suffix of data[from..] that is a proper prefix of the open marker.
function splitPrefixAt(data: Uint8Array, from: number): number {
  const max = Math.min(OPEN.length - 1, data.length - from)
  for (let len = max; len > 0; len--) {
    const at = data.length - len
    let ok = true
    for (let k = 0; k < len; k++) if (data[at + k] !== OPEN[k]) { ok = false; break }
    if (ok) return at
  }
  return -1
}

// Start of a clear sequence that ends exactly at `end` (with an optional `\r`
// before it), or -1. Never before `from`.
function clearEndingAt(data: Uint8Array, from: number, end: number): number {
  for (const seq of CLEARS) {
    for (const extra of [1, 0]) {
      const start = end - seq.length - extra
      if (start < from) continue
      if (extra && data[start] !== CR) continue
      let ok = true
      for (let k = 0; k < seq.length; k++) if (data[start + extra + k] !== seq[k]) { ok = false; break }
      if (ok) return start
    }
  }
  return -1
}

// Start of a clear sequence that ends the buffer at or after `from`, or -1.
function trailingClearAt(data: Uint8Array, from: number): number {
  return clearEndingAt(data, from, data.length)
}

interface Release {
  bytes: Uint8Array
  meta: SyncOutputMeta
  callbacks: (() => void)[]
}

export function createSyncOutput(hooks: SyncOutputWrites, options: SyncOutputOptions = {}) {
  const timeoutMs = options.timeoutMs ?? SYNC_OUTPUT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? SYNC_OUTPUT_MAX_BYTES
  const clearHoldMs = options.clearHoldMs ?? CLEAR_HOLD_MS

  // An open frame, or not.
  let mode: 'idle' | 'frame' = 'idle'
  let holdParts: Uint8Array[] = []
  let holdLen = 0
  let holdMeta: SyncOutputMeta = {}
  // A clear kept until the next chunk says whether a frame follows it.
  let clear: Uint8Array | null = null
  let clearMeta: SyncOutputMeta = {}
  // A trailing split marker prefix, resolved by the next chunk.
  let tail: Uint8Array | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let timerKind: 'frame' | 'clear' | null = null
  // Pushes that left bytes held (for the caller's cover accounting).
  let heldPushes = 0
  let disposed = false

  function stopTimer() {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    timerKind = null
  }
  function armTimer(kind: 'frame' | 'clear', ms: number) {
    stopTimer()
    timerKind = kind
    timer = setTimeout(onTimer, ms)
  }
  function onTimer() {
    timer = undefined
    const kind = timerKind
    timerKind = null
    if (disposed) return
    const events: Release[] = []
    if (kind === 'frame') { mode = 'idle'; releaseHold(events) }
    else if (kind === 'clear') flushClear(events)
    issueAll(events)
  }

  function appendHold(bytes: Uint8Array, meta: SyncOutputMeta) {
    if (!bytes.length) return
    if (holdLen === 0) holdMeta = meta
    holdParts.push(bytes)
    holdLen += bytes.length
  }
  // Bytes of a split marker kept aside for the next chunk.
  function tailLen() {
    return tail?.length ?? 0
  }
  function releaseHold(events: Release[]) {
    // A frame that ends on a split close marker keeps that prefix aside: the
    // frame is released only with those bytes, in order.
    if (holdLen > 0 && tail) { appendHold(tail, holdMeta); tail = null }
    if (holdLen === 0) return
    const bytes = concat(holdParts)
    holdParts = []
    holdLen = 0
    events.push({ bytes, meta: holdMeta, callbacks: [] })
    if (heldPushes) { heldPushes = 0; hooks.onDrain?.() }
  }
  function emit(bytes: Uint8Array, meta: SyncOutputMeta, events: Release[]) {
    if (!bytes.length) return
    events.push({ bytes, meta, callbacks: [] })
  }
  function flushClear(events: Release[]) {
    if (!clear) return
    emit(clear, clearMeta, events)
    clear = null
    if (timerKind === 'clear') stopTimer()
  }
  function issueAll(events: Release[]) {
    for (const ev of events) {
      if (disposed) return
      hooks.write(ev.bytes, ev.meta, () => {
        for (const cb of ev.callbacks) cb()
      })
    }
  }

  function scan(bytes: Uint8Array, meta: SyncOutputMeta, events: Release[]) {
    let data = bytes
    if (tail) {
      data = concat([tail, bytes])
      tail = null
    }
    const n = data.length
    if (!n) return

    // A clear held between chunks: a frame opening here takes it in (one
    // write); anything else proves there is none, so it goes first.
    if (mode === 'idle' && clear) {
      const kind = openAt(data, 0)
      if (kind === 'full') {
        stopTimer()
        appendHold(clear, meta)
        clear = null
      } else if (kind === 'partial') {
        tail = data.slice()
        return
      } else {
        flushClear(events)
      }
    }

    let i = 0
    while (i < n && !disposed) {
      if (mode === 'frame') {
        const close = indexOfBytes(data, CLOSE, i)
        if (close >= 0) {
          appendHold(data.subarray(i, close + CLOSE.length), meta)
          i = close + CLOSE.length
          mode = 'idle'
          stopTimer()
          releaseHold(events)
          continue
        }
        // The close marker can be split across chunks. Its first 7 bytes are
        // the shared `\x1b[?2026` prefix, so keep a trailing prefix aside and
        // let the next chunk resolve it (here or as another sequence such as
        // `\x1b[?2004h`).
        const prefix = splitPrefixAt(data, i)
        if (prefix >= 0 && holdLen + (data.length - i) < maxBytes) {
          appendHold(data.subarray(i, prefix), meta)
          tail = data.slice(prefix)
          armTimer('frame', timeoutMs)
          return
        }
        appendHold(data.subarray(i), meta)
        if (holdLen + tailLen() >= maxBytes) {
          stopTimer()
          mode = 'idle'
          releaseHold(events)
        } else {
          armTimer('frame', timeoutMs)
        }
        return
      }

      const open = indexOfBytes(data, OPEN, i)
      if (open < 0) {
        // Nothing opens a frame here; the end may still be a clear (held for a
        // possible frame) or a split marker prefix.
        const from = trailingClearAt(data, i)
        if (from >= 0) {
          emit(data.subarray(i, from), meta, events)
          clear = data.slice(from)
          clearMeta = meta
          armTimer('clear', clearHoldMs)
          return
        }
        const prefix = splitPrefixAt(data, i)
        if (prefix >= 0) {
          emit(data.subarray(i, prefix), meta, events)
          tail = data.slice(prefix)
          return
        }
        emit(data.subarray(i), meta, events)
        return
      }

      // A clear right before the open joins the frame: one write, no gap.
      const clearFrom = clearEndingAt(data, i, open)
      if (clearFrom >= 0) {
        emit(data.subarray(i, clearFrom), meta, events)
        appendHold(data.subarray(clearFrom, open), meta)
      } else {
        emit(data.subarray(i, open), meta, events)
      }
      appendHold(data.subarray(open, open + OPEN.length), meta)
      mode = 'frame'
      armTimer('frame', timeoutMs)
      i = open + OPEN.length
    }
  }

  function push(bytes: Uint8Array, meta: SyncOutputMeta, done?: () => void): SyncPushResult {
    if (disposed || !bytes.length) {
      done?.()
      return { held: 0 }
    }
    // The stream is at another size or a new paint owns it: what is held
    // belongs before it, so it goes out now.
    if (holdLen > 0 && !sameMeta(holdMeta, meta)) {
      const events: Release[] = []
      mode = 'idle'
      stopTimer()
      releaseHold(events)
      issueAll(events)
    }
    const events: Release[] = []
    scan(bytes, meta, events)
    // A frame resting on a split marker prefix holds those bytes too.
    const held = holdLen + (mode === 'frame' ? tailLen() : 0)
    if (held > 0) {
      // Credited now: waiting for `l` must never stall the server's window.
      done?.()
      heldPushes++
      hooks.onHold?.()
    } else if (events.length) {
      events[events.length - 1]!.callbacks.push(() => done?.())
    } else {
      done?.()
    }
    issueAll(events)
    return { held }
  }

  // Forget held bytes without writing (a new stream owns the terminal).
  function reset() {
    stopTimer()
    mode = 'idle'
    holdParts = []
    holdLen = 0
    holdMeta = {}
    clear = null
    clearMeta = {}
    tail = null
    if (heldPushes) { heldPushes = 0; hooks.onDrain?.() }
  }

  return {
    push,
    // Hand everything held to the writer now, in wire order.
    flush() {
      const events: Release[] = []
      flushClear(events)
      if (mode === 'frame' || holdLen > 0) {
        mode = 'idle'
        stopTimer()
        releaseHold(events)
      }
      issueAll(events)
    },
    reset,
    pending: () => holdLen + (clear?.length ?? 0) + (tail?.length ?? 0),
    isHolding: () => holdLen > 0 || (mode === 'frame' && tailLen() > 0),
    dispose() {
      disposed = true
      reset()
    },
  }
}

function sameMeta(a: SyncOutputMeta, b: SyncOutputMeta): boolean {
  return a.width === b.width && a.height === b.height && Boolean(a.reset) === Boolean(b.reset)
}

export type SyncOutput = ReturnType<typeof createSyncOutput>
