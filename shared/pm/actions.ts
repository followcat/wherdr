// Engine actions: the guards that say whether the engine may run one, the git
// and gh scripts it runs in the task's worktree, and how it reads their output.
// Pure: the server runs the scripts on the project's machine (pmActions.ts).
import { combineGuards, isProtected, mayMerge, type ResolvedGuards } from './guards'
import { projectPlace } from './places'
import { maskLeaks } from './visibility'
import { actionField, isPrMerge, type MergeBy, type StepAction, type Template } from './workflow'

// The guards of a task: its workspace's (a member project's), the project's,
// hardened by its task type.
export const taskGuards = (t: Template, type: string) =>
  combineGuards([{ source: 'workspace', guards: t.workspaceGuards }, { source: 'project', guards: t.guards }, { source: 'task-type', guards: t.taskTypes[type]?.guards }])

// Why the action may not run, or undefined. `by`: 'user' when the user's
// gesture started it, else 'engine'. `base`: the PR's base, for a PR merge.
// `project`: the task's, for where its working branch is set.
export function guardAction(g: ResolvedGuards, a: StepAction, ctx: { branch: string, by: MergeBy, base?: string, project?: string }): string | undefined {
  const onlyYou = (b: string) => `${b} is protected: only you may merge into it`
  const f = actionField(a.kind)
  if (f && !a[f]) return `${a.kind} has no branch: name one in the step, or set the project's working branch in ${projectPlace(ctx.project)}`
  if (a.kind === 'git.land' && !mayMerge(g, a.target!, ctx.by)) return onlyYou(a.target!)
  if ((a.kind === 'git.push' || a.kind === 'github.pr') && isProtected(g, ctx.branch)) return `${ctx.branch} is protected: the engine never pushes to it`
  if (isPrMerge(a.kind) && ctx.base !== undefined && !mayMerge(g, ctx.base, ctx.by)) return onlyYou(ctx.base)
}

// Exit codes the scripts use. SEND_BACK: the agent has to fix it (conflict,
// uncommitted changes). NOT_YET: checks still running, try again later.
export const CODE = { SEND_BACK: 3, NOT_MERGED: 5, NOT_YET: 6 } as const

// A script's run: its answer is on stdout (out), never on stderr (err), which
// only says why it failed. code null: timed out.
export interface ShellResult { code: number | null, out: string, err?: string }
// Why a run failed: what the script printed, else its stderr.
export const errorText = (r: ShellResult) => r.out.trim() ? r.out : r.err ?? ''
// All of it, for the patterns of a transient error.
export const allText = (r: ShellResult) => [r.out, r.err].filter(Boolean).join('\n')

// The remote branch $b deleted, only while it is still at commit $r.
const DELETE_REF = 'git push -q --force-with-lease="refs/heads/$b:$r" origin ":refs/heads/$b" 2>"$_e" || { cat "$_e"; exit 1; }; echo deleted'
// Each script runs in the task's worktree ($1); its other arguments follow.
// The last line of a successful run is its result (a commit or a link).
// $_e holds a git or gh call's stderr, printed on stdout only when it fails: a
// warning is never read as a result, and an error still shows where
// herdr-core returns no stderr.
const IN = `cd "$1" || exit 1; shift; _e=$(mktemp) || exit 1; trap 'rm -f "$_e"' EXIT;`
// Does merged PR head $p hold HEAD ($h)? A head pushed from elsewhere is fetched first.
const HOLDS = `{ [ "$p" = "$h" ] || { git cat-file -e "$p^{commit}" 2>/dev/null || git fetch -q origin "$p" 2>/dev/null; git merge-base --is-ancestor "$h" "$p" 2>/dev/null; }; }`
const CLEAN = `[ -z "$(git status --porcelain)" ] || { echo "uncommitted changes: commit them, then say you are done"; exit ${CODE.SEND_BACK}; };`
// After a merge, the project's own fix (git config wherdr.afterMerge, run at the
// worktree's root), committed: merges done where its merge drivers do not run
// (GitHub's Update branch) are fixed before the push. A failed fix leaves HEAD.
const AFTER_MERGE = `a=$(git config --get wherdr.afterMerge) && { sh -c "$a" >/dev/null 2>&1 && git commit -qam "Fix the merge (wherdr.afterMerge)" >/dev/null 2>&1; git reset -q --hard; };`
// The files that change the interface, at any depth (app/components, pages…).
const UI_FILES = ['components', 'assets', 'pages', 'layouts'].map(d => `':(glob)**/${d}/**'`).join(' ')

