// File access on a machine (transcripts, folders, photos): the local
// disk, or a remote machine's through shell commands passed over the
// multiplexed SSH connection (see machines.ts). Same operations on both sides,
// in POSIX sh + BSD (macOS) or GNU (Linux) stat.
import fs from 'node:fs'
import { createHash } from 'node:crypto'

const fsp = fs.promises

// `ino`: inode number when known (a file replaced by another, even at the same
// size and second, gets another one).
export interface FsStat { size: number, mtimeMs: number, isFile: boolean, isDir: boolean, ino?: number }
export interface PidLock { name: string, pid: number, stat: FsStat }

export interface MachineFs {
  stat: (p: string) => Promise<FsStat> // rejette si absent
  statMany: (ps: string[]) => Promise<(FsStat | null)[]>
  readdir: (p: string) => Promise<string[]>
  readFile: (p: string) => Promise<string>
  // `len` bytes from `start` (fewer at the end of the file).
  read: (p: string, start: number, len: number, timeoutMs?: number) => Promise<Buffer>
  // Checksum of the first `len` bytes, computed where the file is (a remote
  // machine sends back a few bytes, not the file).
  digest?: (p: string, len: number) => Promise<string>
  // All PID locks in one remote round trip; null means an incomplete scan.
  readPidLocks?: (dir: string) => Promise<PidLock[] | null>
}

// ---------------------------------------------------------------- disque local
const toStat = (st: fs.Stats): FsStat => ({ size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile(), isDir: st.isDirectory(), ino: st.ino })

export const localFs: MachineFs = {
  stat: async p => toStat(await fsp.stat(p)),
  statMany: ps => Promise.all(ps.map(p => fsp.stat(p).then(toStat, () => null))),
  readdir: p => fsp.readdir(p),
  readFile: p => fsp.readFile(p, 'utf8'),
  async readPidLocks(dir) {
    const names = (await fsp.readdir(dir)).filter(n => n.endsWith('.lock'))
    if (names.length > 4096) return null
    const out: PidLock[] = []
    for (let i = 0; i < names.length; i += 32) {
      const batch = await Promise.all(names.slice(i, i + 32).map(async name => {
        const p = `${dir}/${name}`
        const stat = await localFs.stat(p).catch(() => null)
        const body = stat?.isFile && stat.size <= 32 ? await localFs.read(p, 0, 33).catch(() => null) : null
        const pid = body && body.length <= 32 ? body.toString('utf8').trim() : ''
        return stat && /^\d+$/.test(pid) && Number.isSafeInteger(Number(pid)) && Number(pid) > 0 ? { name, pid: Number(pid), stat } : null
      }))
      out.push(...batch.filter((v): v is PidLock => v !== null))
    }
    return out
  },
  async read(p, start, len) {
    const fh = await fsp.open(p, 'r')
    try {
      const buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, start)
      return bytesRead < len ? buf.subarray(0, bytesRead) : buf
    } finally { await fh.close() }
  },
  async digest(p, len) {
    const h = createHash('sha1')
    if (len > 0) for await (const b of fs.createReadStream(p, { start: 0, end: len - 1 })) h.update(b as Buffer)
    return h.digest('hex')
  },
}

// ---------------------------------------------------------------- shell distant
export interface ExecResult { code: number | null, stdout: Buffer, stderr: string }
// Runs `script` (sh) with its positional arguments ($1, $2…) on the machine.
// `maxBytes`: past that much output the command is stopped and nothing of it is kept.
export type ShellExec = (script: string, args?: string[], opts?: { input?: Buffer, timeoutMs?: number, maxBytes?: number }) => Promise<ExecResult>

export class FsError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

