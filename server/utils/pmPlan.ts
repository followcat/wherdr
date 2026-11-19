// A feature's plan file (shared/pm/planRefs.ts), on the workspace's machine,
// under its root: read for `feature split --from`, `feature close` and the
// write-back, and written back by the engine (never the coordinator: its edits
// in the root are denied) once a sub-task with refs is done. Each script
// resolves symlinks first and refuses a file outside the real root (or inside
// a .git folder), as repo adopt does; the write-back touches the plan file only.
import { endsMerged } from '../../shared/pm/actions'
import { planCommitMessage, skippedText, tickPlan } from '../../shared/pm/planRefs'
import { shownTaskId } from '../../shared/pm/projectKey'
import { effectiveProject, isRootMember, membersOf, workspaceOf } from '../../shared/pm/workspace'
import { taskPlan, type Task } from '../../shared/pm/run'
import type { Project } from '../../shared/pm/project'
import { machineOn } from './coreCreate'
import { HerdrError } from './herdr'
import { notificationAllowed } from './notificationRules'
import { exec, type PmLaunchDeps } from './pmLaunch'
import { wakeCoordinators } from './pmWakes'
import { pushSend } from './push'

// $1: the root, $2: the file (relative to it; an absolute path inside it works too).
// The real root and file (every symlink followed, the file's own too) or an exit:
// 3 the file leads outside the root or into a .git folder, 4 it is not a file.
const RESOLVE = `root=$1
case $root in "~"|"~/"*) root="$HOME\${root#"~"}";; esac
r=$(cd -P "$root" 2>/dev/null && pwd) || exit 1
case $2 in "~"|"~/"*) full="$HOME\${2#"~"}";; /*) full=$2;; *) full="$r/$2";; esac
real() {
  p=$1 n=0
  while :; do
    d=$(cd -P "$(dirname "$p")" 2>/dev/null && pwd) || return 1
    p=$d/$(basename "$p")
    [ -L "$p" ] && [ "$n" -lt 20 ] || break
    l=$(readlink "$p") || return 1
    case $l in /*) p=$l;; *) p=$d/$l;; esac
    n=$((n + 1))
  done
  printf '%s' "$p"
}
f=$(real "$full") || exit 4
case $f in "$r"/*) ;; *) exit 3;; esac
case $f in */.git/*) exit 3;; esac
[ -f "$f" ] || exit 4`

// $3: the most bytes it may have (exit 2 above). Prints the file, base64 (nothing is trimmed).
export const PLAN_READ_SCRIPT = `${RESOLVE}
[ "$(wc -c < "$f")" -le "$3" ] || exit 2
base64 < "$f" | tr -d '\\n'`

export const COMMIT_SECONDS = 45

