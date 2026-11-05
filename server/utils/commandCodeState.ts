import type { FsStat, MachineFs } from './fsx'
import type { CommandCodeResult } from './transcripts'
import { commandCodeIo } from './commandCodeIo'
import { validWatch, verifyWatches, watchSpan, type CommandCodeWatch } from './commandCodeWatch'

// Per-machine bounds: files a reader tracks, entries a file remembers, and
// distinct observations it may have in flight.
const FILE_MAX = 64
const ENTRY_MAX = 4096
const PENDING_MAX = 64
// The parser's command-id contract: nonempty, at most 128 UTF-8 bytes.
const CMD_ID_MAX = 128

// Same formula as transcripts' genOf: another inode or another modification
// microsecond is another generation.
const genOf = (st: FsStat) => `${st.ino ? `${st.ino}-` : ''}${Math.round(st.mtimeMs * 1000)}`

// One record per generation: invalidation mints a fresh record and leaves
// the old one orphaned, so every handle taken before it writes into
// detached state — no stale callback can reach the live maps.
interface CmdFile {
  size: number
  gen: string
  ino?: number
  // Invalidation stamp, monotone within this reader: a forgotten record is
  // never reissued, so no old token can compare current again after its
  // file's entry was dropped (the evictable epoch tombstone of v2).
  stamp: number
  // A trusted size/gen exists only after one complete observation.
  observed: boolean
  results: Map<string, CommandCodeResult>
  watches: Map<string, CommandCodeWatch>
}

export interface CommandCodeObservation {
  // The stat to trust as the file's current state — null when the
  // observation is unknown (its validation failed/was short) or aborted
  // (the record it validated was replaced mid-IO). Never publish a null
  // stat: hold the previous trusted state and retry next observation.
  st: FsStat | null
  stamp: number
  // The file's state was created or replaced: the integration purges its
  // per-file caches (parseCache, retained windows, model, preview).
  invalidated: boolean
}

// One generation's maps, bound at capture. Writes through a handle whose
// stamp no longer matches stampOf(file) land on an orphaned record.
export interface CommandCodeFileHandle {
  stamp: number
  results: Map<string, CommandCodeResult>
  watch(id: string, w: CommandCodeWatch): void
}