// Shell quoting (arguments passed as is, never interpreted).
export const shq = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`

// BSD (macOS) or GNU `stat`: one "size mtime inode type" line per file, "x" if
// missing. The mtime has its fraction of a second when `stat` can print it
// (GNU %.9Y, BSD %Fm): a file rewritten at the same size within one second
// then gets another mtime.
export const STAT_SCRIPT = `if stat -f %z / >/dev/null 2>&1; then bsd=1; m=%m; stat -f %Fm / 2>/dev/null | grep -q '^[0-9]*[.][0-9]' && m=%Fm
else bsd=; m=%Y; stat -c %.9Y / 2>/dev/null | grep -q '^[0-9]*[.][0-9]' && m=%.9Y; fi
for f; do
  if [ ! -e "$f" ]; then echo x
  elif [ -n "$bsd" ]; then stat -f "%z $m %i %HT" "$f" 2>/dev/null || echo x
  else stat -c "%s $m %i %F" "$f" 2>/dev/null || echo x; fi
done`

// Reserved by our read scripts, independent of shell/utility diagnostics
// (dash's failed `cd`, for example, never says "No such file").
const MISSING_PATH_EXIT = 44
const REQUIRE_PATH = `[ -e "$1" ] || exit ${MISSING_PATH_EXIT}\n`

// One stat process for the entire glob. Filename/PID fields are NUL-delimited;
// each bounded lock is read by the shell, without per-file utility processes.
const PID_LOCKS_SCRIPT = REQUIRE_PATH + `cd "$1" || exit $?
set --
for f in ./*.lock ./.[!.]*.lock ./..?*.lock; do
  [ -e "$f" ] || continue
  set -- "$@" "$f"
  [ "$#" -le 4096 ] || { printf '!'; exit 0; }
done
[ "$#" -gt 0 ] || exit 0
if [ "$(uname -s)" = Darwin ]; then
  stats=$(stat -f '%z %Fm %i %HT' "$@") || exit $?
else
  stats=$(stat -c '%s %.9Y %i %F' -- "$@") || exit $?
fi
newline='
'
for f; do
  line=\${stats%%"$newline"*}
  stats=\${stats#*"$newline"}
  size=\${line%% *}
  case "$size" in ''|*[!0-9]*) continue ;; esac
  [ "$size" -le 32 ] || continue
  case "$line" in *regular*|*Regular*) ;; *) continue ;; esac
  exec 3< "$f" || continue
  pid=; read -r pid <&3
  extra=; read -r extra <&3; more=$?
  exec 3<&-
  [ "$more" -ne 0 ] && [ -z "$extra" ] || continue
  case "$pid" in ''|*[!0-9]*) continue ;; esac
  printf '%s\\0%s\\0%s\\0' "\${f#./}" "$line" "$pid"
done`

export function parseStatLine(line: string): FsStat | null {
  // The inode is optional: "size mtime type" from an older script still parses.
  const m = /^(\d+) (\d+(?:\.\d+)?) (?:(\d+) )?(\D.*)$/.exec(String(line || '').trim())
  if (!m) return null
  const type = m[4]!.toLowerCase()
  // Fraction kept to the microsecond (whole seconds: a multiple of 1000).
  const [sec, frac = ''] = m[2]!.split('.')
  const st: FsStat = { size: Number(m[1]), mtimeMs: Number(sec) * 1000 + Number((frac + '000000').slice(0, 6)) / 1000, isFile: type.includes('regular'), isDir: type.includes('directory') }
  if (m[3]) st.ino = Number(m[3])
  return st
}

// The largest read a caller may request through a bounded transport: the
// image budget (60 MiB), above the chat budget (24 MiB). Only enforced on
// opted-in filesystems; the default single-exec path is untouched.
export const READ_LIMIT = 60 * 1024 * 1024

export function createShellFs(exec: ShellExec, opts: { statTtlMs?: number, chunkBytes?: number } = {}): MachineFs {
  const ttl = opts.statTtlMs ?? 700
  // Opt-in read chunking: a transport whose reply ceiling is below the file
  // window (core's 16 MiB) reads in `chunkBytes` slices instead of one exec.
  // A provided value must be a safe positive integer — an Infinity or a
  // fraction would silently defeat the per-reply bounds it exists for.
  if (opts.chunkBytes !== undefined && (!Number.isSafeInteger(opts.chunkBytes) || opts.chunkBytes <= 0)) {
    throw new FsError('remote', 'invalid chunkBytes')
  }
  const chunkBytes = opts.chunkBytes ?? 0
  // Small cache (and grouping of simultaneous requests): the previews, the
  // model and the open conversation each run their `stat` every second.
  const statCache = new Map<string, { at: number, v: Promise<FsStat | null> }>()

  // `ENOENT` for a missing file (as on the local disk), `unreachable` when the
  // session itself failed (ssh 255, timeout): the file's state is unknown.
  // `maxBytes` bounds the exec's own stdout on the wire.
  async function run(script: string, args: string[], timeoutMs = 15000, input?: Buffer, maxBytes?: number) {
    const r = await exec(script, args, { timeoutMs, input, ...(maxBytes ? { maxBytes } : {}) })
    if (r.code !== 0) {
      const reason = (r.stderr || `code ${r.code}`).trim().split('\n').pop() || 'failed'
      const code = r.code === 255 || r.code === 124 ? 'unreachable' : r.code === MISSING_PATH_EXIT || /no such file/i.test(r.stderr) ? 'ENOENT' : 'remote'
      throw new FsError(code, reason)
    }
    // The bound is enforced here too: a ShellExec that ignores maxBytes can
    // never over-serve a caller.
    if (maxBytes && r.stdout.length > maxBytes) throw new FsError('remote', 'reply exceeds requested chunk')
    return r.stdout
  }

  async function statMany(ps: string[]): Promise<(FsStat | null)[]> {
    const now = Date.now()
    const out: (Promise<FsStat | null> | null)[] = ps.map((p) => {
      const c = statCache.get(p)
      return c && now - c.at < ttl ? c.v : null
    })
    const missing = ps.filter((_, i) => !out[i])
    if (missing.length) {
      const batch = run(STAT_SCRIPT, missing).then(b => b.toString('utf8').split('\n'))
      missing.forEach((p, i) => {
        const v = batch.then(lines => parseStatLine(lines[i] || ''))
        v.catch(() => statCache.delete(p))
        statCache.set(p, { at: now, v })
      })
      if (statCache.size > 2000) {
        for (const [k, c] of statCache) if (now - c.at >= ttl) statCache.delete(k)
      }
      ps.forEach((p, i) => { if (!out[i]) out[i] = statCache.get(p)!.v })
    }
    return Promise.all(out as Promise<FsStat | null>[])
  }

  return {
    async stat(p) {
      const [s] = await statMany([p])
      if (!s) throw new FsError('ENOENT', `not found: ${p}`)
      return s
    },
    statMany,
    async readPidLocks(dir) {
      const raw = (await run(PID_LOCKS_SCRIPT, [dir])).toString('utf8')
      if (raw === '!') return null
      const fields = raw.split('\0')
      const out: PidLock[] = []
      for (let i = 0; i + 2 < fields.length; i += 3) {
        const name = fields[i]!
        const pid = fields[i + 2]!
        const stat = parseStatLine(fields[i + 1]!)
        if (!name.endsWith('.lock') || /[/\\]/.test(name) || !/^\d+$/.test(pid) || !Number.isSafeInteger(Number(pid)) || Number(pid) <= 0 || !stat?.isFile || stat.size > 32) continue
        out.push({ name, pid: Number(pid), stat })
      }
      return out.length <= 4096 ? out : null
    },
    async readdir(p) {
      const b = await run(REQUIRE_PATH + 'cd "$1" && ls -1A', [p])
      return b.toString('utf8').split('\n').filter(Boolean)
    },
    async readFile(p) {
      return (await run(REQUIRE_PATH + 'cat "$1"', [p])).toString('utf8')
    },
    async read(p, start, len, timeoutMs) {
      // tail -c +N jumps straight to byte N (regular file); head cuts.
      // Open before the pipeline so a failed open cannot be hidden by head's
      // successful exit (POSIX sh has no portable pipefail).
      const script = REQUIRE_PATH + 'exec 3< "$1" || exit $?\ntail -c +"$2" <&3 | head -c "$3"'
      if (len <= 0) {
        if (!Number.isSafeInteger(len)) throw new FsError('remote', 'invalid read length')
        return Buffer.alloc(0)
      }
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(len) || !Number.isSafeInteger(start + len)) {
        throw new FsError('remote', 'invalid read range')
      }
      if (!chunkBytes) {
        return run(script, [p, String(start + 1), String(len)], timeoutMs || 60000)
      }
      // An opted-in read is bounded at both ends before anything allocates:
      // the request by the logical ceiling, every reply by its exact slice.
      if (len > READ_LIMIT) throw new FsError('remote', 'read too large')
      if (len <= chunkBytes) {
        return run(script, [p, String(start + 1), String(len)], timeoutMs || 60000, undefined, len)
      }
      // One deadline across all chunks, never a timeout per chunk that grows
      // with the file. Each exec is bounded to its slice on the wire; a short
      // slice is the genuine end of the file, an error means no read at all.
      const out = Buffer.alloc(len)
      const deadline = Date.now() + (timeoutMs || 60000)
      let got = 0
      while (got < len) {
        const n = Math.min(chunkBytes, len - got)
        const left = deadline - Date.now()
        if (left <= 0) throw new FsError('unreachable', 'read timed out')
        const b = await run(script, [p, String(start + got + 1), String(n)], left, undefined, n)
        if (!b.length) break
        b.copy(out, got)
        got += b.length
        if (b.length < n) break
      }
      return got < len ? out.subarray(0, got) : out
    },
    async digest(p, len) {
      const out = await run(REQUIRE_PATH + 'exec 3< "$1" || exit $?\nhead -c "$2" <&3 | cksum', [p, String(Math.max(0, len))], 60000)
      return out.toString('utf8').trim()
    },
  }
}

// ---------------------------------------------------------------- dossiers
export interface DirEntryRaw { name: string, git: boolean }

// Why a folder's content cannot be listed: `macos`, macOS privacy protection
// (TCC: Documents, Desktop, Downloads… refused to a process without full
// disk access, even though `cd` works), or `permission`, plain Unix rights.
export type DirDenied = 'macos' | 'permission'

// Visible subfolders of a folder, with "is a Git repository". Exit 1: not a
// folder; 2: unreadable; 3: refused by macOS. `for d in *` alone would print
// nothing for a refused folder, as for an empty one: `ls` tells them apart.
export const LIST_DIRS_SCRIPT = `why() { case "$1" in *"not permitted"*) [ "$(uname -s)" = Darwin ] && exit 3 ;; esac; exit 2; }
e=$(cd "$1" 2>&1) || { [ -d "$1" ] || exit 1; why "$e"; }
cd "$1" || exit 1
e=$(LC_ALL=C ls -A 2>&1 >/dev/null) || why "$e"
for d in * ; do
  [ -d "$d" ] || continue
  [ "$d" = node_modules ] && continue
  if [ -e "$d/.git" ]; then echo "g $d"; else echo "d $d"; fi
done`

// Exit code of LIST_DIRS_SCRIPT → refusal (null: listed, or not a folder).
export const dirDeniedFromCode = (code: number | null): DirDenied | null => code === 3 ? 'macos' : code === 2 ? 'permission' : null

export function parseDirList(out: string): DirEntryRaw[] {
  return String(out || '').split('\n').filter(l => /^[gd] ./.test(l)).map(l => ({ name: l.slice(2), git: l[0] === 'g' }))
}
