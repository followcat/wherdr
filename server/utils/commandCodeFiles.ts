// Bounded Command Code transcript metadata discovery, for the A5
// display-only session fallback. One bounded script round trip through
// ShellExec (machine.exec on a remote core host, localShell locally) lists
// every root/<one project dir>/<UUID>.jsonl with its file stat. No find, no
// per-file RPC: the script walks the two fixed levels itself so unreadable
// dirs and vanished files are reported, never silently dropped. Records are
// \x01-framed with base64 paths so newline/Unicode/metachar names cannot
// corrupt the stream; the record contract and snapshot parser live in
// commandCodeFileRecords.ts. A missing root is a COMPLETE empty snapshot;
// any unreadable/raced/capped evidence is INCOMPLETE, never a partial
// usable list.
import type { ShellExec } from './fsx'
import { cmdCanonicalPath, cmdProjectsRoot } from './commandCodeSessions'
import { type CmdFileSnapshot, parseCmdFiles } from './commandCodeFileRecords'

// Producer stdout is bounded BEFORE machine.exec serializes its reply:
// emit() stops at ~3 MiB and sets footer bit 4. Footer flags: 1 unreadable
// (root/dir/file/stat), 2 raced (listed entry vanished before its test), 4
// stdout overflow, 8 dir/file cap exhaustion. `T` carries dirs/files-found/
// records/flags; counts must agree with the emitted records, and every
// counted entry — symlinked, vanished, unreadable — spends from the same
// maxd/maxf budget before it is flagged and skipped.
// $1: projects root, $2: max project dirs, $3: max *.jsonl file entries.
export const CMD_FILES_SCRIPT = `P=$1
maxd=\${2:-4096}
maxf=\${3:-8192}
CAP=3000000
LC_ALL=C; export LC_ALL
n=0; f=0; r=0; o=0; ob=0
s1=$(printf '\\001')
emit() { l=\${#1}; [ $((ob + l)) -ge $CAP ] && { o=$((o|4)); return 1; }; ob=$((ob+l+1)); printf '%s\\n' "$1"; }
nd() { n=$((n+1)); [ "$n" -le "$maxd" ]; }
cf() { f=$((f+1)); [ "$f" -le "$maxf" ]; }
printf 'H\\n'
# Missing root is a complete empty snapshot; anything else about the root
# itself (symlink incl. dangling, non-dir, unreadable) is incomplete evidence,
# never usable. The -L test must precede -e: a dangling link fails -e and
# would otherwise fake an absent root.
if [ -L "$P" ]; then printf 'T 0 0 0 1\\n'; exit 0; fi
if [ ! -e "$P" ]; then printf 'T 0 0 0 0\\n'; exit 0; fi
if [ ! -d "$P" ] || [ ! -r "$P" ] || [ ! -x "$P" ]; then printf 'T 0 0 0 1\\n'; exit 0; fi
m=%.9Y; stat -c "$m" / 2>/dev/null | grep -q '^[0-9]*[.][0-9]' || m=%Y
for d in "$P"/* "$P"/.[!.]* "$P"/..?*; do
  # A literal glob pattern is "unmatched" only when its path is also absent
  # and not a symlink: a real entry named '*', '.[!.]*' or '..?*' expands to
  # the same string and must scan like any other metacharacter name.
  if { [ "$d" = "$P"'/*' ] || [ "$d" = "$P"'/.[!.]*' ] || [ "$d" = "$P"'/..?*' ]; } && [ ! -e "$d" ] && [ ! -L "$d" ]; then continue; fi
  if [ -L "$d" ]; then o=$((o|1)); nd || { o=$((o|8)); break; }; continue; fi  # symlink dir: incomplete, never followed
  if [ ! -e "$d" ]; then o=$((o|2)); nd || { o=$((o|8)); break; }; continue; fi # listed, then vanished: raced
  [ -d "$d" ] || continue                                                    # a plain file is not a project dir
  nd || { o=$((o|8)); break; }
  [ -r "$d" ] && [ -x "$d" ] || { o=$((o|1)); continue; }
  for g in "$d"/*.jsonl; do
    [ "$g" = "$d"'/*.jsonl' ] && [ ! -e "$g" ] && [ ! -L "$g" ] && continue    # unmatched glob literal
    if [ -L "$g" ]; then o=$((o|1)); cf || { o=$((o|8)); break 2; }; continue; fi  # symlink file: incomplete, never followed
    if [ ! -e "$g" ]; then o=$((o|2)); cf || { o=$((o|8)); break 2; }; continue; fi # listed, then vanished: raced
    [ -f "$g" ] || continue                                                     # posing directory: not a file entry
    if [ ! -r "$g" ]; then o=$((o|1)); cf || { o=$((o|8)); break 2; }; continue; fi # unreadable candidate: incomplete
    cf || { o=$((o|8)); break 2; }
    st=$(stat -c "%s $m %i %F" "$g" 2>/dev/null)
    if [ -z "$st" ]; then
      if [ -e "$g" ]; then o=$((o|1)); else o=$((o|2)); fi
      continue
    fi
    pb=$(printf %s "$g" | base64 | tr -d '\\n')
    emit "R$s1$pb$s1$st" && r=$((r+1)) || break 2
  done
done
printf 'T %s %s %s %s\\n' "$n" "$f" "$r" "$o"`

// One bounded round trip. A failed exec reports unavailable; a non-canonical
// root is rejected before the script ever runs.
export async function cmdFiles(exec: ShellExec, home: string, opts: { root?: string, timeoutMs?: number, maxDirs?: number, maxFiles?: number } = {}): Promise<CmdFileSnapshot> {
  const root = opts.root || cmdProjectsRoot(home)
  if (!cmdCanonicalPath(root)) return { complete: false, incomplete: 'metadata', files: [], dirs: 0, found: 0 }
  const args = [root, String(opts.maxDirs ?? 4096), String(opts.maxFiles ?? 8192)]
  const r = await exec(CMD_FILES_SCRIPT, args, { timeoutMs: opts.timeoutMs ?? 10000, maxBytes: 3 * 1024 * 1024 })
  if (r.code !== 0) return { complete: false, incomplete: 'unavailable', files: [], dirs: 0, found: 0 }
  return parseCmdFiles(root, r.stdout.toString('utf8'))
}
