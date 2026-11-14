// Removes the worktree of a done task (and its local branch once merged), on
// the machine its worker ran on, with git worktree remove: never a forced removal,
// never rm, once every process working in it is killed. Each removal, and each worktree kept with why, goes to the task's
// log (shared/pm/cleanup.ts decides). Runs once a done task's agents have
// ended (pmAdvance.ts), on Archive, and in
// a sweep at start and every few hours for leftovers.
import { exec, runOn, type PmLaunchDeps } from './pmLaunch'
import { homeOf } from './coreCreate'
import { taskPaths } from '../../shared/pm/run'
import { cloneOn } from '../../shared/pm/project'
import { cleanupOf, cleanupRefusal, factsRefusal, parseFacts } from '../../shared/pm/cleanup'
import { KILL_UNDER } from '../../shared/pm/procs'
import { countKilled } from './pmProcs'

// Prints `exists listed dirty unique` (see Facts).
export const WORKTREE_PROBE_SCRIPT = `repo=$1 dir=$2 branch=$3
e=0 l=0 d=0 refs=
if [ -d "$dir" ]; then e=1
  git -C "$repo" worktree list --porcelain | grep -qxF "worktree $dir" && l=1
  if [ $l = 1 ]; then
    s=$(git -C "$dir" status --porcelain) || exit 1
    d=$(printf '%s\\n' "$s" | grep -c .)
    refs=$(git -C "$dir" rev-parse HEAD) || exit 1
  fi
fi
git -C "$repo" rev-parse -q --verify "refs/heads/$branch" >/dev/null && refs="$refs refs/heads/$branch"
u=0
if [ -n "$refs" ]; then u=$(git -C "$repo" rev-list --count $refs --not --exclude="$branch" --branches --remotes) || exit 1; fi
echo "$e $l $d $u"`

// $4 = 1: the local branch goes too. The processes working in it go first
// (\`killed <n>\`), so none runs on in a removed folder.
export const WORKTREE_REMOVE_SCRIPT = `repo=$1 dir=$2 branch=$3
${KILL_UNDER}
if [ -d "$dir" ]; then git -C "$repo" worktree remove "$dir" 2>&1 || exit 1; fi
git -C "$repo" worktree prune 2>&1
[ "$4" = 1 ] || exit 0
git -C "$repo" rev-parse -q --verify "refs/heads/$branch" >/dev/null || exit 0
git -C "$repo" branch -D "$branch" 2>&1`

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
  const root = taskPaths(home, task.id).worktree.replace(/\/[^/]+$/, '')
  const refused = cleanupRefusal(task, runs, run.worktree, root)
  if (refused) return keep(refused)
  const probe = await exec(deps, on, WORKTREE_PROBE_SCRIPT, [repo, run.worktree, run.branch])
  const facts = probe.code === 0 ? parseFacts(probe.out) : undefined
  if (!facts) return
  const why = factsRefusal(facts)
  if (why) return keep(why)
  const branch = kind === 'worktree+branch'
  const r = await exec(deps, on, WORKTREE_REMOVE_SCRIPT, [repo, run.worktree, run.branch, branch ? '1' : '0'])
  const n = Number(/^killed (\d+)$/m.exec(r.out)?.[1] ?? 0)
  if (n) countKilled(run.machine, n)
  if (r.code === 3) return keep(r.out.split('\n').pop()!)
  if (r.code !== 0) return keep(`git could not remove it: ${r.out.split('\n').pop()?.slice(0, 200) || 'timeout'}`)
  const what = (n ? `killed ${n} process${n === 1 ? '' : 'es'} working in it, then ` : '') + (facts.exists ? 'removed its worktree' : 'its worktree was already gone')
  return finish(branch ? `${what} and its local branch ${run.branch}` : `${what}; its branch ${run.branch} stays`)
}

// Leftovers: every done or archived task whose worktree was not removed yet.
export async function sweepWorktrees(deps: Deps) {
  if (!(await deps.store.enabled())) return
  for (const t of await deps.store.tasks())
    if (cleanupOf(t) && !t.cleanup?.done) await cleanTask(deps, t.id).catch(() => {})
}
