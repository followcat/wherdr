# Workspaces

[Documentation](README.md) · [Project management](project-management.md)

A **workspace** is a project of its own kind whose coordinator runs a set of
linked repositories, for work that spans several of them (an API and the app
that calls it, for instance). Its folder is a root such as `~/work`, under
which the repositories are cloned. The workspace itself has no git, but its
root may be a git repository (shared specs, architecture docs, the agents'
rules): that repository can then be a member like any other, see
[The root's own repository](#the-roots-own-repository). It belongs to one home
tab group; a group may hold several workspaces.

Each repository the workspace works on is a **member project**: an ordinary
project, with its own key, tasks and board, but **no coordinator of its own**.
The workspace's coordinator handles it. A repository belongs to one workspace
at most, and a workspace is never itself in a workspace.

## Creating a workspace

In Settings › Projects, *Add workspace* (in the *Workspaces* section's header), or in the
sidebar's *New* sheet › *Project* with its *Project | Workspace* switch on
*Workspace*, asks for (the same form in both places):

- its **name** and **key** (proposed from the name, as for a project);
- its **tab group** (optional): the home tab group it belongs to;
- its **machines and root folders**: each machine it runs on, with the root
  folder there under which the repositories are cloned (`~/work`). The first
  one checked is its home; its root must exist there. Nothing is cloned for you.
  *Browse* beside a root opens that machine's folders (from the typed folder
  when it exists, else the machine's home) to pick it; it is disabled while
  the machine is offline. From the New sheet, the sheet's machine is checked
  first.
- the **agent** for its coordinator, as for a new project.

*Create* adds it and starts its coordinator, whose first reply runs
`wherdr pm map list` and offers to build the [map](#the-workspace-map) from
the repositories it found. A coordinator that does not start is said in the
window; the workspace stays added. From the New sheet, the sheet then closes
and the coordinator's conversation opens. Alfred adds one too:
`wherdr alfred workspace add` ([Alfred's command](alfred.md)).

## The workspace's coordinator

The workspace's coordinator handles its members as its own projects: its
token reads and acts on each member, with no setting to change, at the *Act*
level of [Other projects this coordinator may act on](project-management.md#coordinators-on-other-projects)
(list, show, read, plan, adding, starting, editing and ordering tasks, tell…;
commands that name a project take `--project <member>`). A member's guards,
merges, settings and workflow stay with you. Its instructions (`AGENTS.md`)
list the members.

### What the workspace's coordinator may change

The workspace's coordinator **never changes a member's repository**: every code
change in a member goes through tasks (`feature split` of a feature,
`task add --feature`), done by task agents in their own worktrees. On Claude,
its settings deny edits inside each member's folder (rewritten at each start,
so a newly adopted member is covered from the coordinator's next start); it may
still write elsewhere under the root, such as specs and notes. On Codex, the
root is read-only: it reads every repository and writes only in its own folder. On omp, the
coordinator starts with a tool list that has no edit tool (its shell can still write, as
with Claude), and the root is added with `--add-dir`.

The root's own `AGENTS.md` and `CLAUDE.md`, when present, are copied into its
instructions at each start (a `CLAUDE.md` that only imports `AGENTS.md` adds
nothing), so the rules shared by every repository apply to it too.

A member has **no coordinator**: none is started for it, and none shows in the
sidebar: the workspace's **row** does, under its tab group, with its
coordinator's state, the tasks working and waiting for you (its members' and
its own features'), and its members' key badges, a small orange square on one
with a task waiting ([Coordinators](home.md#coordinators)). A tap on the badges
lists the members, each with its own counts. **n waiting for you** is a link:
one task opens its sheet; several open the workspace's board, or on a member's
line *Tasks to review* filtered to that member. Every wake about a member's task goes to the workspace's coordinator,
its first line naming the task (`PAY-3: stuck: …`), and *Ask the coordinator*
on a member's task asks it too. Its scheduled wakes' health summaries cover all the members' tasks.

The workspace has **one autopilot** for all its members: *At once* and *Tasks
/ day* count the tasks of every member together, and *Keep the board busy*
starts the members' to-do tasks in board order. Features never start: they
have no agent.

## Shared settings

A workspace holds the settings its members take:

- the **machines** beside its own, and the **clone root** on each. A member's
  clone on a machine is `<root>/<repo path>`: with the root `~/work` at home and
  `/srv/work` on another machine, the member `~/work/payroll-api` runs in
  `/srv/work/payroll-api` there. A member runs only on the machines that have
  its clone under the root: nothing is cloned for you;
- the paused machines and the placement;
- the base branch, the branch name template and the commit message template;
- the On state change command and its events;
- the agents, models and [reviewer fallback](project-management.md#reviewer-fallback);
- the worktree setup;
- the [workspace instructions files](#workspace-instructions-files);
- *Archive done tasks after* and *Delete the task's branch after its merge*.

A member stores only its key, name, color, machine, folder, workspace and
repository visibility. Each setting comes from the workspace unless the member **overrides**
it: a field the member sets itself is its own from then on (the list is kept
in its `overrides`). Clearing the member's base branch, branch name template,
commit message template or On state change command gives the workspace's back.
Everything that reads a project's settings, the engine and the coordinator's commands included, reads
them with the overrides applied.

A workspace keeps these settings in its `shared` settings, whether you set them
in its sheet or Alfred or `wherdr pm` does: a change of the workspace's working
branch reaches every member at once (`plan --project <member>` and `autopilot
show` give the member's working branch). A workspace stored before kept some of
them (base branch, branch name, placement, archive delay, delete-branch) on
itself; wherdr moves them into `shared` once at start and says so in its log.

A member's General tab saves only the fields you change: changing its base
branch overrides that field alone, and its agents or worktree setup changed
there override those (kept on the member), never giving it a copy of the
workspace's workflow. When a member takes the workspace's working branch and
its repository has no such branch (on origin, else locally), the task starts
from the repository's current branch, and its log says so (*develop not found
in this repository: using main*); a member's own base branch is used as is.

A member's sheet shows, for each of these settings, whether it follows its
workspace. Its General tab starts with *Settings come from WS unless you change
one here.*, and each setting (on the Machines part too, and its placement)
says *From WS* while it takes the workspace's value, shown in the field. Change
one and it says *Own value · Use WS's*: that setting alone is the member's, the
others still follow. *Use WS's* gives that one setting back to the workspace at
once (its own value is dropped; `project-update` with `{ follow: <field> }`).
The base branch also warns when the workspace's working branch is missing from
the member's repository (*develop not found in this repository: using main*).
A member running its own workflow shows *Own workflow* on its agents and
worktree setup: they come back with the workspace's workflow (below).

## Workspace instructions files

A member's task runs in a worktree outside the workspace's root, so its agents
never see the root's own rules. **Workspace instructions files** (the General
tab of the workspace's sheet) are files under the root whose text the worker
and the reviewer of every member's task get, after the workflow's own
instructions, each under a heading naming it (`## Workspace instructions (AGENTS.md)`):

- *Default*: the root's `AGENTS.md`, else its `CLAUDE.md`, when one is there;
- *These files*: up to 10 paths under the root, one per line, checked like the
  worktree setup's (relative, no `..`, no `*`);
- *None*.

They are read again, on the workspace's home machine, at each worker start,
each step sent to the worker and each review round, so an edit reaches the
next one: a worker whose files changed gets them again with its next step.
Each file is cut at 16,000 characters; a cut file, and a listed file that is
missing (skipped), get a line in the task's log. The task sheet's Description
tab names the files its agents got.

A member **inherits** them (*Workspace WS's*), turns them off (*None*) or
replaces them with its own paths under the root (*These files*), in its own
General tab.

## Workspace skills

Skills kept in the root's `.claude/skills` (spec-kit's `speckit-plan`, say)
reach the worker and the reviewer of every member's task, Claude and omp alike:
before each worker or reviewer start, wherdr links each skill folder (one with
a `SKILL.md`) into the task's worktree at `.claude/skills/<name>`. The links are
ignored through the repository's git exclude, so nothing reaches the member's
commits or its `.gitignore`, and an edit at the root is read by the next agent
start. A skill of the same name that the member's repository has is its own and
wins; a link whose skill left the root goes. The task's log names the skills
linked at the worker's start.

The setting is in the General tab of the workspace's sheet, under *Workspace
skills*: *Default* (the root's `.claude/skills`, when there) or *None*, which
removes the links at the next agent start in each worktree (the member's own skills stay). The
root's own repository is left as it is: its worktrees hold the root's skills.

## Adopting a repository

The workspace's coordinator makes a repository a member when a task first
needs it, with no question to you:

- `wherdr pm repo adopt <repo>`: `<repo>` is its path under the root (such as
  `payroll-api` or `apps/web-app`), or its full path inside the root; `.` (or
  the root's own path) adopts the root's own repository.

The new member gets a key and a name proposed from its folder (as the New sheet
does: `payroll-api` → `PA`) and the next free color, takes every shared setting
and the workspace's workflow, and its repository's visibility (public or
private) is checked at once. Its line on the [map](#the-workspace-map), when it
has one, names it. Each adoption is written to the workspace's log and listed
in the health summary of the coordinator's next scheduled wake (*Repositories adopted since the last
check*).

wherdr refuses:

- a path outside the workspace's root, a symbolic link that leads out of it
  included (a link inside the root counts as the folder it leads to);
- a folder that is already a project, of this workspace, another one or none,
  or another project's clone on that machine;
- a folder that does not exist (nothing is cloned for you) or is not a git
  repository;
- a repository without an `origin` when the workflow its tasks would run
  pushes or opens pull requests.

### The root's own repository

When the workspace's root is itself a git repository, `wherdr pm repo adopt .`
makes it a member project: its key and name are proposed from the root's
folder (`~/specs` → `SPC`), and it has its own board, tasks and workflow
like any member. Its clone on another machine is that machine's root.

- Its tasks' worktrees hold the **root repository's files only**: a worktree is
  a checkout of what the root tracks, so the repositories under the root
  (separate git repositories, untracked by the root) are never in it. The
  worktree setup never copies or shares a path inside, or holding, another
  git repository (*not copied services (another git repository)* in the
  task's log).
- Its tasks get no workspace instructions files: their worktree already holds
  the root's `AGENTS.md`.
- A root without a remote works with a workflow that merges locally
  (`git.land`); a workflow that pushes or opens pull requests is refused at
  adoption, as for any repository without an `origin`.
- The workspace's coordinator never changes it itself: on Claude, its edits
  are denied in the whole root then, so specs and notes change through the
  root member's tasks, and it plans in its own folder.

Adopting the root still refuses a root that leads elsewhere through a symbolic
link, and a root that is already another project.

A member runs only on the machines that have its clone at
`<root on that machine>/<repo path>`: before a task's first start on another
machine, its readiness check looks for that clone, and a machine without it is
left out of placement (*not ready*) until you clone it there.

## Shared workflow

A workspace has its own workflow, proposed and accepted like a project's
(`template show` and `template edit` on the workspace work on it). A member
without a workflow of its own runs the workspace's; a member may have its own
instead (a repository with a different review, for instance): the first
workflow accepted for the member becomes its own, and its tasks move to it.
The member's Workflow and Guards tabs show the workspace's workflow it runs,
with a line that says so (*Follows WS's workflow* on the Workflow tab); a change
saved there gives the member its own. A member with its own workflow says *Own
workflow · Follow WS's* there, and can follow the workspace's again: *Follow
WS's* (after a confirmation), or Alfred's
`wherdr alfred project template <member> none`. Its own workflow is removed
(its agents and worktree setup are the workspace's again), its tasks move to
the workspace's, and its log says so.

The workspace's [guards](project-management.md#guards) apply to every member,
its own workflow included: they sit between your settings and the project's,
and the strictest wins, so a member can add protected branches or keep a merge
for you, never loosen the workspace's. For a member, `template show` lists them
apart (`workspaceGuards`) and says when it runs the workspace's workflow.

The workspace's coordinator reads the workflow each member runs
(`template show --project <member>`, `plan --project <member>`): its `runs`
line says whether it is the workspace's, which a change reaches at once (a
member keeps no copy), or the member's own. It never changes a member's own
workflow: `template edit --project <member>` is refused, and the refusal points
to the workspace's workflow, which every member without its own runs.

## Context folders

A member task's worktree holds its own repository only. **Context folders** give
a task's worker and reviewer read-only snapshots of other members, so a spec
task in the [root's own repository](#the-roots-own-repository) or a reviewer
checking a contract between two repositories can read them.

- On a task type, in the workflow JSON: `"context": "all"` or
  `"context": ["PAY", "WEB"]`.
- On one task: `wherdr pm task add "Spec the export" --type spec --context PAY,WEB`,
  or `task edit <task> --context … --reason …` (from its next start; `""` puts
  back the task type's, `none` turns it off). `all` is every other member.

A task's own setting wins. wherdr refuses it outside a workspace, for a project
that is not another member, and for the task's own project.

At the task's first start, for each member with a clone on the task's machine,
wherdr fetches its base branch from `origin` and makes a detached, read-only
worktree of that commit at `<home>/.wherdr/pm/context/<member>/<commit>`, shared
by the machine's tasks. **The task keeps those commits**: a later start of its
worker, and its reviewer, read the same ones even after the base moved on (a
commit the clone and `origin` no longer have is skipped, never replaced). A
snapshot is reused only when unchanged and still read-only; else it is built
again and the log line says *(it had been changed: built again)*. The
instructions (the review file for a reviewer) get a *Context (read only)*
section listing each member, its repository path, the commit and the folder,
and the task's log one line:
`context: PAY @ 1a2b3c4 (skipped API: no clone on laptop)`. A failed fetch shows
*(not fetched)* (the clone's copy of the branch is used), a clone without
`origin` *(local branch)*. A member that cannot give a snapshot is skipped with
its reason, never stopping the task.

Claude and omp agents get `--add-dir <folder>` for each snapshot. Codex gets
none: its sandbox already reads everywhere, and `--add-dir` would make the
folder writable.

The worktree sweep removes a snapshot that no unfinished task's latest worker
or reviewer reads and that no start used for an hour (`git worktree remove` in
the member's clone, or the folder itself when the clone is gone).

## Features

A workspace's tasks are **features**, never ordinary tasks: wherdr refuses any
other task type on a workspace and asks to add the task to one of its member
projects instead. A feature has no agent and no step of its own; its
sub-tasks are ordinary tasks of the members, one per repository. Each
sub-task's card on the board shows its feature's id (`WS-3`) as a tag.

The workspace's coordinator runs them with no question to you:

- `wherdr pm feature add "<title>" [--description "<text>"]`: a new feature.
- `wherdr pm feature split <WS-n> [--from <path>] < plan.json`: in **one call**, adopts the
  repositories the plan needs (as [repo adopt](#adopting-a-repository) does),
  adds one sub-task per repository, chains them and starts those that wait
  for nothing. It is all or nothing: the whole plan is checked first (each
  repository once, what adopting it would refuse, task types, links,
  cycles), and the sub-tasks are added together or not at all; a split
  refused after its adoptions removes the members it adopted. The plan:

  ```json
  {
    "order": "The API first: the app calls it",
    "tasks": [
      { "repo": "payroll-api", "title": "Serve payslips as PDF", "type": "task", "files": ["src/pdf"] },
      { "repo": "web-app", "title": "Add a Download button", "type": "task", "after": ["payroll-api"], "mergeAfter": ["payroll-api"] }
    ]
  }
  ```

  `repo` is the repository's path under the root, or a member's key; `after`
  and `mergeAfter` name repositories of the plan or existing tasks. `order` is the
  coordinator's one-line reason for the order, kept on the feature.

  The plan comes on stdin, or from a file with `--from <path>` (stdin is then
  ignored): a path under the workspace's root, read on the workspace's machine.
  A path outside the root is refused, and so is a symbolic link that leads
  out of it, as for `repo adopt`.

  A plan made from a spec's `tasks.md` can name it, and the lines each
  sub-task covers (see [Plan lines](#plan-lines)):

  ```json
  {
    "order": "The API first: the app calls it",
    "plan": "specs/018-export/tasks.md",
    "tasks": [
      { "repo": "payroll-api", "title": "Serve payslips as PDF", "type": "task", "refs": ["T010", "T011"] }
    ]
  }
  ```
- `wherdr pm task add … --feature <WS-n> --project <member> [--refs T012,T013]`: one more
  sub-task later (`--merge-after <task>,<task>` too); `wherdr pm task edit
  <task> --after <task>,<task>` changes what a task not started yet waits
  for, and `--merge-after <task>,<task>` what a task not done yet merges
  after (`""` for nothing).
- `wherdr pm feature close <WS-n> [--reason "<one sentence>"] [--anyway]`: once every
  sub-task is done or abandoned. A feature with a plan file is refused while
  lines of it are still unticked: the answer lists them (their ID and the
  first 80 characters), and the coordinator asks you before it adds
  `--anyway` to close it all the same.

A task of a member may start after tasks of the workspace's other members
(`after`), never after a task outside the workspace or a feature, and never
in a cycle. A task others wait for cannot be removed.

### Plan lines

A spec's `tasks.md` holds checkbox lines with stable IDs, such as
`- [ ] T012 [P] [US3] Write the tests` (notes may follow on the line). A feature
keeps the path of that file as its **plan file** (`"plan"` of the split, a path
under the root, relative; `show <WS-n>` gives it as `planFile`), and a
sub-task keeps the IDs of the lines it covers as its **refs** (`"refs"` of its
entry in the split, or `--refs` of `task add --feature`; an ID is letters,
digits and dashes, ending in a number: `T012`, `US3`, `FR-12`). Both are
checked with the rest of the plan, before anything is added: refs need a plan
file, and the plan file must exist under the root. `show <task>` gives the
refs, and the worker's instructions say *Plan lines: T010, T011 in
specs/018-export/tasks.md*, with the rule that the engine ticks them.

**wherdr ticks the lines itself**, not the coordinator (on Claude, a
workspace coordinator's edits in the root are denied once the root is
adopted). When a sub-task with refs is **done** (its whole workflow finished,
the same *done* that releases a `mergeAfter` wait; an abandoned task ticks
nothing), the engine, on the workspace's machine and in the root folder:

- ticks each ref's first open line (`- [ ] T012 …` → `- [x] T012 … (done: PA-1,
  1a2b3c4, 2026-11-17)`: the task, the merge's short commit when known, the
  date in UTC), keeping the rest of the line. A line already ticked, or not
  found, is left as it is and said in the task's log (*plan: T011 not ticked
  (already ticked)*). An ID is matched whole: `T1` is neither `T10` nor `T1-2`.
  Only checkbox bullets count (`-`, `*` or `+`, then `[ ]`): a numbered list
  (`1. [ ] T012`) is not a plan line, and nothing inside a fenced code block
  (opened by three backticks or `~~~`) is, so an example in the file is never ticked
  or listed as open by `feature close`.
- when the root is a git repository, commits that file only
  (`git commit --only -- <file>`: other staged or unstaged work is untouched,
  git never prompts and none of the root's git hooks runs, so no formatter
  touches other files), and only when the root is on a branch (no detached
  HEAD), with no merge, rebase, cherry-pick, revert or bisect under way, with
  git's index not locked, the plan file tracked and with no uncommitted change
  (staged or not, or hidden by `assume-unchanged` or `skip-worktree`: the file
  must hold HEAD's text), and the root's base branch checked out: the root
  member's base, else the workspace's, else origin's default branch. With
  none of them known, nothing is committed: set the workspace's base branch. The file is written beside itself and moved into
  place. The message is the workspace's commit message template when it
  has one (`{tag}` and `{id}` of the sub-task, `{title}` as *tick T010 (the
  sub-task's title)*), else `WS-1: tick T010, T011 (PA-1)`. A commit that
  fails (a signing program refuses it, say) or takes over 45 seconds puts the old text back,
  unless the file changed meanwhile.
- when the root has no git, writes the file and nothing else.
- never writes a plan file that belongs to another git repository than the
  root's own (a member's clone under the root, or a root inside a larger
  repository): that file changes through its own tasks. It never reads
  or writes a path that resolves under a `.git` folder or outside the root.

Some conditions pass, and the engine waits and tries again, at most every 5
minutes, 12 times or for an hour: git's index is locked, a merge or rebase is
under way, the file changed while it was read. An offline machine is said
once in the task's log and waited for. Past the bound, and for the others
(local changes to the plan file, the file not tracked or in another
repository, another branch, no branch, no base branch known, a commit that failed or timed out, a plan file moved out of the root or
deleted), **nothing is written and the engine does not try that task again**.
The same goes for a pass where no ref could be ticked (each line missing or
already ticked). Each of these is said in four places: the task's log (*plan
file has local changes*, *the root is on branch dev (not main)*, *not tracked
by git*…), `show` (as `planTick`), a notification to you, like a stalled
task's (*PA-1: plan lines not ticked*, opening the task; it follows your
*needs you* notification rules), and a wake to the workspace's coordinator,
when its autopilot is on, so that it can ask you. Tick the lines by hand
then, or leave them.

### Features on the board

A feature shows on the board as **one card**: its title and id, its progress
(*2/3 merged*), one chip per sub-task (its id badge, its step and a square for
its state: to do, working, waits for you, merged, abandoned), its merge order
line (the plan's `order`) and what its sub-tasks still wait for (*MOB-1 waits
for WEB-1*). A tap on a chip opens that sub-task's sheet; a tap elsewhere opens
the feature's.

The card sits in the column of the feature's state: *To do*, *Working*, *Done*
once closed, and **Your turn** while a sub-task waits for you, with that
sub-task's badge (*WEB-1: Merge the PR*). A merged sub-task is not archived
while its feature is open, so the card keeps counting it.

Pick the workspace in the board's project picker to see the features and the
tasks of all its members together. Its sub-tasks then fold into their feature's
card; the switch *Sub-tasks in their columns too* shows them in their columns
as well, each tagged with its feature's id.

### Merge order

`after` orders the starts; `mergeAfter` orders the merges. A sub-task whose
`mergeAfter` tasks are not **done** waits in its project's merge queue, out
of line, with the reason *waits for LED-4 to be done*; the other PRs of that
queue merge meanwhile. Done means the upstream task finished its whole
workflow: merged, and its deploy watch passed when the workflow has one. The
task's sheet says *Merges once LED-4 is done.*, and its card shows the wait
while it is in the merge queue.

If an upstream task is stopped or abandoned, the waiting one keeps waiting
(no cascade stop) and the workspace's coordinator gets one wake for it: start
the upstream again, or drop the wait with `task edit <task> --merge-after ""`.
`mergeAfter` follows the same rules as `after`: within the workspace, never
a feature, never a cycle, counting `after` and `mergeAfter` together (a task
that merges after one that starts after it would block both). While it waits,
its new commits are not pushed either: they go once the upstream is done.

A sub-task's worker that finds halfway it needs something the split did not
plan reports `blocked:on <task|repo>: <need>`: its task parks until that task
is done, then goes on in the same conversation (see
[A task waiting for another task](project-management.md#a-task-waiting-for-another-task)).
A wait that would close a cycle is refused and goes to the coordinator as a
decision. So a contract both sides need (proto, API, schema) is its own first
task in a split.

A feature's state is never stored, it comes from its sub-tasks: **to do**
until one starts, **working** (also once they have all ended, until it is
closed), **waiting for you** while one is under *Your turn*, and **done** once
the coordinator closed it. `wherdr pm list` gives it.

## The workspace map

The workspace's coordinator keeps a **map** of the repositories: what each one
does, what it talks to and what uses it, so it can pick the repositories of a
feature. Nobody reads every repository up front: the map fills as tasks touch
them. The first time a task touches a repository, the coordinator writes its
line; it corrects a line that turns out wrong.

- `wherdr pm map show`: the repositories mapped so far.
- `wherdr pm map set <repo> --does "<one line>" [--talks a,b] [--used-by c]`:
  a repository's line (`<repo>` is its path under the root, such as
  `payroll-api`; `--does` is 160 characters at most). A set that leaves out
  `--does`, `--talks` or `--used-by` keeps that part of the line; a line for a
  member project names it.
- `wherdr pm map remove <repo>`: takes a repository off the map.
- `wherdr pm map list [--refresh]`: every git repository under the root, up to
  three folders down, with an automatic one-line description (the
  `description` of its `package.json`, `Cargo.toml` or `pyproject.toml`, else
  its README's first sentence) and whether it is mapped. No model reads them:
  the list is cached a day; `--refresh` looks again.

To find the repositories of a feature, the coordinator reads the map and the
list, then reads only the 2 or 3 likely repositories, or asks you.

The map is kept in `maps/<WS>.json` in the projects data folder. After each
change wherdr writes it as `map.md` in the coordinator's folder, which the
coordinator reads at each start, like its memory.
