// Pure wire contract for bounded Command Code session-header reads, for the
// A5 display-only session fallback. The orchestration (cache, chunking,
// pending coalescing) lives in commandCodeHeaders.ts; this module owns the
// producer script and the strict response parser. Every record corresponds
// positionally to an input path; framing, counts, footer flags, stat fields
// and payload sizes are validated BEFORE decoding into records — arbitrary
// wire bytes can never become usable header data.
import { parseStatLine } from './fsx'
import type { CmdFilesIncomplete } from './commandCodeFileRecords'

const HEADER_BYTES = 16384
const READ_BYTES = HEADER_BYTES + 1 // one extra byte separates 16KiB-line+\n from overlong
const MAX_TOTAL = 4 * 1024 * 1024 // parser input gate in BYTES, before splitting/decoding
const MAX_LINE = 96 * 1024 // a 16.4 KiB header prefix is ~21.9 KiB base64; margin for path+stat
export const CMD_HEADER_MAX_BATCH = 64 // records per batch — also the parser's input bound
const MAX_PATH = 8192 // per-input path byte bound, checked before request assembly
const MAX_COUNT = 1_000_000
const MAX_PAYLOAD_B64 = Math.ceil(READ_BYTES / 3) * 4 // field-length gate before any decode
const B64 = /^[A-Za-z0-9+/]+={0,2}$/
const WORD = /^[a-z]+$/

export interface CmdHeaderStat { ino: number, size: number, mtimeMs: number }
export type CmdHeaderRec = { raw: Buffer, st: CmdHeaderStat } | { error: string }
export const CMD_HEADER_REASON: Record<string, CmdFilesIncomplete> = {
  rootlink: 'metadata', dirlink: 'metadata', shape: 'metadata', symlink: 'metadata',
  unreadable: 'metadata', stat: 'metadata', gone: 'raced', changed: 'raced'
}

const b64d = (s: string): Buffer | null => {
  if (!B64.test(s) || s.length > MAX_PAYLOAD_B64) return null
  const d = Buffer.from(s, 'base64')
  return d.toString('base64') === s ? d : null // canonical base64 only
}
const b64path = (s: string): string | null => {
  const d = b64d(s)
  if (d === null) return null
  const p = d.toString('utf8')
  return Buffer.from(p, 'utf8').equals(d) ? p : null // invalid UTF-8 must not rename
}
const statOk = (st: ReturnType<typeof parseStatLine>): st is NonNullable<typeof st> & { ino: number } => !!st && st.isFile && st.ino !== undefined
  && Number.isSafeInteger(st.ino) && st.ino > 0 && Number.isSafeInteger(st.size) && st.size >= 0 && Number.isFinite(st.mtimeMs)

// Wire: 'H' first, one record per input path IN INPUT ORDER —
//   R\x01<b64 path>\x01<stat>\x01<b64 header prefix>   (prefix <= 16385 bytes)
//   E\x01<b64 path>\x01<word reason>
// then 'T <r> <e> <flags>' last — r and e must equal the ACTUAL emitted R/E
// counts, flags must be within 1|2|4, and any nonzero flag means incomplete
// even over otherwise valid records: 1 metadata, 2 raced, 4 stdout overflow
// (the only flag that may leave the stream short).
export function parseCmdHeaders(inputs: string[], out: string): { records: (CmdHeaderRec | null)[], bad?: CmdFilesIncomplete } {
  const fail = (bad: CmdFilesIncomplete): { records: (CmdHeaderRec | null)[], bad: CmdFilesIncomplete } => ({ records: [], bad })
  if (inputs.length > CMD_HEADER_MAX_BATCH) return fail('oversize') // bound before any per-input allocation
  for (const p of inputs) {
    if (Buffer.byteLength(p, 'utf8') > MAX_PATH || !p.startsWith('/') || p.includes('\0')) return fail('truncated')
  }
  if (Buffer.byteLength(out, 'utf8') > MAX_TOTAL) return fail('oversize')
  const lines = out.split('\n').filter(l => l)
  if (lines[0] !== 'H') return fail('truncated')
  const records: (CmdHeaderRec | null)[] = inputs.map(() => null)
  let emitted = 0
  let rs = 0
  let es = 0
  let t: { r: number, e: number, o: number } | null = null
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE) return fail('oversize')
    if (line === 'H') return fail('truncated')
    if (line.startsWith('T ')) {
      if (i !== lines.length - 1) return fail('truncated')
      const m = /^T (\d+) (\d+) (\d+)$/.exec(line)
      const nums = m?.slice(1).map(Number)
      if (!m || !nums!.every(n => Number.isSafeInteger(n) && n! <= MAX_COUNT)) return fail('truncated')
      t = { r: nums![0]!, e: nums![1]!, o: nums![2]! }
      if (t.o > 7) return fail('truncated')
      break
    }
    const kind = line.startsWith('R\x01') ? 'R' : line.startsWith('E\x01') ? 'E' : null
    if (!kind) return fail('truncated')
    if (++emitted > inputs.length) return fail('truncated')
    const parts = line.slice(2).split('\x01')
    const file = b64path(parts[0] || '')
    if (file === null || file !== inputs[emitted - 1]) return fail('truncated') // strict order correspondence
    if (kind === 'E') {
      es++
      if (parts.length !== 2 || !WORD.test(parts[1]!)) return fail('truncated')
      records[emitted - 1] = { error: parts[1]! }
      continue
    }
    rs++
    if (parts.length !== 3 || parts[2]!.length > MAX_PAYLOAD_B64) return fail('truncated')
    const st = parseStatLine(parts[1]!)
    if (!statOk(st)) return fail('truncated')
    const raw = parts[2] === '' ? Buffer.alloc(0) : b64d(parts[2]!)
    if (raw === null || raw.length > READ_BYTES) return fail('truncated')
    records[emitted - 1] = { raw, st: { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs } }
  }
  if (!t || t.r !== rs || t.e !== es) return fail('truncated')
  if (emitted < inputs.length && !(t.o & 4)) return fail('truncated') // short without overflow: records lost
  const bad = t.o & 1 ? 'metadata' as const : t.o & 2 ? 'raced' as const : t.o & 4 ? 'oversize' as const : undefined
  return { records, ...(bad ? { bad } : {}) }
}

