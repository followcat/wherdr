import { READ_LIMIT, type MachineFs } from './fsx'

// Captured-generation raw IO for a Command Code transcript file. Every
// answer is bound to the generation stamp it was issued under and covers
// exactly the bytes asked for: anything less — a failed read, a short
// body, or a record replaced while the request was in flight — is
// *unknown*, never a page to parse, an anchor to mint, or proof of a
// rewrite. The caller decides what unknown means for its path (hold the
// trusted state and retry; never advance an epoch on it).

export interface CommandCodeIo {
  // Is `stamp` still the file's current generation stamp? Checked before
  // and after every awaited read; cheap enough to guard every publish.
  live(file: string, stamp: number): boolean
  // `fs.read` answering only with the bytes asked for, under `stamp` —
  // null when the answer is unknown (failed, short, or detached in
  // flight). The returned buffer is the raw bytes: callers fingerprint
  // against it directly, never a re-encoded copy.
  readExact(file: string, start: number, len: number, stamp: number): Promise<Buffer | null>
}

// One context per `stampOf` source — the state service shares its own, so
// readers and its validation speak of the same generations.
export function commandCodeIo({ fs, stampOf }: { fs: MachineFs, stampOf: (file: string) => number }): CommandCodeIo {
  // A captured generation is a positive safe-integer stamp. `stampOf`
  // answers 0 for a file with no record, so comparing blindly would let
  // "unproven" pass for a live stamp — and issue reads bound to nothing.
  const live = (file: string, stamp: number) =>
    Number.isSafeInteger(stamp) && stamp > 0 && stampOf(file) === stamp

  // A range must never become an IO attempt by itself: `localFs` would
  // Buffer.alloc before the read fails, and an oversized request only meets
  // the remote ceiling after the exec. Same 60 MiB as bounded transports —
  // the chat windows are still 24 MiB at their own call sites.
  const valid = (start: number, len: number) =>
    Number.isSafeInteger(start) && start >= 0 &&
    Number.isSafeInteger(len) && len >= 0 && len <= READ_LIMIT &&
    Number.isSafeInteger(start + len)

  async function readExact(file: string, start: number, len: number, stamp: number): Promise<Buffer | null> {
    if (!live(file, stamp) || !valid(start, len)) return null
    let buf: Buffer
    try { buf = await fs.read(file, start, len) }
    catch { return null }
    return live(file, stamp) && buf.length === len ? buf : null
  }
  return { live, readExact }
}