// $3: the branch the root must be on ('': origin's default branch), $4: the byte length of the file as it was read,
// $5: the commit message. stdin: the file as it was read, then the new one. Nothing is written
// (the file stays as it was) and the exit says why:
//   5 the file changed since it was read, 12 a rebase, merge, cherry-pick, revert or bisect is
//   under way (printing which), 13 git's index is locked: these pass, so they are tried again;
//   6 the root is on another branch than $3 (printing it), 11 on no branch (a detached HEAD),
//   7 the plan file has local changes (staged or not), 8 it is not tracked, 9 the commit failed
//   (printing git's last words), 10 it took over ${COMMIT_SECONDS} seconds, 14 the file is in another
//   git repository than the root's own (a member's clone, or a root inside a larger repository),
//   15 no branch to check the root against (no base, no origin's default branch): final.
// A git root commits that file only (commit --only: other staged or unstaged work stays as it
// is, no prompt: GIT_TERMINAL_PROMPT=0; no hook either, so no formatter or lint-staged touches
// other files); a commit that fails puts the old text back, but only
// while the file still holds the new one. The file is written beside itself and moved into
// place, so no reader sees half of it. A root with no git just gets the file.
export const PLAN_WRITE_SCRIPT = `${RESOLVE}
export GIT_TERMINAL_PROMPT=0
tmp=
t=$(mktemp -d "\${TMPDIR:-/tmp}/wherdr-plan.XXXXXX") || exit 1
trap 'rm -rf "$t"; [ -z "$tmp" ] || rm -f "$tmp"' EXIT
cat > "$t/in" || exit 1
head -c "$4" "$t/in" > "$t/old"
tail -c +"$(($4 + 1))" "$t/in" > "$t/new"
cmp -s "$t/old" "$f" || exit 5
put() {
  tmp=$(mktemp "$f.wherdr.XXXXXX") || return 1
  cp -p "$f" "$tmp" 2>/dev/null
  cat "$1" > "$tmp" && mv "$tmp" "$f" || return 1
  tmp=
}
limited() {
  if command -v timeout >/dev/null 2>&1; then timeout "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$@"
  else
    s=$1; shift
    "$@" & c=$!
    (sleep "$s"; kill "$c") >/dev/null 2>&1 & w=$!
    wait "$c"; x=$?
    kill "$w" 2>/dev/null
    return "$x"
  fi
}
top=$(git -C "$(dirname "$f")" rev-parse --show-toplevel 2>/dev/null)
if [ -n "$top" ] && [ "$top" != "$r" ]; then exit 14; fi
if [ -n "$top" ]; then
  for x in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG index.lock; do
    p=$(git -C "$r" rev-parse --git-path "$x") || exit 1
    case $p in /*) ;; *) p=$r/$p;; esac
    [ -e "$p" ] || continue
    [ "$x" = index.lock ] && exit 13
    echo "$x"; exit 12
  done
  git -C "$r" symbolic-ref -q HEAD >/dev/null || exit 11
  cur=$(git -C "$r" symbolic-ref -q --short HEAD)
  want=$3
  [ -n "$want" ] || want=$(git -C "$r" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
  git -C "$r" ls-files --error-unmatch -- "$f" >/dev/null 2>&1 || exit 8
  git -C "$r" diff --quiet -- "$f" && git -C "$r" diff --cached --quiet -- "$f" || exit 7
  # An index flag that hides edits (assume-unchanged, skip-worktree), or a file whose
  # content is not HEAD's whatever git's flags say: local changes all the same.
  case $(git -C "$r" ls-files -v -- "$f") in "H "*) ;; *) exit 7;; esac
  rel=$(git -C "$r" ls-files --full-name -- "$f")
  [ "$(git -C "$r" hash-object -- "$f")" = "$(git -C "$r" rev-parse -q --verify "HEAD:$rel")" ] || exit 7
  [ -n "$want" ] || exit 15
  if [ "$cur" != "$want" ]; then echo "$cur"; echo "$want"; exit 6; fi
  put "$t/new" || exit 1
  out=$(limited ${COMMIT_SECONDS} git -C "$r" -c core.hooksPath=/dev/null commit --only -m "$5" -- "$f" 2>&1); c=$?
  if [ "$c" -ne 0 ]; then
    if cmp -s "$t/new" "$f"; then put "$t/old"; fi
    printf '%s\\n' "$out" | tail -n 3
    case $out in *index.lock*) exit 13;; esac
    case $c in 124|143) exit 10;; esac
    exit 9
  fi
  echo "committed $(git -C "$r" rev-parse --short HEAD)"
else
  put "$t/new" || exit 1
  echo written
fi`

export const PLAN_CAP = 2_000_000

export type PlanRead = { text: string } | { why: string }
const readWhy: Record<number, string> = { 2: 'is too large', 3: 'is outside the workspace\'s root', 4: 'was not found' }

// The file under the workspace's root, on its machine: its text, or why not
// (outside the root, symlinks resolved; not a file; too large). An unreachable
// machine or a failing script throws.
export async function readPlanFile(deps: Pick<PmLaunchDeps, 'call' | 'machines'>, ws: Project, file: string, cap = PLAN_CAP): Promise<PlanRead> {
  const r = await exec(deps, machineOn(deps, ws.machine).on, PLAN_READ_SCRIPT, [ws.path, file, String(cap)])
  if (r.code !== null && readWhy[r.code]) return { why: `${file} ${readWhy[r.code]}` }
  if (r.code !== 0) throw new HerdrError('core', `Could not read ${file} on the workspace's machine`)
  const raw = Buffer.from(r.out, 'base64'), text = raw.toString('utf8')
  // Written back as text: a file that is not UTF-8 would change.
  return Buffer.from(text, 'utf8').equals(raw) ? { text } : { why: `${file} is not UTF-8 text` }
}

// The write script's arguments and input: the plan file as it was read and as it will be.
export function planWriteCall(ws: Pick<Project, 'path'>, file: string, base: string, before: string, after: string, message: string) {
  return { args: [ws.path, file, base, String(Buffer.byteLength(before)), message], input: before + after }
}

