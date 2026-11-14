// A new task worktree's setup (the workflow's `worktree` block), before its
// worker's first start: ignored files copied from the project's clone, big
// rebuildable folders (node_modules) taken from the clone while the lockfile
// is the same in both, else the project's setup command. Its result goes to
// the task's log and to the worker's instructions, so it does not reinstall.
//
// A shared folder is a copy, never a link or hard links: a task that writes
// into it (npm ci, a patch, a tool's cache) leaves the clone's alone. On a
// copy-on-write file system (APFS, btrfs, XFS) the copy shares the blocks;
// elsewhere it is a plain copy, still much lighter than npm ci (no network, no
// resolver, a few MB of memory instead of about 1 GB).
import { SETUP_TIMEOUT, durationSecs, type Template, type WorktreeSetup } from '../../shared/pm/workflow'
import { PATH_SETUP, type CoreAdminDeps } from './coreCreate'
import { exec } from './pmLaunch'

// Arguments: clone, worktree, lockfile, then the files to copy and the
// folders to share, each list one path per line. Prints one line per path,
// `copy ok|kept|tracked|missing|failed <path>` and `share ok|kept <path>` or
// `share no <path> nolock|differs|absent|stale|failed`, then `need` when the
// setup command is due: a folder was not shared, or none is listed, and the
// command has not succeeded in this worktree yet (a marker in its git folder).
export const SETUP_SCRIPT = `repo=$1 dir=$2 lock=$3 copy=$4 share=$5
g=$(git -C "$dir" rev-parse --absolute-git-dir) || exit 1
need=; [ -n "$share" ] || need=1
IFS='
'
for f in $copy; do
  if git -C "$dir" ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then echo "copy tracked $f"
  elif [ -e "$dir/$f" ]; then echo "copy kept $f"
  elif [ ! -e "$repo/$f" ]; then echo "copy missing $f"
  elif mkdir -p "$(dirname "$dir/$f")" && cp -Rp "$repo/$f" "$dir/$f"; then echo "copy ok $f"
  else echo "copy failed $f"; fi
done
for f in $share; do
  src=$repo/$f mark=$repo/$f; [ -f "$src/.package-lock.json" ] && mark=$src/.package-lock.json
  if [ -e "$dir/$f" ]; then echo "share kept $f"; continue; fi
  if [ ! -f "$dir/$lock" ]; then why=nolock
  elif ! cmp -s "$repo/$lock" "$dir/$lock"; then why=differs
  elif [ ! -e "$src" ]; then why=absent
  elif [ "$repo/$lock" -nt "$mark" ]; then why=stale
  else
    why=failed tmp=$dir/$f.wherdr-partial
    for how in "-a --reflink=auto" "-cRp" "-Rp"; do
      rm -rf "$tmp"; unset IFS; cp $how "$src" "$tmp" 2>/dev/null && mv "$tmp" "$dir/$f" && { why=; break; }
    done
    IFS='
'; rm -rf "$tmp"
  fi
  if [ -z "$why" ]; then echo "share ok $f"; else echo "share no $f $why"; need=1; fi
done
[ -f "$g/wherdr-setup.failed" ] && need=1
[ -f "$g/wherdr-setup" ] && [ ! -f "$g/wherdr-setup.failed" ] && need=
[ -n "$need" ] && echo need
exit 0`

// The setup command, in the worktree: prints `run <code> <seconds>`, then its
// last output lines (`out <line>`) when it fails. Its output stays in the git
// folder (wherdr-setup.log), read back when it runs past its time. PATH_SETUP:
// node and the rest from Homebrew or nvm, as a login shell would find them.
export const RUN_SCRIPT = `${PATH_SETUP}
dir=$1 cmd=$2
g=$(git -C "$dir" rev-parse --absolute-git-dir) || exit 1
: > "$g/wherdr-setup.failed"; start=$(date +%s)
(cd "$dir" && sh -c "$cmd") > "$g/wherdr-setup.log" 2>&1 </dev/null; code=$?
echo "run $code $(( $(date +%s) - start ))"
if [ "$code" = 0 ]; then rm -f "$g/wherdr-setup.failed"; : > "$g/wherdr-setup"; else tail -n 20 "$g/wherdr-setup.log" | sed 's/^/out /'; fi`
const TAIL_SCRIPT = 'tail -n 20 "$(git -C "$1" rev-parse --absolute-git-dir)/wherdr-setup.log"'

// No share list: node_modules, said nothing of in a project without the lockfile.
const shareOf = (w: WorktreeSetup) => w.share ?? ['node_modules']
const lockOf = (w: WorktreeSetup) => w.lockfile || 'package-lock.json'
const toSay = (r: SetupResult, w: WorktreeSetup) => (w.share ? r.notShared : r.notShared.filter(x => !x.why.startsWith('no ')))

export interface SetupResult {
  copied: string[], skipped: { path: string, why: string }[], shared: { path: string, kept: boolean }[]
  notShared: { path: string, why: string }[], need: boolean, ran?: { code: number | null, secs: number, tail: string }
}