// A file's text without its comments, for the types whose comments the
// interface never shows; others as they are. Strings, tags with their
// attributes, {{ }} and Markdown code are kept whole, and so is every space:
// only a comment goes, with its own line when it had one. Without perl, as they are: a comment then counts as a change.
// No single quote in it (\x27): it goes into the script between single quotes.
const STRIP_PL = String.raw`my $m = shift; local $/; my $t = <STDIN>; $t = "" unless defined $t; my $Z = "\0";
my $S = qr{"(?:\\.|[^"\\\n])*"|\x27(?:\\.|[^\x27\\\n])*\x27|\x60(?:\\.|[^\x60\\])*\x60};
sub code { my ($s, $line) = @_; my $c = $line ? qr{/\*.*?\*/|(?<![:\w\\])//[^\n]*}s : qr{/\*.*?\*/}s;
  $s =~ s{($S)|[ \t]*(?<!\\)(?:$c)}{defined $1 ? $1 : $Z}gse; return $s }
sub block { my ($o, $in, $c) = $_[0] =~ m{^(<[^>]*>)(.*)(</\w+>)$}s; return $o . code($in, $o =~ m{^<script|lang=["\x27]?(?:scss|less)}i ? 1 : 0) . $c }
if ($m eq "css") { $t = code($t, 0) } elsif ($m eq "js") { $t = code($t, 1) }
elsif ($m eq "html") { $t =~ s{(<(script|style)\b[^>]*>.*?</\2>)|(\{\{.*?\}\}|<[A-Za-z][^>"\x27]*(?:(?:"[^"]*"|\x27[^\x27]*\x27)[^>"\x27]*)*>)|[ \t]*<!--.*?-->}{defined $1 ? block($1) : defined $3 ? $3 : $Z}gsei }
elsif ($m eq "md") { $t =~ s{(\x60\x60\x60.*?\x60\x60\x60|\x60[^\x60\n]*\x60)|[ \t]*<!--.*?-->}{defined $1 ? $1 : $Z}gse }
$t =~ s{^[ \t]*$Z[$Z \t]*\n}{}gm; $t =~ s{$Z}{}g; print $t;`
const STRIP = `P='${STRIP_PL}'
strip() { case "$1" in *.css) k=css ;; *.scss|*.less|*.js|*.mjs|*.cjs|*.ts|*.mts|*.cts|*.jsx|*.tsx) k=js ;; *.vue|*.html|*.htm) k=html ;; *.md) k=md ;; *) cat; return ;; esac
  command -v perl >/dev/null 2>&1 || { cat; return; }
  perl -e "$P" "$k"; }`

