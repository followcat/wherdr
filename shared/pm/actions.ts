// Engine actions: the guards that say whether the engine may run one, the git
// and gh scripts it runs in the task's worktree, and how it reads their output.
// Pure: the server runs the scripts on the project's machine (pmActions.ts).
import { combineGuards, isProtected, mayMerge, type ResolvedGuards } from './guards'
import { actionField, type MergeBy, type StepAction, type Template } from './workflow'

// The guards of a task: the project's, hardened by its task type.
export const taskGuards = (t: Template, type: string) =>
  combineGuards([{ source: 'project', guards: t.guards }, { source: 'task-type', guards: t.taskTypes[type]?.guards }])

// Why the action may not run, or undefined. `by`: 'user' when the user's
// gesture started it, else 'engine'. `base`: the PR's base, for github.merge.
export function guardAction(g: ResolvedGuards, a: StepAction, ctx: { branch: string, by: MergeBy, base?: string }): string | undefined {
  const onlyYou = (b: string) => `${b} is protected: only you may merge into it`
  const f = actionField(a.kind)
  if (f && !a[f]) return `${a.kind} has no branch: name one in the step, or set the project's working branch in Settings › Projects`
  if (a.kind === 'git.land' && !mayMerge(g, a.target!, ctx.by)) return onlyYou(a.target!)
  if ((a.kind === 'git.push' || a.kind === 'github.pr') && isProtected(g, ctx.branch)) return `${ctx.branch} is protected: the engine never pushes to it`
  if (a.kind === 'github.merge' && ctx.base !== undefined && !mayMerge(g, ctx.base, ctx.by)) return onlyYou(ctx.base)
}

// Exit codes the scripts use. SEND_BACK: the agent has to fix it (conflict,
// uncommitted changes). NOT_YET: checks still running, try again later.
export const CODE = { SEND_BACK: 3, NOT_MERGED: 5, NOT_YET: 6 } as const

