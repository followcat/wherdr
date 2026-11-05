import { createHash } from 'node:crypto'

// Fingerprint of a parsed result record: its absolute "start:length"
// position and a digest of its first bytes — enough to spot an in-place
// rewrite of output already shown, without keeping the record.
export type CommandCodeWatch = { at: number, len: number, hash: string }

// Only the sampled prefix is read: a huge result never exceeds the budget.
const WATCH_BYTES = 64 * 1024
// One read covers the newest watched records fitting this span.
const WATCH_SPAN = 4 * 1024 * 1024

// A watch whose positions can't be trusted can't prove anything — safe
// integers, non-negative, and a sampled end inside the number line (same
// grammar as the parser's revision rule, plus the end bound).
const watchOk = (at: number, len: number) =>
  Number.isSafeInteger(at) && at >= 0 && Number.isSafeInteger(len) && len >= 0
  && Number.isSafeInteger(at + Math.min(len, WATCH_BYTES))

// Registration-time bound for a watch record: the same position arithmetic
// fingerprints obey, so a watch can't claim a sample that can't exist.
export const validWatch = (w: CommandCodeWatch): boolean => watchOk(w.at, w.len)

// Fingerprint of a result record's raw line, built before its base64 is
// stripped: exactly the record's own sample — min(len, WATCH_BYTES) bytes —
// is hashed. `raw` must hold them (a bounded prefix of a giant line is
// enough); bytes after the record never leak in, and no multi-MiB string
// round-trip or retained payload is involved.
export function watchFingerprint(raw: Uint8Array, at: number, len: number): CommandCodeWatch | null {
  if (!watchOk(at, len)) return null
  const n = Math.min(len, WATCH_BYTES)
  if (raw.length < n) return null
  return { at, len, hash: createHash('sha256').update(raw.subarray(0, n)).digest('hex').slice(0, 16) }
}

const sampleLen = (w: CommandCodeWatch) => Math.min(w.len, WATCH_BYTES)

// One parsed result position as the incremental parser reports it: the
// record's absolute byte offset and its raw line length — never the bytes.
export type CommandCodeResultRef = { id: string, at: number, len: number }

// Bounded raw fingerprints for a drain of parsed result positions: only
// slices of `buf` — the bytes the reader already holds, `base` being the
// absolute offset of buf[0] — are hashed, never a re-encoded copy of a
// multi-MiB line. A giant record keeps its bounded prefix sample. A
// position outside coverage or with unsafe arithmetic is skipped: an
// unwatched record is weaker validation, never half-trusted.
export function fingerprintRefs(buf: Uint8Array, base: number, refs: Iterable<CommandCodeResultRef>): (CommandCodeWatch & { id: string })[] {
  const out: (CommandCodeWatch & { id: string })[] = []
  if (!Number.isSafeInteger(base) || base < 0) return out
  // One record position may serve many ids (a shared-result line): hash
  // each distinct record's sample once — never once per id.
  const byPos = new Map<string, CommandCodeWatch | null>()
  for (const r of refs) {
    if (!Number.isSafeInteger(r.at) || !Number.isSafeInteger(r.len) || r.at < base || r.len < 0) continue
    const off = r.at - base
    const n = Math.min(r.len, WATCH_BYTES)
    if (!Number.isSafeInteger(off + n) || off + n > buf.length) continue
    const key = `${r.at}:${r.len}`
    let w = byPos.get(key)
    if (w === undefined) {
      w = watchFingerprint(buf.subarray(off, off + n), r.at, r.len)
      byPos.set(key, w)
    }
    if (w) out.push({ id: r.id, ...w })
  }
  return out
}

// The one bounded read validating a file's watch set: identical
// fingerprints collapse, positions sort ascending, and when the whole
// span exceeds WATCH_SPAN only the newest records that fit are selected —
// measured against the fixed end, since adjacent records may be close
// while the watched span is much larger. Unverifiable watches (bad
// positions) never reach the caller. null: nothing watchable.
export function watchSpan(watches: Iterable<CommandCodeWatch>): { start: number, end: number, selected: CommandCodeWatch[] } | null {
  const records = new Map<string, CommandCodeWatch>()
  for (const w of watches) if (watchOk(w.at, w.len)) records.set(`${w.at}:${w.len}:${w.hash}`, w)
  if (!records.size) return null
  const all = [...records.values()].sort((a, b) => a.at - b.at)
  let first = all[0]!.at
  const last = all[all.length - 1]!
  const end = last.at + sampleLen(last)
  let selected = all
  if (end - first > WATCH_SPAN) {
    let i = all.length - 1
    while (i > 0 && end - all[i - 1]!.at <= WATCH_SPAN) i--
    selected = all.slice(i)
    first = selected[0]!.at
  }
  return { start: first, end, selected }
}

// Fingerprint check over the buffer [first, first+buf.length): true when
// every selected record still matches, false on a changed byte, null when
// the buffer can't supply a record's sample — a short read is unknown,
// not valid, and not a rewrite either.
export function verifyWatches(buf: Uint8Array, first: number, selected: readonly CommandCodeWatch[]): boolean | null {
  for (const w of selected) {
    const from = w.at - first
    const n = sampleLen(w)
    if (from < 0 || from + n > buf.length) return null
    const h = createHash('sha256').update(buf.subarray(from, from + n)).digest('hex').slice(0, 16)
    if (h !== w.hash) return false
  }
  return true
}
