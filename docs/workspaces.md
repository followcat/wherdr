# Workspaces

[Documentation](README.md) · [Project management](project-management.md)

A **workspace** is a project of its own kind whose coordinator runs a set of
linked repositories, for work that spans several of them (an API and the app
that calls it, for instance). It has no git: its folder is a root such as
`~/work`, under which the repositories are cloned. It belongs to one home tab
group; a group may hold several workspaces.

Each repository the workspace works on is a **member project**: an ordinary
project, with its own key, tasks and board, but **no coordinator of its own**.
The workspace's coordinator handles it. A repository belongs to one workspace
at most, and a workspace is never itself in a workspace.

## The workspace's coordinator

The workspace's coordinator handles its members as its own projects: its
token reads and acts on each member, with no setting to change, at the *Act*
level of [Other projects this coordinator may act on](project-management.md#coordinators-on-other-projects)
(list, show, read, plan, adding, starting, editing and ordering tasks, tell…;
commands that name a project take `--project <member>`). A member's guards,
merges, settings and workflow stay with you. Its instructions (`AGENTS.md`)
list the members.

A member has **no coordinator**: none is started for it, and none shows in the
sidebar. Every wake about a member's task goes to the workspace's coordinator,
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
- the base branch and the branch name template;
- the agents, models and [reviewer fallback](project-management.md#reviewer-fallback);
- the worktree setup;
- *Archive done tasks after* and *Delete the task's branch after its merge*.

A member stores only its key, name, color, machine, folder, workspace and
repository visibility. Each setting comes from the workspace unless the member **overrides**
it: a field the member sets itself is its own from then on (the list is kept
in its `overrides`). Clearing the member's base branch or branch name template
gives the workspace's back. Everything that reads a project's settings, the
engine and the coordinator's commands included, reads them with the overrides
applied.

## Adopting a repository

The workspace's coordinator makes a repository a member when a task first
needs it, with no question to you:

- `wherdr pm repo adopt <repo>`: `<repo>` is its path under the root (such as
  `payroll-api` or `apps/web-app`), or its full path inside the root.

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
with a line that says so; a change saved there gives the member its own.

The workspace's [guards](project-management.md#guards) apply to every member,
its own workflow included: they sit between your settings and the project's,
and the strictest wins, so a member can add protected branches or keep a merge
for you, never loosen the workspace's. For a member, `template show` lists them
apart (`workspaceGuards`) and says when it runs the workspace's workflow.

## Features

A workspace's tasks are **features**, never ordinary tasks: wherdr refuses any
other task type on a workspace and asks to add the task to one of its member
projects instead. A feature has no agent and no step of its own; its
sub-tasks are ordinary tasks of the members, one per repository. Each
sub-task's card on the board shows its feature's id (`WS-3`) as a tag.

The workspace's coordinator runs them with no question to you:

- `wherdr pm feature add "<title>" [--description "<text>"]`: a new feature.
- `wherdr pm feature split <WS-n> < plan.json`: in **one call**, adopts the
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
- `wherdr pm task add … --feature <WS-n> --project <member>`: one more
  sub-task later (`--merge-after <task>,<task>` too); `wherdr pm task edit
  <task> --after <task>,<task>` changes what a task not started yet waits
  for, and `--merge-after <task>,<task>` what a task not done yet merges
  after (`""` for nothing).
- `wherdr pm feature close <WS-n> [--reason "<one sentence>"]`: once every
  sub-task is done or abandoned.

A task of a member may start after tasks of the workspace's other members
(`after`), never after a task outside the workspace or a feature, and never
in a cycle. A task others wait for cannot be removed.

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
