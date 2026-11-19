// Removes the worktree of a done task (and its local branch once merged), on
// the machine its worker ran on, with git worktree remove: forced only past its
// own check that nothing changed or new is in it (WORKTREE_REMOVE_SCRIPT), never rm, once every process working in it is killed. Each removal, and each worktree kept with why, goes to the task's
// log (shared/pm/cleanup.ts decides). Runs once a done task's agents have
// ended (pmAdvance.ts), on Archive, and in
// a sweep at start and every few hours for leftovers.
import { exec, runOn, type PmLaunchDeps } from './pmLaunch'
import { contextBase, staleSnapshots } from '../../shared/pm/context'
import { homeOf } from './coreCreate'
import { taskPaths, taskPlan } from '../../shared/pm/run'
import { cloneOn } from '../../shared/pm/project'
import { cleanupOf, cleanupRefusal, factsRefusal, mergedCommit, parseFacts } from '../../shared/pm/cleanup'
import { KILL_UNDER } from '../../shared/pm/procs'
import { countKilled } from './pmProcs'
import { pmDir } from './pmHome'

// $admin: the worktree's folder in the repository's git dir, found from the
// repository (its own .git file may be gone when a removal stopped halfway).
const ADMIN_OF = `admin=
common=$(cd "$repo" && cd "$(git rev-parse --git-common-dir)" && pwd) || exit 1
for f in "$common"/worktrees/*/gitdir; do [ "$(cat "$f" 2>/dev/null)" = "$dir/.git" ] && admin=\${f%/gitdir}; done
wt() { if [ -n "$admin" ]; then git --git-dir="$admin" --work-tree="$dir" "$@"; else git -C "$dir" "$@"; fi; }`

// Tracked files only deleted (` D`): what a removal stopped halfway leaves. Nothing
// is lost removing them (their content is in the commit), so they are no change.
const CHANGES = `grep -v '^ D ' | grep -c .`

// Prints `exists listed dirty unique` (see Facts). $4: the commit its merge step
// proved merged, whose history counts as merged (ignored when unknown here).
export const WORKTREE_PROBE_SCRIPT = `repo=$1 dir=$2 branch=$3 merged=
[ -n "$4" ] && git -C "$repo" cat-file -e "$4^{commit}" 2>/dev/null && merged=$4
e=0 l=0 d=0 refs=
if [ -d "$dir" ]; then e=1
  git -C "$repo" worktree list --porcelain | grep -qxF "worktree $dir" && l=1
  if [ $l = 1 ]; then
    ${ADMIN_OF}
    s=$(wt status --porcelain) || exit 1
    d=$(printf '%s\\n' "$s" | ${CHANGES})
    refs=$(wt rev-parse HEAD) || exit 1
  fi
fi
git -C "$repo" rev-parse -q --verify "refs/heads/$branch" >/dev/null && refs="$refs refs/heads/$branch"
u=0
if [ -n "$refs" ]; then u=$(git -C "$repo" rev-list --count $refs --not $merged --exclude="$branch" --branches --remotes) || exit 1; fi
echo "$e $l $d $u"`

// The removal's own timeout (s): a worktree of several GB takes minutes. Its size
// is measured first within DU_TIMEOUT (timeout, or gtimeout on macOS), or not
// said: with neither, never measured (an unbounded du could eat the timeout).
export const WORKTREE_REMOVE_TIMEOUT = 600
const DU_TIMEOUT = 30

// The lock a removal puts on the worktree first, so that \`git worktree prune\`
// (here or in any start's snapshot) never forgets one a timeout stopped halfway
// whose .git file is already gone: git removes the lock last, with the rest.
export const REMOVING = 'wherdr: removing it'