// A script: is the task's own change (in `files`) the same at commits $2 and
// $3, base $1? "same"; "comments" when only comments moved (STRIP);
// else the files whose change moved, then "changed".
const ownChange = (files: string) => `${IN} git fetch -q origin "$1" 2>/dev/null; b="origin/$1"; _b=$(mktemp) && _c=$(mktemp) || exit 1; trap 'rm -f "$_e" "$_b" "$_c"' EXIT
for c in "$2" "$3"; do git cat-file -e "$c^{commit}" 2>/dev/null || git fetch -q origin "$c" 2>/dev/null; done
m2=$(git merge-base "$b" "$2") && m3=$(git merge-base "$b" "$3") || exit 1
own() { git diff -U0 --no-color --no-ext-diff "$1" "$2" -- ${files} | sed '/^index /d; /^@@/d'; }
[ "$(own "$m2" "$2")" = "$(own "$m3" "$3")" ] && { echo same; exit 0; }
${STRIP}
one() { git show "$1:$3" 2>/dev/null | strip "$3" >"$_b"; git show "$2:$3" 2>/dev/null | strip "$3" >"$_c"; diff "$_b" "$_c" | sed '/^[0-9]/d'; }
moved=$({ git diff --name-only --no-renames "$m2" "$2" -- ${files}; git diff --name-only --no-renames "$m3" "$3" -- ${files}; } | sort -u | while IFS= read -r f; do
  [ "$(one "$m2" "$2" "$f")" = "$(one "$m3" "$3" "$f")" ] || printf '%s\\n' "$f"; done)
[ -z "$moved" ] && echo comments || printf '%s\\nchanged\\n' "$moved"`
export const SCRIPT = {
  // Catch up with the target, then push the task branch onto it. A repository
  // without origin lands locally: the clone's branch $t (made when missing)
  // moves to the task's commit, unless a folder has it checked out.
  land: `${IN} ${CLEAN} t=$1
if ! git remote get-url origin >/dev/null 2>&1; then
  old=$(git rev-parse -q --verify "refs/heads/$t")
  if [ -n "$old" ] && ! git merge -q --no-edit "$old" >/dev/null 2>&1; then
    f=$(git diff --name-only --diff-filter=U | head -3 | paste -sd ' ' -); git merge --abort; printf 'conflict in %s\\n' "$f"; exit ${CODE.SEND_BACK}; fi
  w=$(git worktree list --porcelain | awk -v b="branch refs/heads/$t" '/^worktree /{ p=substr($0, 10) } $0 == b { print p }')
  [ -z "$w" ] || { printf '%s\\n' "$t is checked out in $w: switch that folder to another branch, then try again"; exit 1; }
  git update-ref "refs/heads/$t" HEAD "$old" || exit 1
  git rev-parse HEAD; exit 0
fi
if git ls-remote -q --exit-code --heads origin "$t" >/dev/null; then
  git fetch -q origin "$t" 2>"$_e" || { cat "$_e"; exit 1; }
  if ! git merge -q --no-edit "origin/$t" >/dev/null 2>&1; then
    f=$(git diff --name-only --diff-filter=U | head -3 | paste -sd ' ' -); git merge --abort; printf 'conflict in %s\\n' "$f"; exit ${CODE.SEND_BACK}; fi
  ${AFTER_MERGE}
fi
git push -q origin "HEAD:refs/heads/$t" 2>"$_e" || { cat "$_e"; exit 1; }
git rev-parse HEAD`,
  push: `${IN} ${CLEAN} git push -q origin "HEAD:refs/heads/$1" 2>"$_e" || { cat "$_e"; exit 1; }; git rev-parse HEAD`,
  // Opens the PR, or puts an open one back on the right base. Body on stdin.
  // A PR of the branch already merged (by hand, or a merge GitHub did but
  // answered with an error) whose head holds HEAD is the PR: no second one.
  // Commits after it need a new branch. As Shepherdr #706 (SHEP-59, MIT).
  pr: `${IN} ${CLEAN} b=$1 base=$2 h=$(git rev-parse HEAD) || exit 1
cur=$(gh pr list --head "$b" --state open --json url,baseRefName -q '.[] | .baseRefName+" "+.url' 2>"$_e") || { cat "$_e"; exit 1; }
cur=$(printf '%s\\n' "$cur" | head -1)
if [ -z "$cur" ]; then
  m=$(gh pr list --head "$b" --state merged --json headRefOid,url -q '.[] | .headRefOid+" "+.url' 2>"$_e") || { cat "$_e"; exit 1; }
  if [ -n "$m" ]; then
    while read -r p u; do ${HOLDS} && { printf '%s\\n' "$u"; exit 0; }; done <<EOF
$m
EOF
    u=$(printf '%s\\n' "$m" | head -1); printf '%s\\n' "$b already had PR \${u#* } merged: new commits need a new branch"; exit 1
  fi
fi
git push -q origin "HEAD:refs/heads/$b" 2>"$_e" || { cat "$_e"; exit 1; }
if [ -z "$cur" ]; then out=$(gh pr create --head "$b" --base "$base" --title "$3" --body-file - 2>"$_e") || { cat "$_e"; exit 1; }; printf '%s\\n' "$out" | tail -1; exit 0; fi
if [ "\${cur%% *}" != "$base" ]; then gh pr edit "\${cur#* }" --base "$base" >/dev/null 2>"$_e" || { cat "$_e"; exit 1; }; fi
printf '%s\\n' "\${cur#* }"`,
  // The commit, then the open PR as JSON on the last line. None open: the
  // merged PR of the branch whose head holds HEAD, marked merged (Shepherdr #706);
  // else its latest merged one, marked stray too: the step ends merged, saying
  // the task's commit is not in it. printf, never echo: dash's echo turns the
  // \n of a commit message into a line break, cutting the JSON. Commits are
  // kept to their oids. Only gh's JSON line is read, its stderr apart; none:
  // gh's output as it was, unreadable, tried again.
  prInfo: `${IN} h=$(git rev-parse HEAD) || exit 1
o=$(gh pr list --head "$1" --state open --json url,baseRefName,headRefOid,mergeStateStatus,statusCheckRollup,files,additions,deletions,commits -q 'map(.commits |= map({oid}))' 2>"$_e") || { cat "$_e"; exit 1; }
j=$(printf '%s\\n' "$o" | grep '^\\[' | tail -1)
[ -n "$j" ] || { printf '%s\\n' "$h" "$o"; exit 0; }
if [ "$j" = "[]" ]; then
  m=$(gh pr list --head "$1" --state merged --json url,baseRefName,headRefOid -q '.[] | .headRefOid+" "+(. + {merged: true} | tojson)' 2>"$_e") || { cat "$_e"; exit 1; }
  m=$(printf '%s\\n' "$m" | grep -E '^[0-9a-f]{40} ')
  while read -r p pj; do [ -n "$p" ] && ${HOLDS} && { j="[$pj]"; break; }; done <<EOF
$m
EOF
  pj=$(printf '%s\\n' "$m" | head -1)
  if [ "$j" = "[]" ] && [ -n "$pj" ]; then j="[$(printf '%s\\n' "\${pj#* }" | sed 's/}$/,"stray":true}/')]"; fi
fi
printf '%s\\n' "$h" "$j"`,
  // The branch's latest PR closed without a merge (--state closed lists merged ones too): its link.
  prClosed: `${IN} gh pr list --head "$1" --state closed --json url,state -q '[.[] | select(.state == "CLOSED")][0].url // empty' 2>"$_e" || { cat "$_e"; exit 1; }`,
  // The step's method ($3), else the first the repo allows: merge commit, squash, rebase.
  merge: `${IN} m=$3; [ -n "$m" ] || m=$(gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed -q 'if .mergeCommitAllowed then "merge" elif .squashMergeAllowed then "squash" else "rebase" end' 2>"$_e") || { cat "$_e"; exit 1; }
gh pr merge "$1" "--$m" --match-head-commit "$2" 2>"$_e" || { cat "$_e"; exit 1; }; printf '%s\\n' "$1"`,
  // Merged when GitHub has a merged PR from the branch into the target whose
  // head is HEAD (or holds it): squash and rebase merges leave no ancestor.
  // Else HEAD must be in the target and the branch hold a commit of its own:
  // one made on it (its reflog: a fast-forward is no work) since its start
  // (branch.<b>.wherdrstart, written at worktree add), or, for a branch taken
  // over (branch.<b>.wherdrtaken: its tip then), one it had ahead of the target
  // at its start, whoever made it. Inspired by Shepherdr's
  // merged_here()/own_work() (mods/tasks/bin/herdr_task/github.py, MIT).
  verify: `${IN} t=$1 b=$2 ghe=; h=$(git rev-parse HEAD) || exit 1
if command -v gh >/dev/null; then
  if heads=$(gh pr list --head "$b" --base "$t" --state merged --json headRefOid -q '.[].headRefOid' 2>&1); then
    for p in $heads; do { [ "$p" = "$h" ] || git merge-base --is-ancestor "$h" "$p" 2>/dev/null; } && { echo "$h"; exit 0; }; done
  else printf '%s\\n' "$heads" | grep -qiE 'known GitHub host|not a git repository' || ghe=$heads; fi
fi
git fetch -q origin "$t" 2>"$_e" || { cat "$_e"; exit 1; }
if git merge-base --is-ancestor HEAD "origin/$t"; then
  s=$(git config "branch.$b.wherdrstart")
  mine=$(git rev-list --no-merges \${s:+"$s.."}HEAD)
  # Reflog entries that made a commit: commit, amend, cherry-pick, revert, am,
  # a rebase's picks (rebase, rebase -i, pull --rebase...), and a rebase's end
  # whose tip is not its onto (else it was only a fast-forward).
  OWN='$2 ~ /^(commit|cherry-pick|revert|am):$/ || / commit \\((initial|amend)\\): / || /\\((pick|reword|edit|squash|fixup|continue)\\): / || (/ \\(finish\\): refs\\/heads\\/[^ ]+ onto [0-9a-f]+$/ && $1 != $NF) { print $1 }'
  for c in $({ git log -g --format='%H %gs' "refs/heads/$b"; git log -g --format='%H %gs' HEAD; } 2>/dev/null | awk "$OWN"); do
    case "$mine" in *"$c"*) echo "$h"; exit 0;; esac; done
  k=$(git config "branch.$b.wherdrtaken")
  [ -n "$k" ] && [ -n "$(git rev-list -1 \${s:+"$s.."}"$k")" ] && git merge-base --is-ancestor "$k" HEAD && { echo "$h"; exit 0; }
  why="$b has no commit of its own: nothing was merged"
else why="commit $(git rev-parse --short HEAD) is not in $t"; fi
[ -z "$ghe" ] || { printf '%s\\n' "$why (GitHub not checked: $(printf '%s\\n' "$ghe" | head -1))"; exit 1; }
printf '%s\\n' "$why"; exit ${CODE.NOT_MERGED}`,
  // The engine's catch-up: the target merged into the task branch, pushed there.
  catchUp: `${IN} ${CLEAN} git fetch -q origin "$1" 2>"$_e" || { cat "$_e"; exit 1; }
if ! git merge -q --no-edit "origin/$1" >/dev/null 2>&1; then
  f=$(git diff --name-only --diff-filter=U | head -3 | paste -sd ' ' -); git merge --abort; printf '%s\\n' "conflict with $1 in $f"; exit ${CODE.SEND_BACK}; fi
${AFTER_MERGE}
git push -q origin "HEAD:refs/heads/$2" 2>"$_e" || { cat "$_e"; exit 1; }; git rev-parse HEAD`,
  // A push refused because the task branch ($1) is behind its remote: the
  // worktree takes the remote's commits (a fast-forward, else a merge), to push again.
  sync: `${IN} ${CLEAN} git fetch -q origin "$1" 2>"$_e" || { cat "$_e"; exit 1; }
if git merge-base --is-ancestor HEAD FETCH_HEAD; then git merge -q --ff-only FETCH_HEAD 2>"$_e" || { cat "$_e"; exit 1; }; ${AFTER_MERGE} printf '%s\\n' "fast-forwarded to origin/$1"; exit 0; fi
if ! git merge -q --no-edit FETCH_HEAD >/dev/null 2>&1; then
  f=$(git diff --name-only --diff-filter=U | head -3 | paste -sd ' ' -); git merge --abort; printf '%s\\n' "conflict with origin/$1 in $f"; exit ${CODE.SEND_BACK}; fi
${AFTER_MERGE}
printf '%s\\n' "merged origin/$1"`,
  // Where the PR head ($1) stands against the task's commit: same; behind (in
  // its history: the task's later commits are not pushed yet); update (GitHub's
  // Update branch: a merge of the base, $2, into a head the worktree has); or
  // foreign (a commit the task's worktree never had: pushed from elsewhere).
  headOf: `${IN} p=$1; git cat-file -e "$p^{commit}" 2>/dev/null || git fetch -q origin "$p" 2>/dev/null
if [ "$(git rev-parse HEAD)" = "$p" ]; then echo same; elif git merge-base --is-ancestor "$p" HEAD 2>/dev/null; then echo behind
elif [ -n "$2" ] && git rev-parse -q --verify "$p^2" >/dev/null && git merge-base --is-ancestor "$p^1" HEAD 2>/dev/null \
  && git fetch -q origin "$2" 2>/dev/null && git merge-base --is-ancestor "$p^2" FETCH_HEAD; then echo update; else echo foreign; fi`,
  // The remote task branch's tip ($1), as origin has it now: empty when it has none.
  remoteHead: `${IN} r=$(git ls-remote origin "refs/heads/$1" 2>"$_e") || { cat "$_e"; exit 1; }; printf '%s\\n' "$r" | cut -f1`,
  // Runs again the failed or cancelled workflow runs of a commit.
  rerun: `${IN} ids=$(gh run list --commit "$1" --json databaseId,conclusion -q '.[] | select(.conclusion != "success" and .conclusion != "skipped" and .conclusion != "neutral" and .conclusion != "") | .databaseId' 2>"$_e") || { cat "$_e"; exit 1; }
for i in $ids; do gh run rerun "$i" --failed 2>"$_e" || { cat "$_e"; exit 1; }; done`,
  // pipeline.watch, github: the runs of branch $1's tip now (asked of the
  // remote: a run listed by branch may be the previous commit's, its own not
  // registered yet), else of the task's commit; only workflow $2 when named.
  ghRuns: `${IN} if [ -n "$1" ]; then v=$(git ls-remote -q origin "refs/heads/$1" 2>"$_e") || { cat "$_e"; exit 1; }; v=\${v%%[[:space:]]*}
  [ -n "$v" ] || { printf '%s\\n' "no branch $1 on origin"; exit 1; }; else v=$(git rev-parse HEAD) || exit 1; fi
gh run list --commit "$v" \${2:+--workflow "$2"} --limit 30 --json databaseId,workflowName,status,conclusion,headSha,url 2>"$_e" || { cat "$_e"; exit 1; }`,
  // The failed jobs of run $1, then the tail of their logs.
  ghFailed: `${IN} gh run view "$1" --json jobs -q '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped" and .conclusion != "neutral") | .name' 2>/dev/null | head -5 | paste -sd ',' -
gh run view "$1" --log-failed 2>&1 | tail -n 20`,
  // pipeline.watch, command: the step's command, in the worktree; its exit code is the answer.
  watchCommand: `${IN} sh -c "$1" 2>&1`,
  // The failed jobs' log at the commit, for a red-CI nudge (blocked.ts): its last lines.
  failedLog: `${IN} for i in $(gh run list --commit "$1" --json databaseId,conclusion -q '.[] | select(.conclusion == "failure") | .databaseId' 2>/dev/null); do gh run view "$i" --log-failed 2>/dev/null | tail -n 400; done`,
  // Did the task's own interface change move from commit $2 to $3? Each one's
  // diff from where it left base $1, interface files only, line numbers left
  // out: what a merge of the base brought does not count (ownChange's answers).
  uiChanged: ownChange(UI_FILES),
  // The same over all its files: a commit that only merges the base is not reviewed again.
  ownChanged: ownChange('.'),
  head: `${IN} git rev-parse HEAD`,
  // Does merged PR head $1 (a commit, or the start of one) hold HEAD? Prints HEAD.
  holds: `${IN} h=$(git rev-parse HEAD) || exit 1; p=$(git rev-parse -q --verify "$1^{commit}") || p=$1
${HOLDS} || exit ${CODE.NOT_MERGED}; echo "$h"`,
  // One Bitbucket Cloud API call on origin's repository: method ($1), path
  // ($2), then a query (GET) or a JSON body. Credentials from the machine's
  // environment, passed to curl on stdin (never on its command line). Prints
  // the body, then the HTTP status; a server error or rate limit fails, to be
  // tried again.
  bitbucket: `${IN} r=$(git remote get-url origin | sed -nE 's#^.*bitbucket\\.org[:/]([^/]+/[^/]+)$#\\1#p' | sed 's/\\.git$//')
[ -n "$r" ] || { echo "origin is not a Bitbucket Cloud repository"; exit 1; }
if [ -n "$BITBUCKET_USERNAME" ]; then auth="user = \\"$BITBUCKET_USERNAME:\${BITBUCKET_APP_PASSWORD:-$BITBUCKET_TOKEN}\\""
elif [ -n "$BITBUCKET_TOKEN" ]; then auth="header = \\"Authorization: Bearer $BITBUCKET_TOKEN\\""
else echo "no Bitbucket credentials: set BITBUCKET_TOKEN, or BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD, on this machine"; exit 1; fi
if [ "$1" = GET ]; then g=-G; d=--data-urlencode; else g=; d=--data; fi
o=$(printf '%s\\n' "$auth" | curl -sS -K - -X "$1" $g -H 'Content-Type: application/json' "$d" "$3" -w '\\n%{http_code}' "\${BITBUCKET_API:-https://api.bitbucket.org/2.0}/repositories/$r$2" 2>&1) || { printf '%s\\n' "$o"; exit 1; }
c=$(printf '%s\\n' "$o" | tail -1)
case $c in 429) echo "rate limit"; exit 1;; 5*) echo "HTTP $c"; exit 1;; esac
printf '%s\\n' "$o"`,
  // After a merge: may the task's remote branch ($1) go? Last line: none (no
  // origin or no such branch), bitbucket (asked through the API instead),
  // kept: <why>, or deleted. It goes only when no open PR uses or targets it,
  // a merged PR has its exact head, and GitHub neither protects it nor has it as
  // default; the lease keeps a commit pushed meanwhile.
  dropBranch: `${IN} b=$1; u=$(git remote get-url origin 2>/dev/null) || { echo none; exit 0; }
case $u in *bitbucket.org[:/]*) echo bitbucket; exit 0;; esac
ask() { o=$("$@" 2>"$_e") || { tail -1 "$_e"; exit 1; }; }
ask git ls-remote origin "refs/heads/$b"; r=$(printf '%s\\n' "$o" | cut -f1); [ -n "$r" ] || { echo none; exit 0; }
ask gh pr list --head "$b" --state open --json url -q '.[0].url // empty'; [ -z "$o" ] || { printf '%s\\n' "kept: an open PR uses it ($o)"; exit 0; }
ask gh pr list --base "$b" --state open --json url -q '.[0].url // empty'; [ -z "$o" ] || { printf '%s\\n' "kept: an open PR targets it ($o)"; exit 0; }
ask gh pr list --head "$b" --state merged --json headRefOid -q '.[].headRefOid'
[ -n "$o" ] || { echo "kept: no merged PR of it"; exit 0; }
printf '%s\\n' "$o" | grep -qxF "$r" || { echo "kept: commit $(printf '%s\\n' "$r" | cut -c1-7) was pushed after its merge"; exit 0; }
ask gh api "repos/{owner}/{repo}/branches/$b" -q .protected; [ "$o" != true ] || { echo "kept: GitHub protects it"; exit 0; }
ask gh repo view --json defaultBranchRef -q .defaultBranchRef.name; [ "$o" != "$b" ] || { echo "kept: it is the repository's default branch"; exit 0; }
${DELETE_REF}`,
  // Deletes remote branch $1 only while it is at commit $2.
  deleteRef: `${IN} b=$1 r=$2; ${DELETE_REF}`,
  // Remote branches holding the task's commit, for the protected-branch alert.
  contains: `${IN} git fetch -q origin 2>"$_e" || { cat "$_e"; exit 1; }; git branch -r --contains HEAD --format='%(refname:short)'`,
}