const underway: Record<string, string> = { 'rebase-merge': 'rebase', 'rebase-apply': 'rebase', MERGE_HEAD: 'merge', CHERRY_PICK_HEAD: 'cherry-pick', REVERT_HEAD: 'revert', BISECT_LOG: 'bisect' }

// What a write's exit means: done, again (it passes: said, tried again later), or skipped for good with why.
// An exec that timed out (code null) is final: the script may have run on.
export function planWriteResult(code: number | null, out: string, file: string, base: string): { done: string } | { again: string } | { skipped: string } {
  if (code === 0) return { done: out.startsWith('committed ') ? `committed ${out.slice(10).trim()}` : 'written, the root has no git' }
  if (code === null) return { skipped: `writing ${file} timed out: look at it before ticking by hand` }
  const again: Record<number, string> = {
    5: `${file} changed while it was being ticked`, 12: `a ${underway[out.split('\n')[0] ?? ''] ?? 'git operation'} is under way in the root`, 13: 'git\'s index is locked (another git command is running)',
  }
  if (again[code]) return { again: again[code]! }
  const why: Record<number, string> = {
    3: `${file} is outside the workspace's root`, 4: `${file} was not found`, 7: `${file} has local changes`, 8: `${file} is not tracked by git`, 11: 'the root is on no branch (a detached HEAD)',
    6: `the root is on branch ${out.split('\n')[0] || '?'}${(out.split('\n')[1] || base) ? ` (not ${out.split('\n')[1] || base})` : ''}`, 9: `git could not commit it: ${out.split('\n').pop() ?? ''}`.trim(),
    10: `git took more than ${COMMIT_SECONDS} seconds to commit it`, 14: `${file} is in another git repository than the root's (a member's clone): its own tasks change it`,
    15: 'no branch to check the root against: set the workspace\'s base branch (or the root member\'s)',
  }
  const skipped = why[code]
  if (!skipped) throw new HerdrError('core', `Could not write ${file} on the workspace's machine (exit ${code})`)
  return { skipped }
}

// The date written on a ticked line: today in UTC, whatever machine wherdr or the plan is on.
export const planDate = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

// A write that has to wait is tried again at most every RETRY_MS, PLAN_TRIES times or PLAN_TRY_MS in all.
export const PLAN_RETRY_MS = 5 * 60_000
export const PLAN_TRIES = 12
export const PLAN_TRY_MS = 3_600_000

// Told to the user when plan lines stay unticked: a notification, like a stalled task's, to its sheet.
export type PlanNotify = (task: Task, shown: string, file: string, why: string) => Promise<unknown>
const pushNotify: PlanNotify = async (task, shown, file, why) =>
  await notificationAllowed('needs-you', { workspaces: [] }, undefined, { machine: task.machine ?? '', project: task.project, board: true })
    ? pushSend({ title: `${shown}: plan lines not ticked`, body: `${file}: ${why}`.slice(0, 200), tag: `pm-plan-${task.id}`, url: `/#/board?task=${encodeURIComponent(task.id)}` })
    : 0

let chain: Promise<unknown> = Promise.resolve()
const inFlight = new Set<string>()

// A done task's refs ticked in its feature's plan file, once. Done with its
// whole workflow (not abandoned), as `mergeAfter` waits count it. A result is
// kept on the task (planTick). A skip for good is logged, the user is
// notified and the workspace's coordinator woken (its autopilot on); so is a
// pass that ticks nothing (every line missing or ticked). What passes (a lock,
// a rebase under way, a file changed meanwhile) is tried again, bounded
// (planTries); an unreachable machine is said once and waited for. A pass
// already running for the task is not queued again.
export async function tickPlanFile(deps: PmLaunchDeps, id: string, opts: { notify?: PlanNotify, now?: number } = {}): Promise<void> {
  if (inFlight.has(id)) return
  inFlight.add(id)
  // One at a time: two done tasks never write the same file at once.
  const run = chain.catch(() => {}).then(() => tick(deps, id, opts.notify ?? pushNotify, opts.now ?? Date.now()))
  chain = run
  try { await run } finally { inFlight.delete(id) }
}

