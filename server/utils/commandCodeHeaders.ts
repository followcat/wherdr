// Bounded cached Command Code session headers, for the A5 display-only
// session fallback. Consumes a COMPLETE cmdFiles snapshot and reads only the
// first line of each eligible file — head -c 16385 on the agent machine,
// never a whole-file read — in chunked batches through one ShellExec round
// trip per chunk (wire contract in commandCodeHeaderRecords.ts). Header
// validation (v3 type/version/id/cwd, basename-id agreement) reuses
// cmdHeaderOf + cmdSessionFile; the stat observed for the read must agree
// with the listing AND across the read, or the file is raced — never a
// mixed header/stat candidate. Validated {id,cwd} results cache by file+
// inode+size+mtime: unchanged polls read and transfer ZERO header bytes,
// changed or replaced files re-read. One instance is scoped to one exec+root
// — no cross-machine cache — and concurrent calls serialize so a bounded
// pending queue can never fan out unbounded reads. afterMs only skips PRE-
// BIRTH header reads; every confined uuid.jsonl basename id still lands in
// `files` so a `--session <uuid>` seed stays honest about duplicates the
// header pass never read.
import type { ShellExec } from './fsx'
import type { CmdFileMeta, CmdFileSnapshot, CmdFilesIncomplete } from './commandCodeFileRecords'
import { type CmdCandidate, cmdCanonicalPath, cmdHeaderOf, cmdProjectsRoot, cmdSessionFile } from './commandCodeSessions'
import { CMD_HEADER_MAX_BATCH, CMD_HEADER_REASON, CMD_HEADERS_SCRIPT, parseCmdHeaders } from './commandCodeHeaderRecords'

export interface CmdHeaderBasename { file: string, id: string }
export interface CmdHeadersResult {
  complete: boolean
  incomplete?: CmdFilesIncomplete
  items: CmdCandidate[] // eligible post-birth files with a validated header
  files: CmdHeaderBasename[] // EVERY confined uuid.jsonl — incl. pre-birth — for seed uniqueness
}
export interface CmdHeaders {
  headers(snapshot: CmdFileSnapshot, opts?: { afterMs?: number }): Promise<CmdHeadersResult>
}

const HEADER_BYTES = 16384
const MAX_FILES = 8192 // snapshot record bound, checked before any per-file loop
const MAX_REQUEST = 256 * 1024 // chunk bound on summed arg bytes (root + paths)
const MAX_CACHE = 8192
const MAX_PENDING = 8
const MAX_PENDING_HARD = 64

const RANK: Record<CmdFilesIncomplete, number> = { metadata: 0, raced: 1, oversize: 2, unavailable: 3, truncated: 4 }
const merge = (a: CmdFilesIncomplete | undefined, b: CmdFilesIncomplete) => a === undefined || RANK[b] < RANK[a] ? b : a
const clampInt = (v: number | undefined, def: number, max: number) => Number.isFinite(v) && v! >= 1 ? Math.min(Math.floor(v!), max) : def