// Scripts that push or merge get 300 s, not exec's 60: a slow remote, a big push.
export const SLOW_SECS = 300
export const SLOW = new Set<string>([SCRIPT.land, SCRIPT.push, SCRIPT.pr, SCRIPT.catchUp, SCRIPT.merge])

export interface Check { name?: string, context?: string, status?: string, conclusion?: string, state?: string }
// merged: no PR open, this one of the branch is merged already and holds the
// task's commit; stray: merged, but at a head without the task's commit.
// commits: the open PR's, for their count.
export interface PrInfo { url: string, baseRefName: string, headRefOid: string, mergeStateStatus?: string, statusCheckRollup?: Check[], merged?: boolean, stray?: boolean, files?: { path: string }[], additions?: number, deletions?: number, commits?: unknown[] }

// SCRIPT.prInfo's output: the commit on the first line, the PRs on the last
// JSON line (a stderr line may come after it). Unreadable: undefined.
export function readPrInfo(out: string): { head: string, prs: PrInfo[] } | undefined {
  const lines = out.split('\n')
  for (const l of lines.slice(1).reverse()) {
    if (!l.trim().startsWith('[')) continue
    try {
      const prs = JSON.parse(l) as unknown
      if (Array.isArray(prs)) return { head: lines[0]!.trim(), prs: prs as PrInfo[] }
    } catch { /* an earlier line may be the JSON */ }
  }
}
// An output's last lines for an error: what looks private masked, at most 300 characters.
export const outputTail = (out: string) => maskLeaks(out.trim().split('\n').slice(-3).join(' | ')).slice(-300)