// Producer: $1 is the canonical projects root, remaining args the raw paths
// (NUL-free by construction). Root and project-dir symlink checks happen on
// the machine BEFORE any open: a renamed-then-linked root or project dir
// reports 'rootlink'/'dirlink', never a followed read. Per path the script
// refuses symlink/nonexist/non-regular/unreadable/stat-fail, verifies
// pre/post-read stat agreement, and emits a bounded head -c 16385 prefix —
// never more than that of any file, however large the transcript. LC_ALL=C
// for deterministic stat strings and byte accounting; emit() bounds stdout
// BEFORE machine.exec serialization.
export const CMD_HEADERS_SCRIPT = `R=$1
shift
S=$(printf '\\001')
LC_ALL=C; export LC_ALL
CAP=2500000
r=0; e=0; o=0; ob=0
emit() { l=\${#1}; [ $((ob + l)) -ge $CAP ] && { o=$((o|4)); return 1; }; ob=$((ob+l+1)); printf '%s\\n' "$1"; }
printf 'H\\n'
m=%.9Y; stat -c "$m" / 2>/dev/null | grep -q '^[0-9]*[.][0-9]' || m=%Y
# A symlinked root makes every listed path suspect: report per input.
if [ -L "$R" ]; then
  for p in "$@"; do
    pb=$(printf %s "$p" | base64 | tr -d '\\n')
    emit "E$S$pb\${S}rootlink" && e=$((e+1)) || break
  done
  o=$((o|1))
  printf 'T %s %s %s\\n' "$r" "$e" "$o"
  exit 0
fi
for p in "$@"; do
  pb=$(printf %s "$p" | base64 | tr -d '\\n')
  d=\${p%/*}
  # The root check is PER PATH: a mid-batch root swap must not let a later
  # prefix read through a freshly linked root.
  if [ -L "$R" ]; then emit "E$S$pb\${S}rootlink" && e=$((e+1)) || break; o=$((o|1)); continue; fi
  if [ "\${d%/*}" != "$R" ]; then emit "E$S$pb\${S}shape" && e=$((e+1)) || break; o=$((o|1)); continue; fi
  if [ -L "$d" ]; then emit "E$S$pb\${S}dirlink" && e=$((e+1)) || break; o=$((o|1)); continue; fi
  if [ -L "$p" ]; then emit "E$S$pb\${S}symlink" && e=$((e+1)) || break; o=$((o|1)); continue; fi
  if [ ! -e "$p" ]; then emit "E$S$pb\${S}gone" && e=$((e+1)) || break; o=$((o|2)); continue; fi
  if [ ! -f "$p" ] || [ ! -r "$p" ]; then emit "E$S$pb\${S}unreadable" && e=$((e+1)) || break; o=$((o|1)); continue; fi
  sa=$(stat -c "%s $m %i %F" "$p" 2>/dev/null)
  if [ -z "$sa" ]; then emit "E$S$pb\${S}stat" && e=$((e+1)) || break; o=$((o|1)); continue; fi
  hb=$(head -c 16385 "$p" 2>/dev/null | base64 | tr -d '\\n')
  sb=$(stat -c "%s $m %i %F" "$p" 2>/dev/null)
  if [ -z "$sb" ] || [ "$sa" != "$sb" ]; then emit "E$S$pb\${S}changed" && e=$((e+1)) || break; o=$((o|2)); continue; fi
  emit "R$S$pb$S$sa$S$hb" && r=$((r+1)) || break
done
printf 'T %s %s %s\\n' "$r" "$e" "$o"`
