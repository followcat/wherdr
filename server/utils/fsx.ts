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
  // Bounded small files and their stats in one remote round trip (PID locks).
  readSmallMany?: (ps: string[], maxBytes: number) => Promise<{ stat: FsStat | null, body: Buffer | null }[]>
}

// ---------------------------------------------------------------- disque local
const toStat = (st: fs.Stats): FsStat => ({ size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile(), isDir: st.isDirectory(), ino: st.ino })

export const localFs: MachineFs = {
  stat: async p => toStat(await fsp.stat(p)),
  statMany: ps => Promise.all(ps.map(p => fsp.stat(p).then(toStat, () => null))),
  readdir: p => fsp.readdir(p),
  readFile: p => fsp.readFile(p, 'utf8'),
  async readSmallMany(ps, maxBytes) {
    const out: { stat: FsStat | null, body: Buffer | null }[] = []
    for (let i = 0; i < ps.length; i += 32) out.push(...await Promise.all(ps.slice(i, i + 32).map(async p => {
      const stat = await localFs.stat(p).catch(() => null)
      const body = stat?.isFile && stat.size <= maxBytes ? await localFs.read(p, 0, maxBytes + 1).catch(() => null) : null
      return { stat, body }
    })))
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

export function createShellFs(exec: ShellExec, opts: { statTtlMs?: number } = {}): MachineFs {
  const ttl = opts.statTtlMs ?? 700
  // Small cache (and grouping of simultaneous requests): the previews, the
  // model and the open conversation each run their `stat` every second.
  const statCache = new Map<string, { at: number, v: Promise<FsStat | null> }>()

  // `ENOENT` for a missing file (as on the local disk), `unreachable` when the
  // session itself failed (ssh 255, timeout): the file's state is unknown.
  async function run(script: string, args: string[], timeoutMs = 15000, input?: Buffer) {
    const r = await exec(script, args, { timeoutMs, input })
    if (r.code !== 0) {
      const reason = (r.stderr || `code ${r.code}`).trim().split('\n').pop() || 'failed'
      const code = r.code === 255 || r.code === 124 ? 'unreachable' : r.code === MISSING_PATH_EXIT || /no such file/i.test(r.stderr) ? 'ENOENT' : 'remote'
      throw new FsError(code, reason)
    }
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
    async readSmallMany(ps, maxBytes) {
      if (!ps.length) return []
      const script = 'limit=$1; shift\n' + STAT_SCRIPT + `
for f; do
  if [ -f "$f" ]; then head -c "$limit" < "$f" 2>/dev/null | base64 | tr -d '\\n'; fi
  printf '\\n'
done`
      const lines = (await run(script, [String(maxBytes + 1), ...ps])).toString('utf8').split('\n')
      return ps.map((_, i) => ({ stat: parseStatLine(lines[i] || ''), body: Buffer.from(lines[ps.length + i] || '', 'base64') }))
    },
    async readdir(p) {
      const b = await run(REQUIRE_PATH + 'cd "$1" && ls -1A', [p])
      return b.toString('utf8').split('\n').filter(Boolean)
    },
    async readFile(p) {
      return (await run(REQUIRE_PATH + 'cat "$1"', [p])).toString('utf8')
    },
    async read(p, start, len, timeoutMs) {
      if (len <= 0) return Buffer.alloc(0)
      // tail -c +N jumps straight to byte N (regular file); head cuts.
      // Open before the pipeline so a failed open cannot be hidden by head's
      // successful exit (POSIX sh has no portable pipefail).
      return run(REQUIRE_PATH + 'exec 3< "$1" || exit $?\ntail -c +"$2" <&3 | head -c "$3"', [p, String(start + 1), String(len)], timeoutMs || 60000)
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