// $4 = 1: the local branch goes too. The processes working in it go first
// (\`killed <n>\`), so none runs on in a removed folder; \`freed <KB>\` is its size.
// Then checked here, as git would: anything changed or new keeps it (exit 3);
// tracked files only deleted are what an earlier removal stopped halfway left,
// finished. Locked, git removes it only with -f -f, which this check stands for
// (ignored files go either way); one locked by someone else stays. Kept, it
// stays locked: still usable, never pruned.
export const WORKTREE_REMOVE_SCRIPT = `repo=$1 dir=$2 branch=$3
${KILL_UNDER}
if [ -d "$dir" ]; then
  ${ADMIN_OF}
  force=
  if [ -n "$admin" ]; then
    if [ -f "$admin/locked" ]; then
      [ "$(cat "$admin/locked")" = "${REMOVING}" ] || { echo "locked: $(head -c 200 "$admin/locked")"; exit 3; }
    else git -C "$repo" worktree lock --reason "${REMOVING}" "$dir" 2>&1 || exit 1
    fi
    force='-f -f'
    s=$(wt status --porcelain) || exit 1
    n=$(printf '%s\\n' "$s" | ${CHANGES})
    [ "$n" = 0 ] || { echo "$n uncommitted change(s)"; exit 3; }
    [ -e "$dir/.git" ] || printf 'gitdir: %s\\n' "$admin" > "$dir/.git" || exit 1
  fi
  t=$(command -v timeout || command -v gtimeout) && echo "freed $("$t" ${DU_TIMEOUT} du -sk "$dir" 2>/dev/null | cut -f1)"
  git -C "$repo" worktree remove $force "$dir" 2>&1 || exit 1
fi
git -C "$repo" worktree prune 2>&1
[ "$4" = 1 ] || exit 0
git -C "$repo" rev-parse -q --verify "refs/heads/$branch" >/dev/null || exit 0
git -C "$repo" branch -D "$branch" 2>&1`

// The context snapshots (shared/pm/context.ts) under $1, one folder per member and
// commit (with its .ok marker and a .lock while one is made), not touched for an
// hour: every use of a snapshot touches it, and one just made may not be on its
// run's record yet.
export const CONTEXT_LIST_SCRIPT = `find "$1" -mindepth 2 -maxdepth 2 \\( -type d -o -name '*.ok' \\) -mmin +60 2>/dev/null; exit 0`

// One entry ($1, two levels under the context folder $2) removed: a snapshot
// through the clone it belongs to (its .git file names it), writable again first;
// when that clone or its record is gone, or the folder was never complete, the
// folder itself (never anything outside $2). A leftover lock goes; a marker only
// when its folder is gone.
export const CONTEXT_REMOVE_SCRIPT = `dir=$1 base=$2
case $dir in *..*) exit 3;; esac
case $dir in "$base"/?*/?*) ;; *) exit 3;; esac
case $dir in
  *.lock) rmdir "$dir" 2>/dev/null;;
  *.ok) [ -d "\${dir%.ok}" ] || rm -f "$dir";;
  *)
    chmod -R u+w "$dir" 2>/dev/null
    g=$(sed -n 's/^gitdir: //p' "$dir/.git" 2>/dev/null)
    common=\${g%/worktrees/*}
    [ -n "$g" ] && [ -d "$common" ] && git --git-dir="$common" worktree remove --force "$dir" >/dev/null 2>&1
    if [ -e "$dir" ]; then rm -rf "$dir" || exit 1; fi
    rm -f "$dir.ok"
    [ -n "$g" ] && [ -d "$common" ] && git --git-dir="$common" worktree prune >/dev/null 2>&1;;
esac
rmdir "$(dirname "$dir")" 2>/dev/null
exit 0`

type Deps = Omit<PmLaunchDeps, 'origin'>
const busy = new Set<string>()

// The task's cleanup, once: an unreachable machine or a git error leaves it
// for the next sweep; a reason to keep the worktree is logged once.
export async function cleanTask(deps: Deps, id: string) {
  if (busy.has(id)) return
  busy.add(id)
  try { await clean(deps, id) } finally { busy.delete(id) }
}