async function tick(deps: PmLaunchDeps, id: string, notify: PlanNotify, now: number) {
  const { store } = deps
  const task = await store.task(id)
  if (!task?.refs?.length || !task.feature || task.planTick || !task.step?.done || task.step.abandoned) return
  const waiting = task.planTries
  if (waiting && !waiting.offline && now - waiting.at < PLAN_RETRY_MS) return
  const projects = await store.projects()
  const p = projects.find(x => x.key === task.project), ws = p && workspaceOf(p, projects)
  const feature = await store.task(task.feature), file = feature?.plan?.file
  if (!p || !ws || !file) return
  const shown = shownTaskId(projects, id), refs = task.refs.join(', ')
  const root = membersOf(ws.key, projects).find(m => isRootMember(m, ws))
  const effective = root ? effectiveProject(root, ws) : undefined
  // Final: kept on the task, logged, told to the user and to the coordinator.
  const told = async (why: string, text: string, kept: Task['planTick']) => {
    await store.updateTask(id, t => ({ ...t, planTick: kept, planTries: undefined }), { by: 'engine', text })
    await notify(task, shown, file, why).catch(() => {})
    await wakeCoordinators(deps, task, `${shown} is done, but its plan lines ${refs} are not ticked in ${file}: ${why}. wherdr ticks them only when that is safe, never over local work: tell the user, who can fix it (commit or discard the change, or switch the root back to its branch) and tick them by hand, or leave them.`, now).catch(() => {})
  }
  const skip = (why: string) => told(why, `plan: ${refs} not ticked in ${file}: ${why}`, { at: now, skipped: why })
  // Passes: tried again later, up to the bound, then final.
  const again = async (why: string) => {
    const n = (waiting?.n ?? 0) + 1, first = waiting?.first ?? now
    if (n >= PLAN_TRIES || now - first >= PLAN_TRY_MS) return skip(`${why}, still after ${n} tries`)
    await store.updateTask(id, t => ({ ...t, planTries: { n, first, at: now, why } }), n === 1 ? { by: 'engine', text: `plan: ${refs} not ticked yet in ${file}: ${why}; wherdr tries again` } : undefined)
  }
  try {
    const read = await readPlanFile(deps, ws, file)
    if ('why' in read) return await skip(read.why)
    // The merge's commit, when the task's merge step kept it.
    const t = await store.workflow(p.key), plan = t ? taskPlan(t, task, p) : []
    const sha = plan.map(s => (s.action && endsMerged(s.action.kind) ? task.step!.proofs[s.id]?.commit : undefined)).findLast(Boolean)?.slice(0, 7)
    const ticked = tickPlan(read.text, task.refs, { task: shown, date: planDate(now), ...(sha ? { sha } : {}) })
    const left = skippedText(ticked.skipped)
    if (!ticked.ticked.length) return await told(left.replace(/plan: /g, ''), left, { at: now, ticked: [] })
    const message = planCommitMessage(effective ? effective.commitMessage : ws.shared?.commitMessage, shownTaskId(projects, feature!.id), { ...task, id: shown }, ticked.ticked)
    const base = effective?.base ?? ws.shared?.base ?? ''
    const call = planWriteCall(ws, file, base, read.text, ticked.text, message)
    const w = await exec(deps, machineOn(deps, ws.machine).on, PLAN_WRITE_SCRIPT, call.args, call.input, COMMIT_SECONDS + 45)
    const result = planWriteResult(w.code, w.out, file, base)
    if ('again' in result) return await again(result.again)
    if ('skipped' in result) return await skip(result.skipped)
    await store.updateTask(id, x => ({ ...x, planTick: { at: now, ticked: ticked.ticked }, planTries: undefined }), { by: 'engine', text: [`plan: ticked ${ticked.ticked.join(', ')} in ${file} (${result.done})`, left].filter(Boolean).join('; ') })
  } catch (e) {
    // An unreachable machine is said once, then waited for; any other failure of a script counts as a try.
    if (e instanceof HerdrError && (e.code === 'unreachable' || e.code === 'bad_machine')) {
      if (!waiting?.offline) await store.updateTask(id, x => ({ ...x, planTries: { n: waiting?.n ?? 0, first: waiting?.first ?? now, at: now, offline: true } }), { by: 'engine', text: `plan: ${refs} not ticked yet in ${file}: ${e.message}; wherdr tries again when the machine is back` })
      return
    }
    return again((e as Error).message)
  }
}