export const GREEN =['SUCCESS', 'NEUTRAL', 'SKIPPED']
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

// pipeline.watch, github: where the runs of one commit stand. None yet (CI
// not started) or one not completed: running. Each green: done. Else the first
// that failed. All are of one commit (ghRuns); a stray other is left out.
export interface GhRun { databaseId: number, workflowName?: string, status: string, conclusion: string, headSha: string, url: string }
const RUN_OK = ['success', 'skipped', 'neutral']
export function runsState(all: GhRun[]): { state: 'running' } | { state: 'done', link: string } | { state: 'failed', run: GhRun } {
  const runs = all.filter(r => r.headSha === all[0]?.headSha)
  if (!runs.length || runs.some(r => r.status !== 'completed')) return { state: 'running' }
  const bad = runs.find(r => !RUN_OK.includes(r.conclusion))
  return bad ? { state: 'failed', run: bad } : { state: 'done', link: runs[0]!.url }
}

// pipeline.watch, command: exit 0 done, 1 failed, 2 still running; the output
// is the proof. Timed out (code null): still running, the step's timeout decides.
export function commandState(code: number | null, out: string): ActionResult {
  const tail = out.trim().split('\n').slice(-20).join('\n').slice(-2000)
  if (code === 0) return { ok: true, report: tail || 'done' }
  if (code === 2 || code === null) return { ok: false, later: true }
  return { ok: false, error: `pipeline: the command failed${code === 1 ? '' : ` (exit code ${code})`}`, ...(tail ? { detail: tail } : {}) }
}