async function clean(deps: Deps, id: string) {
  const { store } = deps
  const task = await store.task(id)
  const kind = task && cleanupOf(task)
  if (!task || !kind || task.cleanup?.done) return
  const p = (await store.projects()).find(x => x.key === task.project)
  if (!p) return
  const runs = await store.runs()
  const run = runs.filter(r => r.task === task.id && r.role === 'worker').sort((a, b) => b.startedAt - a.startedAt)[0]
  const finish = async (text?: string) => {
    const fresh = (await store.task(id)) ?? task
    const out = { ...fresh, cleanup: { done: true as const } }
    return text ? store.logTask(out, 'engine', text) : store.saveTask(out)
  }
  const keep = async (why: string) => {
    const fresh = (await store.task(id)) ?? task
    if (fresh.cleanup?.skipped !== why) await store.logTask({ ...fresh, cleanup: { skipped: why } }, 'engine', `worktree kept: ${why}`)
  }
  if (!run) return finish() // never started: no worktree
  if (!cloneOn(p, run.machine, '~')) return keep('wherdr knows no clone of the project on its machine (no longer allowed for the project)')
  const on = runOn(deps, run)
  const home = await homeOf(deps, on)
  if (!home) return
  const repo = cloneOn(p, run.machine, home)!
  const root = taskPaths(home, task.id, undefined, pmDir()).worktree.replace(/\/[^/]+$/, '')
  const refused = cleanupRefusal(task, runs, run.worktree, root)
  if (refused) return keep(refused)
  // Squash-merged, its commits are on no other branch: the commit its merge step proved merged covers them.
  const t = await store.workflow(p.key)
  const merged = (t && mergedCommit(taskPlan(t, task, p), task.step)) || ''
  const probe = await exec(deps, on, WORKTREE_PROBE_SCRIPT, [repo, run.worktree, run.branch, merged])
  const facts = probe.code === 0 ? parseFacts(probe.out) : undefined
  if (!facts) return
  const why = factsRefusal(facts)
  if (why) return keep(why)
  // Its local branch follows Delete the task's branch after its merge.
  const branch = kind === 'worktree+branch' && p.deleteBranch !== false
  const r = await exec(deps, on, WORKTREE_REMOVE_SCRIPT, [repo, run.worktree, run.branch, branch ? '1' : '0'], undefined, WORKTREE_REMOVE_TIMEOUT)
  const n = Number(/^killed (\d+)$/m.exec(r.out)?.[1] ?? 0)
  if (n) countKilled(run.machine, n)
  if (r.code === 3) return keep(r.out.split('\n').pop()!)
  if (r.code !== 0) return keep(`git could not remove it: ${r.out.split('\n').pop()?.slice(0, 200) || 'timeout'}`)
  const kb = Number(/^freed (\d+)$/m.exec(r.out)?.[1] ?? 0)
  const freed = kb ? ` (${kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.ceil(kb / 1024)} MB`} freed)` : ''
  const what = (n ? `killed ${n} process${n === 1 ? '' : 'es'} working in it, then ` : '') + (facts.exists ? `removed its worktree${freed}` : 'its worktree was already gone')
  console.log(`[pm] ${task.id}: ${what}`)
  return finish(branch ? `${what} and its local branch ${run.branch}` : `${what}; its branch ${run.branch} stays`)
}

// Context snapshots no unfinished task's latest worker or reviewer reads any more,
// on each machine a run got some on (an unreachable one waits for the next sweep).
async function sweepContext(deps: Deps) {
  const [tasks, runs] = [await deps.store.tasks(), await deps.store.runs()]
  for (const machine of new Set(runs.filter(r => r.context?.length).map(r => r.machine))) {
    try {
      const on = runOn(deps, { machine }), home = await homeOf(deps, on)
      if (!home) continue
      const base = contextBase(home, pmDir())
      const listed = await exec(deps, on, CONTEXT_LIST_SCRIPT, [base])
      if (listed.code !== 0) continue
      for (const dir of staleSnapshots(listed.out.split('\n').filter(Boolean), base, machine, tasks, runs)) {
        const r = await exec(deps, on, CONTEXT_REMOVE_SCRIPT, [dir, base])
        if (r.code !== 0) console.warn(`[pm] context snapshot ${dir} stays: ${r.out.split('\n').pop()?.slice(0, 200) || 'timeout'}`)
      }
    } catch { /* the next sweep tries again */ }
  }
}

// Leftovers: every done or archived task whose worktree was not removed yet,
// then the context snapshots nothing needs.
export async function sweepWorktrees(deps: Deps) {
  if (!(await deps.store.enabled())) return
  for (const t of await deps.store.tasks())
    if (cleanupOf(t) && !t.cleanup?.done) await cleanTask(deps, t.id).catch(() => {})
  await sweepContext(deps)
}