// Each script runs in the task's worktree ($1); its other arguments follow.
// The last line of a successful run is its result (a commit or a link).
const IN = 'cd "$1" || exit 1; shift;'
// Does merged PR head $p hold HEAD ($h)? A head pushed from elsewhere is fetched first.
const HOLDS = `{ [ "$p" = "$h" ] || { git cat-file -e "$p^{commit}" 2>/dev/null || git fetch -q origin "$p" 2>/dev/null; git merge-base --is-ancestor "$h" "$p" 2>/dev/null; }; }`
const CLEAN = `[ -z "$(git status --porcelain)" ] || { echo "uncommitted changes: commit them, then say you are done"; exit ${CODE.SEND_BACK}; };`
export const SCRIPT = {
  // Catch up with the target, then push the task branch onto it.
  land: `${IN} ${CLEAN} t=$1
if git ls-remote -q --exit-code --heads origin "$t" >/dev/null; then
  git fetch -q origin "$t" 2>&1 || exit 1
  if ! git merge -q --no-edit "origin/$t" >/dev/null 2>&1; then
    f=$(git diff --name-only --diff-filter=U | head -3 | paste -sd ' ' -); git merge --abort; echo "conflict in $f"; exit ${CODE.SEND_BACK}; fi
fi
git push -q origin "HEAD:refs/heads/$t" 2>&1 || exit 1
git rev-parse HEAD`,
  push: `${IN} ${CLEAN} git push -q origin "HEAD:refs/heads/$1" 2>&1 || exit 1; git rev-parse HEAD`,
  // Opens the PR, or puts an open one back on the right base. Body on stdin.
  // A PR of the branch already merged (by hand, or a merge GitHub did but
  // answered with an error) whose head holds HEAD is the PR: no second one.
  // Commits after it need a new branch. As Shepherdr #706 (SHEP-59, MIT).
  pr: `${IN} ${CLEAN} b=$1 base=$2 h=$(git rev-parse HEAD) || exit 1
cur=$(gh pr list --head "$b" --state open --json url,baseRefName -q '.[] | .baseRefName+" "+.url' 2>&1) || { echo "$cur"; exit 1; }
cur=$(echo "$cur" | head -1)
if [ -z "$cur" ]; then
  m=$(gh pr list --head "$b" --state merged --json headRefOid,url -q '.[] | .headRefOid+" "+.url' 2>&1) || { echo "$m"; exit 1; }
  if [ -n "$m" ]; then
    while read -r p u; do ${HOLDS} && { echo "$u"; exit 0; }; done <<EOF
$m
EOF
    u=$(echo "$m" | head -1); echo "$b already had PR \${u#* } merged: new commits need a new branch"; exit 1
  fi
fi
git push -q origin "HEAD:refs/heads/$b" 2>&1 || exit 1
if [ -z "$cur" ]; then out=$(gh pr create --head "$b" --base "$base" --title "$3" --body-file - 2>&1) || { echo "$out"; exit 1; }; echo "$out" | tail -1; exit 0; fi
if [ "\${cur%% *}" != "$base" ]; then e=$(gh pr edit "\${cur#* }" --base "$base" 2>&1) || { echo "$e"; exit 1; }; fi
echo "\${cur#* }"`,
  // The commit, then the open PR as JSON on the last line. None open: the
  // merged PR of the branch whose head holds HEAD, marked merged (Shepherdr #706);
  // else its latest merged one, marked stray too: the step ends merged, saying
  // the task's commit is not in it.
  prInfo: `${IN} h=$(git rev-parse HEAD) || exit 1; echo "$h"
j=$(gh pr list --head "$1" --state open --json url,baseRefName,headRefOid,mergeStateStatus,statusCheckRollup 2>&1) || { echo "$j"; exit 1; }
j=$(echo "$j" | tail -1)
if [ "$j" = "[]" ]; then
  m=$(gh pr list --head "$1" --state merged --json url,baseRefName,headRefOid -q '.[] | .headRefOid+" "+(. + {merged: true} | tojson)' 2>&1) || { echo "$m"; exit 1; }
  while read -r p pj; do [ -n "$p" ] && ${HOLDS} && { j="[$pj]"; break; }; done <<EOF
$m
EOF
  pj=$(echo "$m" | head -1)
  if [ "$j" = "[]" ] && [ -n "$pj" ]; then j="[$(echo "\${pj#* }" | sed 's/}$/,"stray":true}/')]"; fi
fi
echo "$j"`,
  // The step's method ($3), else the first the repo allows: merge commit, squash, rebase.
  merge: `${IN} m=$3; [ -n "$m" ] || m=$(gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed -q 'if .mergeCommitAllowed then "merge" elif .squashMergeAllowed then "squash" else "rebase" end' 2>&1) || { echo "$m"; exit 1; }
gh pr merge "$1" "--$m" --match-head-commit "$2" 2>&1 || exit 1; echo "$1"`,
  // Merged when GitHub has a merged PR from the branch into the target whose
  // head is HEAD (or holds it): squash and rebase merges leave no ancestor.
  // Else HEAD must be in the target and the branch hold a commit of its own:
  // one made on it (its reflog: a fast-forward is no work) since its start
  // (branch.<b>.wherdrstart, written at worktree add). Inspired by Shepherdr's
  // merged_here()/own_work() (mods/tasks/bin/herdr_task/github.py, MIT).
  verify: `${IN} t=$1 b=$2 ghe=; h=$(git rev-parse HEAD) || exit 1
if command -v gh >/dev/null; then
  if heads=$(gh pr list --head "$b" --base "$t" --state merged --json headRefOid -q '.[].headRefOid' 2>&1); then
    for p in $heads; do { [ "$p" = "$h" ] || git merge-base --is-ancestor "$h" "$p" 2>/dev/null; } && { echo "$h"; exit 0; }; done
  else echo "$heads" | grep -qiE 'known GitHub host|not a git repository' || ghe=$heads; fi
fi
git fetch -q origin "$t" 2>&1 || exit 1
if git merge-base --is-ancestor HEAD "origin/$t"; then
  s=$(git config "branch.$b.wherdrstart")
  mine=$(git rev-list --no-merges \${s:+"$s.."}HEAD)
  # Reflog entries that made a commit: commit, amend, cherry-pick, revert, am,
  # a rebase's picks (rebase, rebase -i, pull --rebase...), and a rebase's end
  # whose tip is not its onto (else it was only a fast-forward).
  OWN='$2 ~ /^(commit|cherry-pick|revert|am):$/ || / commit \\((initial|amend)\\): / || /\\((pick|reword|edit|squash|fixup|continue)\\): / || (/ \\(finish\\): refs\\/heads\\/[^ ]+ onto [0-9a-f]+$/ && $1 != $NF) { print $1 }'
  for c in $({ git log -g --format='%H %gs' "refs/heads/$b"; git log -g --format='%H %gs' HEAD; } 2>/dev/null | awk "$OWN"); do
    case "$mine" in *"$c"*) echo "$h"; exit 0;; esac; done
  why="$b has no commit of its own: nothing was merged"
else why="commit $(git rev-parse --short HEAD) is not in $t"; fi
[ -z "$ghe" ] || { echo "$why (GitHub not checked: $(echo "$ghe" | head -1))"; exit 1; }
echo "$why"; exit ${CODE.NOT_MERGED}`,
  // The engine's catch-up: the target merged into the task branch, pushed there.
  catchUp: `${IN} ${CLEAN} git fetch -q origin "$1" 2>&1 || exit 1
if ! git merge -q --no-edit "origin/$1" >/dev/null 2>&1; then
  f=$(git diff --name-only --diff-filter=U | head -3 | paste -sd ' ' -); git merge --abort; echo "conflict with $1 in $f"; exit ${CODE.SEND_BACK}; fi
git push -q origin "HEAD:refs/heads/$2" 2>&1 || exit 1; git rev-parse HEAD`,
  // Where the PR head ($1) stands against the task's commit: same; behind (in
  // its history: the task's later commits are not pushed yet); or foreign (a
  // commit the task's worktree never had: pushed from elsewhere).
  headOf: `${IN} p=$1; git cat-file -e "$p^{commit}" 2>/dev/null || git fetch -q origin "$p" 2>/dev/null
if [ "$(git rev-parse HEAD)" = "$p" ]; then echo same; elif git merge-base --is-ancestor "$p" HEAD 2>/dev/null; then echo behind; else echo foreign; fi`,
  // Runs again the failed or cancelled workflow runs of a commit.
  rerun: `${IN} ids=$(gh run list --commit "$1" --json databaseId,conclusion -q '.[] | select(.conclusion != "success" and .conclusion != "skipped" and .conclusion != "neutral" and .conclusion != "") | .databaseId' 2>&1) || { echo "$ids"; exit 1; }
for i in $ids; do gh run rerun "$i" --failed 2>&1 || exit 1; done`,
  // Remote branches holding the task's commit, for the protected-branch alert.
  contains: `${IN} git fetch -q origin 2>&1 || exit 1; git branch -r --contains HEAD --format='%(refname:short)'`,
}