// Bitbucket Cloud: the merge strategy of a method, a merge commit by default
// (a squash makes a new commit, which git.verify-merged would not find).
export const BB_STRATEGY = { merge: 'merge_commit', squash: 'squash', rebase: 'rebase_merge' } as const
export interface BbStatus { key?: string, name?: string, state?: string }
// May the PR be merged, from its commit's build statuses? As prReady: every
// one green, each required one (by name or key) there; running means later.
export function bbReady(statuses: BbStatus[], required: string[] = []): { ok: true } | { ok: false, later?: boolean, why: string } {
  const absent = required.filter(n => !statuses.some(c => c.name === n || c.key === n))
  if (absent.length) return { ok: false, later: true, why: `waiting for check ${absent.join(', ')}` }
  if (statuses.some(c => c.state === 'INPROGRESS')) return { ok: false, later: true, why: 'checks still running' }
  const red = statuses.filter(c => c.state !== 'SUCCESSFUL')
  if (red.length) return { ok: false, why: `${red.length} check(s) failed` }
  return { ok: true }
}

// The actions whose success means the task's PR is merged: the engine's merge,
// or git.verify-merged after the user merged on the Git host (I merged it, Check on GitHub).
export const endsMerged = (k: string) => isPrMerge(k) || k === 'git.verify-merged'