// One scoped source per exec+root. Complete means every eligible post-birth
// metadata entry produced a validated header; nothing can be complete while
// a relevant read failed, raced or stayed unread. Eviction can only force a
// later re-read — items are rebuilt from the current snapshot every call.
export function createCmdHeaders(exec: ShellExec, home: string, opts: { root?: string, timeoutMs?: number, maxPending?: number, cacheEntries?: number } = {}): CmdHeaders {
  const root = opts.root || cmdProjectsRoot(home)
  const cache = new Map<string, { ino: number, size: number, mtimeMs: number, id: string, cwd: string }>()
  const cacheMax = clampInt(opts.cacheEntries, 4096, MAX_CACHE)
  const pendingMax = clampInt(opts.maxPending, MAX_PENDING, MAX_PENDING_HARD)
  let tail: Promise<unknown> = Promise.resolve()
  let pending = 0
  const fail = (incomplete: CmdFilesIncomplete): CmdHeadersResult => ({ complete: false, incomplete, items: [], files: [] })

  const run = async (snapshot: CmdFileSnapshot, afterMs?: number): Promise<CmdHeadersResult> => {
    if (afterMs !== undefined && !Number.isFinite(afterMs)) return fail('metadata')
    if (!cmdCanonicalPath(root)) return fail('metadata')
    if (snapshot.files.length > MAX_FILES) return fail('oversize')
    const files: CmdHeaderBasename[] = []
    const items: CmdCandidate[] = []
    const need: CmdFileMeta[] = []
    for (const m of snapshot.files) {
      // Malformed metadata must make the whole result incomplete — never
      // silently filtered away behind afterMs or a cache lookup.
      if (!Number.isSafeInteger(m.ino) || m.ino <= 0 || !Number.isSafeInteger(m.size) || m.size < 0 || !Number.isFinite(m.mtimeMs)) return fail('metadata')
      if (Buffer.byteLength(m.file, 'utf8') > 8192) return fail('metadata') // can never fit a request
      const sf = cmdSessionFile(root, m.file)
      if (!sf) return fail('metadata') // a validated snapshot cannot contain this
      files.push({ file: m.file, id: sf.id })
      if (afterMs === undefined || m.mtimeMs > afterMs) {
        const c = cache.get(m.file)
        if (c && c.ino === m.ino && c.size === m.size && c.mtimeMs === m.mtimeMs) {
          items.push({ file: m.file, id: c.id, cwd: c.cwd, mtimeMs: m.mtimeMs, size: m.size, ino: m.ino })
        } else need.push(m)
      }
    }
    // An incomplete metadata scan stays incomplete — even when every known
    // entry is pre-birth — but the basename catalog still ships for seeds.
    if (!snapshot.complete) return { complete: false, incomplete: snapshot.incomplete ?? 'metadata', items: [], files }
    let bad: CmdFilesIncomplete | undefined
    for (let i = 0; i < need.length;) {
      // Chunk on request bytes (root arg included) AND worst-case response.
      const chunk: CmdFileMeta[] = []
      let bytes = Buffer.byteLength(root, 'utf8') + 8
      while (i < need.length && chunk.length < CMD_HEADER_MAX_BATCH) {
        const b = Buffer.byteLength(need[i]!.file, 'utf8') + 8
        if (bytes + b > MAX_REQUEST) {
          if (chunk.length === 0) return fail('metadata') // never issue an empty, non-progress batch
          break
        }
        bytes += b
        chunk.push(need[i++]!)
      }
      const args = [root, ...chunk.map(m => m.file)]
      const r = await exec(CMD_HEADERS_SCRIPT, args, { timeoutMs: opts.timeoutMs ?? 10000, maxBytes: 3 * 1024 * 1024 })
      if (r.code !== 0) return { complete: false, incomplete: 'unavailable', items, files }
      const p = parseCmdHeaders(chunk.map(m => m.file), r.stdout.toString('utf8'))
      if (p.bad) return { complete: false, incomplete: p.bad, items, files }
      for (let j = 0; j < chunk.length; j++) {
        const m = chunk[j]!
        const rec = p.records[j]
        if (!rec) return { complete: false, incomplete: 'truncated', items, files }
        if ('error' in rec) {
          bad = merge(bad, CMD_HEADER_REASON[rec.error] ?? 'metadata')
          continue
        }
        const raw = rec.raw
        const nl = raw.indexOf(0x0a)
        // 16385 read: nl inside is a complete line; a shorter prefix is EOF
        // (complete line <= 16384); 16385 with no newline means overlong.
        const slice = nl >= 0 ? raw.subarray(0, nl) : raw.length <= HEADER_BYTES ? raw : null
        // The line bytes must be EXACT UTF-8: a corrupt byte must not decode
        // into a different cwd/id (a real U+FFFD round-trips fine).
        let line: string | null = null
        if (slice !== null) {
          const s = slice.toString('utf8')
          line = Buffer.from(s, 'utf8').equals(slice) ? s : null
        }
        const h = line === null ? null : cmdHeaderOf(line)
        if (!h) { bad = merge(bad, 'metadata'); continue } // overlong or malformed v3 header
        const sf = cmdSessionFile(root, m.file)
        if (!sf || sf.id !== h.id) { bad = merge(bad, 'metadata'); continue } // basename/id must agree
        // The observed stat already passed pre/post-read agreement in the
        // script; it must ALSO equal the listing meta — a changed file is
        // raced, never a mixed header/stat candidate.
        if (rec.st.ino !== m.ino || rec.st.size !== m.size || rec.st.mtimeMs !== m.mtimeMs) { bad = merge(bad, 'raced'); continue }
        items.push({ file: m.file, id: h.id, cwd: h.cwd, mtimeMs: m.mtimeMs, size: m.size, ino: m.ino })
        if (cache.size >= cacheMax && !cache.has(m.file)) cache.delete(cache.keys().next().value!)
        cache.set(m.file, { ino: m.ino, size: m.size, mtimeMs: m.mtimeMs, id: h.id, cwd: h.cwd })
      }
    }
    return bad ? { complete: false, incomplete: bad, items, files } : { complete: true, items, files }
  }

  // Identical in-flight requests share one promise BEFORE pending accounting
  // (coalescing, not queuing); the map stays bounded by pendingMax and cleans
  // up per key. Distinct (snapshot, afterMs) pairs may still hit the cap.
  const inflight = new Map<CmdFileSnapshot, Map<number | undefined, Promise<CmdHeadersResult>>>()
  return {
    headers(snapshot, o = {}) {
      const afterMs = o.afterMs
      const bySnap = inflight.get(snapshot)
      const shared = bySnap?.get(afterMs)
      if (shared) return shared
      if (pending >= pendingMax) return Promise.resolve(fail('unavailable'))
      pending++
      const p = tail.then(() => run(snapshot, afterMs)).catch((): CmdHeadersResult => fail('unavailable'))
      tail = p.then(() => {}, () => {})
      const done = p.finally(() => {
        pending--
        const m = inflight.get(snapshot)
        if (m) {
          m.delete(afterMs)
          if (m.size === 0) inflight.delete(snapshot)
        }
      })
      if (bySnap) bySnap.set(afterMs, done)
      else inflight.set(snapshot, new Map([[afterMs, done]]))
      return done
    }
  }
}