export interface Check { name?: string, context?: string, status?: string, conclusion?: string, state?: string }
// merged: no PR open, this one of the branch is merged already and holds the
// task's commit; stray: merged, but at a head without the task's commit.
export interface PrInfo { url: string, baseRefName: string, headRefOid: string, statusCheckRollup?: Check[], merged?: boolean, stray?: boolean }

export const GREEN = ['SUCCESS', 'NEUTRAL', 'SKIPPED']
// May the open PR be merged now? Its head must be the task's commit, every
// check green and each required one there; a check still running, or a
// required one not reported yet, means later.
export function prReady(pr: PrInfo | undefined, head: string, required: string[] = []): { ok: true } | { ok: false, later?: boolean, why: string } {
  if (!pr) return { ok: false, why: 'no open PR for this task' }
  if (pr.headRefOid !== head) return { ok: false, why: 'the PR head is not the task\'s commit' }
  const checks = pr.statusCheckRollup ?? []
  const state = (c: Check) => c.conclusion || c.state || ''
  const absent = required.filter(n => !checks.some(c => (c.name || c.context) === n))
  if (absent.length) return { ok: false, later: true, why: `waiting for check ${absent.join(', ')}` }
  if (checks.some(c => (c.status && c.status !== 'COMPLETED') || ['PENDING', 'EXPECTED'].includes(c.state ?? ''))) return { ok: false, later: true, why: 'checks still running' }
  const red = checks.filter(c => !GREEN.includes(state(c)))
  if (red.length) return { ok: false, why: `${red.length} check(s) failed` }
  return { ok: true }
}

// Errors that pass by themselves: a git host refusing a push for a while,
// a branch policy not yet updated, a server error, the network.
const TRANSIENT = [
  /commit_refs/i, /base branch policy prohibits the merge/i, /HTTP 5\d\d/, /\b50[234]\b/, /bad gateway|service unavailable/i,
  /could not resolve host/i, /connection (reset|refused|timed out)/i, /operation timed out/i, /remote end hung up/i,
  /RPC failed|early EOF/i, /cannot lock ref/i, /\(fetch first\)/i, /rate limit/i,
]
// code null = the command timed out. A send-back or not-merged answer is
// final, whatever its text (a file named 502.vue).
export const isTransient = (code: number | null, out: string) =>
  code === null || code === CODE.NOT_YET || (code !== CODE.SEND_BACK && code !== CODE.NOT_MERGED && TRANSIENT.some(r => r.test(out)))
export const RETRY_MS = [60_000, 120_000, 240_000, 480_000]

// Protected branches that hold the task's commit although nothing allowed it:
// no step the user ended and no guarded engine action put it there.
export function leaks(g: ResolvedGuards, remoteBranches: string[], allowed: string[]): string[] {
  return remoteBranches.map(b => b.replace(/^origin\//, '')).filter(b => b !== 'HEAD' && b !== 'origin' && isProtected(g, b) && !allowed.includes(b))
}

// Written before an action runs, completed after. One per attempt: an action
// is never run twice for one receipt, and one found 'pending' after a restart
// becomes 'uncertain' instead of being run again blindly.
// note: a line for the task's log.
// review: new commits since the reviewed one, to review before the merge.
export interface ActionResult { ok: boolean, error?: string, toAgent?: boolean, review?: { since: string, head: string }, link?: string, commit?: string, alert?: string, note?: string }
export interface Receipt { id: string, task: string, step: string, action: StepAction, state: 'pending' | 'done' | 'uncertain', result?: ActionResult, at: number }
export const receiptId = (task: string, step: string, attempt: number) => `${task}.${attempt}.${encodeURIComponent(step)}`