// Why a merged task's remote branch stays whatever its host says: a protected
// branch, or a base (the project's, the step's), which other work starts from.
export function keepsBranch(g: ResolvedGuards, branch: string, bases: (string | undefined)[]): string | undefined {
  if (isProtected(g, branch)) return 'it is a protected branch'
  if (bases.includes(branch)) return 'it is a base branch'
}

// Errors that pass by themselves: a git host refusing a push for a while,
// a branch policy not yet updated, a server error, the network.
const TRANSIENT = [
  /commit_refs/i, /base branch policy prohibits the merge/i, /HTTP 5\d\d/, /\b50[234]\b/, /bad gateway|service unavailable/i,
  /could not resolve host/i, /connection (reset|refused|timed out)/i, /operation timed out/i, /remote end hung up/i,
  /RPC failed|early EOF/i, /cannot lock ref/i, /rate limit/i,
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
// becomes 'uncertain' instead of being run again blindly. Except a merge: it
// asks GitHub first (merged, closed, open), and is run again up to twice (resumes).
// note: a line for the task's log.
// review: new commits since the reviewed one, to review before the merge.
// later: a pipeline still running, polled again. report: a watch's output, its
// proof. detail: what a failed watch printed, for the log and the coordinator.
// catchUp: the PR's base, when the merge is refused because the PR conflicts with or is behind it.
// base: the branch a merge went to (the PR's base on its host).
// A merge found the task's own interface changed since the user's approval: between which commits, in which files.
export interface Unapproved { since: string, head: string, files: string[] }
export interface ActionResult { ok: boolean, later?: boolean, report?: string, detail?: string, error?: string, toAgent?: boolean, review?: { since: string, head: string }, catchUp?: string, unapproved?: Unapproved, link?: string, commit?: string, alert?: string, note?: string, base?: string }
export interface Receipt { id: string, task: string, step: string, action: StepAction, state: 'pending' | 'done' | 'uncertain' | 'later', result?: ActionResult, at: number, by?: MergeBy, resumes?: number }
export const receiptId = (task: string, step: string, attempt: number) => `${task}.${attempt}.${encodeURIComponent(step)}`
