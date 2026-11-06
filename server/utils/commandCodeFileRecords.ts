// Pure wire contract for Command Code transcript metadata records, for the
// A5 display-only session fallback. The producer lives in commandCodeFiles.ts;
// this module validates framing, counts, footer flags, stat fields and path
// shapes BEFORE decoding into the snapshot — arbitrary wire bytes can never
// become a usable candidate list.
import path from 'node:path'
import { parseStatLine } from './fsx'
import { cmdCanonicalPath, cmdSessionFile } from './commandCodeSessions'

// One transcript candidate's file metadata (the session id and header cwd
// arrive with the header unit; file and id agree by cmdSessionFile).
export interface CmdFileMeta { file: string, ino: number, size: number, mtimeMs: number }
export type CmdFilesIncomplete = 'unavailable' | 'truncated' | 'oversize' | 'raced' | 'metadata'
export interface CmdFileSnapshot {
  complete: boolean
  incomplete?: CmdFilesIncomplete
  files: CmdFileMeta[] // validated <root>/<dir>/<uuid>.jsonl only — sidecars skipped
  dirs: number // project dirs scanned
  found: number // *.jsonl files seen (>= files.length: checkpoints etc.)
}

const MAX_TOTAL = 4 * 1024 * 1024 // parser input gate in BYTES, before splitting/decoding
const MAX_LINE = 64 * 1024
const MAX_RECORDS = 8192 // emitted records retained; the producer's maxf is the same bound
const MAX_COUNT = 1_000_000 // hard bound on footer counters — safe-but-absurd counts reject

// Wire: 'H' first, 'R\x01<b64path>\x01<statline>' records, 'T n f r flags'
// last — exactly one ordered framing, counts agreeing, or the snapshot is
// truncated. Sidecar shapes (non-UUID basename inside a project dir) are
// skipped silently; they are not candidates, not errors.
export function parseCmdFiles(root: string, out: string): CmdFileSnapshot {
  const files: CmdFileMeta[] = []
  const seen = new Set<string>()
  const fail = (r: CmdFilesIncomplete): CmdFileSnapshot => ({ complete: false, incomplete: r, files, dirs: 0, found: 0 })
  if (!cmdCanonicalPath(root)) return { complete: false, incomplete: 'metadata', files: [], dirs: 0, found: 0 }
  if (Buffer.byteLength(out, 'utf8') > MAX_TOTAL) return fail('oversize')
  const lines = out.split('\n').filter(l => l)
  if (lines[0] !== 'H') return fail('truncated')
  let records = 0
  let t: { n: number, f: number, r: number, o: number } | null = null
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE) return fail('oversize')
    if (line === 'H') return fail('truncated')
    if (line.startsWith('T ')) {
      if (i !== lines.length - 1) return fail('truncated') // footer must be last
      const m = /^T (\d+) (\d+) (\d+) (\d+)$/.exec(line)
      const nums = m?.slice(1).map(Number)
      if (!m || !nums!.every(n => Number.isSafeInteger(n) && n! <= MAX_COUNT)) return fail('truncated')
      t = { n: nums![0]!, f: nums![1]!, r: nums![2]!, o: nums![3]! }
      if (t.o > 15) return fail('truncated') // only known footer bits (range first: & is int32)
      break
    }
    if (!line.startsWith('R\x01')) return fail('truncated')
    records++
    if (records > MAX_RECORDS) return fail('oversize')
    const parts = line.slice(2).split('\x01')
    if (parts.length !== 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[0]!)) return fail('truncated')
    const dec = Buffer.from(parts[0]!, 'base64')
    if (dec.toString('base64') !== parts[0]) return fail('truncated') // canonical base64 only
    const file = dec.toString('utf8')
    if (!Buffer.from(file, 'utf8').equals(dec)) return fail('truncated') // invalid UTF-8 must not rename
    const st = parseStatLine(parts[1]!)
    if (!st || !st.isFile || st.ino === undefined || !Number.isSafeInteger(st.ino) || st.ino <= 0
      || !Number.isSafeInteger(st.size) || st.size < 0 || !Number.isFinite(st.mtimeMs)) {
      return fail('truncated')
    }
    const sf = cmdSessionFile(root, file)
    if (sf) {
      if (seen.has(file)) return fail('truncated') // duplicate record: wire corruption
      seen.add(file)
      files.push({ file, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs })
      continue
    }
    // Only a confined <root>/<dir>/<non-UUID>.jsonl shape may be ignored as a
    // sidecar; anything the producer cannot emit is wire corruption.
    const rel = cmdCanonicalPath(file) ? path.relative(root, file) : '..'
    const depth = rel && rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel) ? rel.split('/').length : -1
    if (depth !== 2 || !file.endsWith('.jsonl')) return fail('truncated')
  }
  // flags=0 means nothing was dropped: every found file must have a record.
  if (!t || t.r !== records || t.f < t.r || (t.o === 0 && t.f !== t.r) || (records > 0 && t.n === 0)) return fail('truncated')
  const incomplete: CmdFilesIncomplete | undefined = t.o & 1 ? 'metadata' : t.o & 2 ? 'raced' : t.o & 12 ? 'oversize' : undefined
  return { complete: !incomplete, ...(incomplete ? { incomplete } : {}), files, dirs: t.n, found: t.f }
}