// File-scoped Command Code state for one reader (one machine's
// createTranscripts): cross-page result maps, result-record watches, the
// last trusted file state and the invalidation stamps clients carry.
// Tokens are only ever read, never written: a stale token cannot change
// authoritative state — disk evidence decides.
export function createCommandCodeState({ fs }: { fs: MachineFs }) {
  const files = new Map<string, CmdFile>()
  const pending = new Map<string, Promise<CommandCodeObservation>>()
  let nextStamp = 0
  // Reader nonce: a restart drops every map, so a token must carry it — a
  // page parsed before the restart no longer has its remembered results.
  const reader = Math.random().toString(36).slice(2, 10)

  const fresh = (): CmdFile => ({ size: 0, gen: '', stamp: ++nextStamp, observed: false, results: new Map(), watches: new Map() })

  function fileFor(file: string): CmdFile {
    let s = files.get(file)
    if (!s) {
      s = fresh()
      files.set(file, s)
      // The evicted file's entry is gone entirely: its next observation is a
      // fresh entry with a new stamp, so only its own clients rebuild.
      if (files.size > FILE_MAX) files.delete(files.keys().next().value!)
    }
    return s
  }

  // A larger same-generation file may still be an in-place rewrite: every
  // watched result record (matched or orphan) must still fingerprint the
  // same bytes. One bounded read covers the newest watches that fit: a
  // per-record read would launch a request storm on a tool-heavy session.
  async function validate(s: CmdFile, file: string): Promise<boolean | null> {
    const span = watchSpan(s.watches.values())
    if (!span) return true
    // Unknown, not valid: a failed, short, or detached-in-flight read keeps
    // the previous trusted state and retries on the next observation
    // instead of trusting an unchecked one.
    const buf = await io.readExact(file, span.start, span.end - span.start, s.stamp)
    if (!buf) return null
    return verifyWatches(buf, span.start, span.selected)
  }

  async function doObserve(file: string): Promise<CommandCodeObservation> {
    // Bind the generation BEFORE the first awaited IO: a record replaced
    // while even its own stat pends must never absorb the old evidence.
    const s = fileFor(file)
    let st: FsStat
    try { st = await fs.stat(file) } catch (e) {
      // Nothing was learned: a never-observed record this call created is
      // released; a tracked one keeps its trusted evidence for the retry.
      if (files.get(file) === s && !s.observed) files.delete(file)
      throw e
    }
    if (files.get(file) !== s) {
      // Aborted: the record this observation bound is gone — return no
      // stat under the fresh generation's stamp.
      return { st: null, stamp: fileFor(file).stamp, invalidated: true }
    }
    // A folder where the transcript was expected is not this state's
    // business: the caller rejects it. A never-observed entry is released;
    // a tracked one keeps comparing against what it replaced.
    if (!st.isFile) {
      if (!s.observed) files.delete(file)
      return { st, stamp: files.get(file)?.stamp ?? 0, invalidated: false }
    }
    const g = genOf(st)
    const was = s.observed
    // A rewrite/replacement/truncate: shorter, ANY inode continuity change
    // (another inode, or evidence supplied/lost in either direction), or
    // another generation at the same size (appends always grow the file).
    const replaced = was && (st.size < s.size || s.ino !== st.ino || (st.size === s.size && s.gen !== g))
    const grewInPlace = was && st.size > s.size && !replaced
    const verdict = grewInPlace ? await validate(s, file) : true
    if (files.get(file) !== s) {
      // Aborted: the record this observation validated is gone — return no
      // stat under the fresh generation's stamp.
      return { st: null, stamp: fileFor(file).stamp, invalidated: true }
    }
    const invalidated = !was || replaced || verdict === false
    const cur = replaced || verdict === false ? fresh() : s
    if (cur !== s) files.set(file, cur)
    // Unknown stays unknown: a failed or short validation keeps the
    // previous trusted size/gen so the next observation retries it.
    if (verdict !== null) {
      cur.size = st.size
      cur.gen = g
      cur.ino = st.ino
      cur.observed = true
    }
    return { st: verdict === null ? null : st, stamp: cur.stamp, invalidated }
  }

  // One observation per file at a time: concurrent callers share its stat
  // and validation, and awaited IO can't overwrite newer trusted state.
  function observe(file: string): Promise<CommandCodeObservation> {
    const inFlight = pending.get(file)
    if (inFlight) return inFlight
    // At the cap a new file resolves unknown: no IO is launched and no
    // running observation is forgotten to make room — retry next call.
    if (pending.size >= PENDING_MAX) {
      return Promise.resolve({ st: null, stamp: files.get(file)?.stamp ?? 0, invalidated: false })
    }
    const run = doObserve(file)
    const tracked = run.finally(() => { if (pending.get(file) === tracked) pending.delete(file) })
    pending.set(file, tracked)
    return tracked
  }

  // The generation's own maps, bound at capture: the parser learns into
  // `results` (commandCodeParser's `shared`) and registers each result
  // record's fingerprint via `watch` — newest absolute offset per id (an
  // older page re-parsed must not weaken the newer watch), bounded.
  function handle(file: string): CommandCodeFileHandle {
    const s = fileFor(file)
    return {
      stamp: s.stamp,
      results: s.results,
      watch(id, w) {
        // The parser's id contract — nonempty, ≤128 UTF-8 bytes (the char
        // check short-circuits before byteLength on bounded input).
        if (id.length === 0 || id.length > CMD_ID_MAX || Buffer.byteLength(id, 'utf8') > CMD_ID_MAX
          || w.hash.length > 64 || !validWatch(w)) return
        const was = s.watches.get(id)
        if (was && w.at < was.at) return
        s.watches.set(id, w)
        if (s.watches.size > ENTRY_MAX) s.watches.delete(s.watches.keys().next().value!)
      },
    }
  }

  // The file's current invalidation stamp (0: no record). Tokens compare it.
  function stampOf(file: string): number { return files.get(file)?.stamp ?? 0 }

  // Raw reads bound to this service's stamps: readers share the context so
  // every awaited byte range checks the same generations (see
  // commandCodeIo).
  const io = commandCodeIo({ fs, stampOf })

  return { reader, handle, observe, stampOf, io }
}