export function setupOf(out: string, w: WorktreeSetup): SetupResult {
  const r: SetupResult = { copied: [], skipped: [], shared: [], notShared: [], need: false }
  const lock = lockOf(w)
  const WHY: Record<string, string> = { nolock: `no ${lock}`, differs: `${lock} differs from the clone's`, absent: 'not in the clone', stale: `not installed for its ${lock} in the clone`, failed: 'the copy failed', tracked: 'tracked by git', missing: 'not in the clone' }
  for (const line of out.split('\n')) {
    const [kind, how, ...rest] = line.trim().split(' ')
    if (kind === 'need') r.need = true
    if (kind === 'copy' && how && rest.length) {
      const path = rest.join(' ')
      if (how === 'ok') r.copied.push(path)
      else if (how !== 'kept') r.skipped.push({ path, why: WHY[how] ?? how })
    }
    if (kind === 'share' && how && rest.length) {
      if (how === 'no') r.notShared.push({ path: rest.slice(0, -1).join(' '), why: WHY[rest.at(-1)!] ?? rest.at(-1)! })
      else r.shared.push({ path: rest.join(' '), kept: how === 'kept' })
    }
  }
  return r
}

export function ranOf(out: string): { code: number | null, secs: number, tail: string } {
  const m = /^run (\d+) (\d+)$/m.exec(out)
  const tail = out.split('\n').filter(l => l.startsWith('out ')).map(l => l.slice(4)).join('\n')
  return { code: m ? Number(m[1]) : null, secs: m ? Number(m[2]) : 0, tail }
}

// The task log's line: what was copied, shared or skipped, and the command
// with its time ('' when there was nothing to do).
export function setupLog(r: SetupResult, w: WorktreeSetup): string {
  const quiet = toSay(r, w)
  const parts = [
    ...(r.copied.length ? [`copied ${r.copied.join(', ')}`] : []),
    ...(r.skipped.length ? [`not copied ${r.skipped.map(x => `${x.path} (${x.why})`).join(', ')}`] : []),
    ...(r.shared.some(x => !x.kept) ? [`shared ${r.shared.filter(x => !x.kept).map(x => x.path).join(', ')} from the clone`] : []),
    ...(quiet.length ? [`not shared ${quiet.map(x => `${x.path} (${x.why})`).join(', ')}`] : []),
    ...(r.ran ? [`ran ${w.command} (${r.ran.code === 0 ? `${r.ran.secs} s` : r.ran.code === null ? 'past its time limit' : `exit code ${r.ran.code}`})`] : []),
  ]
  return parts.length ? `worktree setup: ${parts.join('; ')}` : ''
}

// What the worker's instructions say was prepared, so it does not reinstall;
// nothing when there was nothing to say.
export function setupNote(r: SetupResult, w: WorktreeSetup): string | undefined {
  const lock = lockOf(w)
  const ready = [...r.copied.map(p => `${p} copied from the clone`), ...r.shared.map(x => `${x.path} ${x.kept ? 'kept from an earlier attempt' : 'shared from the clone'}`), ...(r.ran?.code === 0 ? [`\`${w.command}\` ran`] : [])]
  const todo = toSay(r, w)
  const lines = [
    ...(ready.length ? [`Worktree setup done by wherdr: ${ready.join('; ')}. Do not reinstall: run the install again only if ${lock} changes.`] : []),
    ...(todo.length && !r.ran ? [`Not prepared: ${todo.map(x => `${x.path} (${x.why})`).join(', ')}: ${lock === 'package-lock.json' ? 'run npm ci first' : 'set it up first'}.`] : []),
  ]
  return lines.length ? lines.join('\n') : undefined
}

// Runs the setup in a task's worktree. failed: why the worker may not start,
// with the command's last output (the task then waits for the user).
export async function prepareWorktree(deps: Pick<CoreAdminDeps, 'call'>, on: string | undefined, repo: string, worktree: string, t: Template): Promise<{ log: string, note?: string, failed?: string }> {
  const w = t.worktree ?? {}
  // A copy of a large node_modules on a cold disk can take minutes.
  const out = await exec(deps, on, SETUP_SCRIPT, [repo, worktree, lockOf(w), (w.copy ?? []).join('\n'), shareOf(w).join('\n')], undefined, 300).catch(() => ({ code: null, out: '' }))
  const r = setupOf(out.out, w)
  if (w.command?.trim() && r.need) {
    const secs = durationSecs(w.timeout ?? SETUP_TIMEOUT)
    const ran = await exec(deps, on, RUN_SCRIPT, [worktree, w.command], undefined, secs).catch(() => ({ code: null, out: '' }))
    r.ran = ranOf(ran.out)
    if (r.ran.code === null) r.ran.tail = (await exec(deps, on, TAIL_SCRIPT, [worktree]).catch(() => ({ out: '' }))).out
  }
  const failed = r.ran && r.ran.code !== 0
    ? `The worktree setup command failed: \`${w.command}\` ${r.ran.code === null ? `ran past its ${w.timeout ?? SETUP_TIMEOUT} limit` : `exited with code ${r.ran.code}`}. Last output:\n${r.ran.tail || '(none)'}`
    : undefined
  return { log: setupLog(r, w), note: setupNote(r, w), ...(failed ? { failed } : {}) }
}
