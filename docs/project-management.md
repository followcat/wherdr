# Project management

[Documentation](README.md) · [Project](../README.md)

wherdr v3 can run your work as tasks on a board: each task goes through the
steps of its project's workflow, and agents do the steps. Nothing happens until
you turn it on.

## Getting started

A setup window walks you through three steps for one project, one per screen.
Each step does the thing in place; Next waits until it is done, and Back shows
only when there is a step to go back to (never on the first). While no project
went through every step, the **Board** header shows *Finish setup (2/3)*,
which opens it at the first step left; once one project's coordinator runs,
the button is gone. **Settings › Projects › Set up a project** opens it too, on
the first project with a step left, and *Add project* opens it on a new
project.

There is no workflow to pick here: the project's coordinator sets it up with
you, and you change it any time by talking to it or to Alfred. Templates stay
in the project's [Workflow](#workflow) tab for advanced use.

1. **Turn on project management.** Off, wherdr changes nothing. *Turn on* is
   the main button; under it, a quieter *Let Alfred guide me*: it opens Alfred's conversation
   (see [Home](home.md#alfred)) and asks it to walk you through the setup.
2. **Your project.** Pick the machine, then a git repository found there or
   any folder (a new or empty one offers `git init`); name, key and color
   follow the folder and can be changed. Once added, wherdr checks whether the
   repository is public; correct it if the check is wrong (until it is
   checked, it says *not checked* and nothing more). Then name its coordinator
   (prefilled with the project's name), pick its
   coordinator's agent and, for Claude or Codex, its model (empty: the agent's
   default; you can also change it later in its conversation). Both are kept as
   the project's coordinator default, so a restart uses them again. With several projects, pick the one to set up,
   or add another.
   **What a project needs:** a git repository (each task works in its own
   worktree), and a remote named `origin` for a workflow that pushes, opens or
   merges a PR, checks a merge or watches a pipeline. A repository without
   `origin`, such as a folder you just ran `git init` in, works with a workflow
   that lands locally, like `vibe`.
3. **Meet your coordinator.** The coordinator is the agent you talk to about
   the project: it adds tasks and follows them on the board. *Start with…*
   starts it and opens its conversation. Its first message looks at the
   project and proposes how you work on it (the checks before a merge, the
   reviews, who merges) as the project's first workflow, saying why; your yes
   saves it, guards included
   ([Guards](#guards)); see [its first
   conversation](#the-coordinators-first-conversation). Until then its tasks
   follow a minimal default: one task type, `task`, *to do → work → done*.
   Its folder is new at its
   first start: wherdr answers the agent's "trust this folder?" question for
   it (that folder only, never yours), as for Alfred's. While the agent is
   still starting, the step says so; if it asks something (a login, say),
   *Answer its question* opens its conversation. Next (*Finish*) waits until
   it runs.
   It keeps a memory of its own, `memory.md` in its folder: your decisions
   and preferences, read at each start. wherdr never rewrites it, so the
   coordinator remembers them after a restart or a change of agent (Claude,
   Codex…).

Projects imported from v2 ([Migrate from v2](migrate-from-v2.md)) have no
workflow either: ask their coordinator, or open the project, then
*Workflow › Start from a template*. There, an example that needs a remote
warns when the repository has none.

**New › Project** opens straight on adding a project: the machine tabs (with
several machines), that machine's git repositories with a search, then *Or
any folder* with **Browse**: a new or empty folder (created at start, `git
init` offered), or any folder without git (a folder of several projects, for
instance). Picking one fills the name and key, which you can change; a folder
under the machine's home shows as `~/…`. There is no template to pick: the
project gets the minimal default workflow, its coordinator starts at once
with the agent you chose (*Start with Claude*, *Codex*…), and its first
message proposes a workflow ([its first
conversation](#the-coordinators-first-conversation)). A folder without git
needs no workflow: it has no tasks (a task needs git for its own worktree),
and its coordinator does the work in it directly. Below, *Existing projects*
lists the projects whose coordinator does not run, to start it again; those
running are in the sidebar, and with none stopped the heading is hidden. On a
computer the sheet is wider, with a taller repository list.

Then ask the coordinator for tasks, and answer what shows under *Your turn* and
*Decisions*.

### The coordinator's first conversation

On a project with no accepted workflow, the coordinator's first start sends it
a first message, and its instructions say its first reply proposes one:

1. It looks at the repository: README, docs, stack, tests, CI files,
   branches, recent commits, and where its PRs go (GitHub, Bitbucket, none).
2. It introduces itself as the project's coordinator and says in a few lines
   what it understood of the project; on an empty or nearly empty repository,
   it says so and asks what you want to build.
3. In that same reply, it proposes a workflow (`wherdr pm template edit`),
   often from the closest example of the template library, its diff against
   the minimal default, with the [guards](#guards) that fit, and says in a few
   lines why (what it saw). Starting the coordinator counts as your request,
   so it needs no message from you first. You accept or refuse it in the
   [Workflow](#workflow) tab, as any proposal. This first proposal may set
   guards; later ones never do.
4. It then asks, as choices, what you would change: stricter (PRs, reviews,
   CI checks, you merge) or lighter (fewer checks, wherdr merges), and
   proposes again.

Until you accept one, tasks follow the minimal default. Once accepted, the
section leaves the coordinator's instructions.

The first message waits until the coordinator's session is ready, however long
it takes to start (up to 10 minutes), and the project's log says whether it was
sent, queued or not delivered and why. Coordinators started together (the v2
import card) start one after another, each once the one before is up. If the
message still does not get through, the coordinator's row says *First message
not delivered* (a stopped one too), its menu offers *Send again* (a new
conversation when its session ended), and Alfred tells you
(`wherdr alfred coordinator resend <KEY>`). Its next start, whichever, gives
it the message again.

Along the way, the coordinator (and Alfred) may suggest a setting you may like,
or one that solves a problem you mention: once, highlighted with
`ui open --target`, and not again if you let it pass. When you need something
wherdr cannot do, they may suggest an issue (or a pull request when the fit is
clear) on wherdr's repository: they show you the draft first, with no private
data, and post it only on your yes.

## Projects

**Settings › Projects** holds the *Project management* switch, *Set up a project*,
the project list and the [template library](#template-library): each row shows
the name (with a **Public** badge for a public repository), the key, the machine
and the folder. *Add project* opens the setup window on a new project; *Open the
board* goes to the board. Until the list is read, the switch and the rows show
as grey blocks and both buttons wait; a failed read says why, with *Try again*. A row opens the
project's sheet, with five tabs: General, Workflow, Guards, Automations and
Autopilot; on a computer it is a wide window, and its General fields pair up
side by side (name and key, worker and reviewer). Its ⋯ menu removes the project from wherdr, after a confirmation:
its folder, branches and task worktrees stay on the machine.

A project can also be a [workspace](workspaces.md): a folder without git whose
coordinator runs several linked repositories, each one a member project that
takes the workspace's settings unless it sets its own.

### General

- **Name**, **Key** and **Color**. Task ids start with the key. Change it and every task,
  old ones too, shows the new key: on the board, and in what wherdr writes for you
  and its agents (wakes, notifications, task logs, PR titles, `wherdr pm` outputs,
  branches of tasks started from then on); texts written before the change read the new key too. Links and commands with a former key still work.
  The color, picked from a small palette, is the project's key badge everywhere:
  its coordinator row and conversation header, board cards, the task sheet, its
  task agents' headers and *Tasks to review*.
- **Coordinator name**: what the project's coordinator is called after its key badge,
  in its sidebar row, its conversation header and what names it (notifications,
  decisions, proposals). Empty: the project's name, which follows a rename.
- **Other projects this coordinator may act on**: one row per other project, Off
  (the default), Read or Act. See [Coordinators on other projects](#coordinators-on-other-projects).
- **Base branch**: the project's working branch. New tasks start their worktree
  from it, and a step that names no branch opens its PR to it or merges into it.
  Pick one of the repository's branches or type a name; unset, the repository's
  current branch. A running task keeps the branch it started with.
- **Branch name**: the template each new task's branch is named from, for
  repositories that require names such as `feature/PROJ-12-fix-login`. Fields:
  `{id}` (the task id), `{tag}` (the card's ticket key, such as `PROJ-12`, else
  its first tag, else the task id), `{type}` (`bugfix` for a task type whose name
  has *bug* or *fix*, else `feature`) and `{slug}` (the title in lower case, cut
  to 40 characters). Example: `{type}/{tag}-{slug}`. It needs `{id}` or `{tag}`;
  characters git refuses are dropped. Empty: `task/{id}`. The name is set at the
  task's first start: a later title, tag or template change leaves it alone.
  When the worker pushes to another branch (it checks one out, or its note has a
  `Branch: <name>` line or a link with `?source=<branch>`, as a Bitbucket pull
  request link), wherdr follows that branch: its pushes, PR and merge checks
  use it, never the old one.
- **Archive done tasks after**: 1, 3, 7 (the default), 14 or 30 days, or
  *Never*. A done task stays in the Done column that long, then the engine
  archives it (see [Archived tasks](#archived-tasks)). A shorter delay archives
  at once the done tasks it now covers.
- **Delete the task's branch after its merge**: on by default. Once a task's
  PR is merged, by its merge step or by you on the Git host (*I merged it*,
  *Check on GitHub*), wherdr deletes the task's remote branch and says so in
  the task's log (*deleted the remote branch task/WHR-12*). Off: branches stay,
  for teams that keep them. See [Workflow](#workflow) for when a branch stays.
- **Agents**: the worker and the reviewer its tasks start with, each with an
  optional model (empty: the agent's default), and the reviewer's optional
  **Fallback** (see [Reviewer fallback](#reviewer-fallback)).
- **Worktree setup**: what wherdr prepares in a new task's worktree before its
  worker first starts, so the worker does not rebuild it. Short help lines sit
  above its fields, laid out in two columns on a computer and one on the phone.
  Saved with *Save*, on its own row under the fields and enabled once a field of
  the General tab changed, in the workflow's `worktree` block (shown in Workflow › JSON):
  - *Files to copy*: ignored files taken from the project's clone, such as `.env`
    or a local config, one path per line. Literal paths only; a file git tracks
    (it is already there) or the clone does not have is skipped, and the log says so.
  - *Folders to share*: big folders that can be rebuilt, such as
    `node_modules` or a cache, copied from the clone (copy-on-write where the
    disk allows it, so the task's own changes never reach the clone) only when
    the *Lockfile* (default `package-lock.json`) is the same in the worktree
    and the clone, and the clone's install is up to date with it. Empty:
    `node_modules`. *Share no folder* shares none (`"share": []`): the setup
    command then runs for every new task.
  - *Setup command*: run in the worktree, such as `npm ci --prefer-offline`,
    when a folder could not be shared (the task's branch changed the lockfile,
    or the clone has no install) or when no folder is listed. Once it succeeds
    it does not run again for that task. *Time limit*: 10m by default and at most.

  The task's log gets one line with what was copied, shared or skipped and the
  command with its time; the worker's instructions say what is ready. A
  command that fails or runs past its limit puts the task under *Your turn*
  with its last output lines; *Try again* runs it again.
  ```json
  "worktree": { "copy": [".env"], "share": ["node_modules"], "command": "npm ci --prefer-offline", "timeout": "5m" }
  ```
- **Repository**: public or private, as wherdr found it (*Check again*) or as
  you set it. A public repository gets the coordinator's public-repository rules.
- **Based on**: the template the workflow was copied from and its version, for
  information only: a later change to the template, or its deletion, does not
  reach the project.
- **Machines**: the machines its tasks may run on. The first is the project's
  own (*Home*, its folder), read only. *Add a machine* picks one of the connected
  machines and takes the path of the repository's clone there (`~/project`); once
  saved, wherdr runs that machine's readiness check (see *Start on…* under
  [Board](#board)) and shows *Ready* or what is missing. Each machine shows its
  last check (*Not checked yet* before the first); ↻ runs it again. Each machine also
  shows its memory as placement reads it: *5.2 GB free of 16.0 GB*, on macOS
  *pressure normal, ≈8.3 GB available of 18.0 GB*. ✕ removes a machine:
  new tasks no longer start there, tasks already there stay. Its switch off pauses it
  for the project instead, its clone kept ([Pause a machine for a project](machines.md#pause-a-machine-for-a-project)). Alfred does the
  same with `wherdr alfred project machine add|remove` ([Alfred](alfred.md)).
  Each machine's card shows, live (read again every 10 s), what the
  coordinator's `autopilot show` sees: *Online*, *Offline* or *Paused*, its
  available hours, its **memory** as a bar (its agents' estimates, the rest of
  what is used, free, the reserve hatched at the end), cores and load (on macOS
  the memory pressure), its agents at work with their task and weight, and
  **what it takes now**: the heaviest weight that fits (*Takes standard now ·
  heavy: …* says why not heavier), or *Takes nothing now* and why (*full: 4
  agents (cap 4)*, *3.1 GB free, needs 3.4 GB with its reserve*, *paused for
  this project*, *offline*). Under the placement picker, a small picture and one
  line explain the strategy, and *Next* names the next to-do task and the
  machine it would go to, by the pace of that task's own account on each machine,
  or why it waits (no room anywhere, Keep the board busy off, a limit, the task it
  is chained after, held for room, another task's files). What a machine takes is
  weighed with the project's learned estimates, as placement weighs it. The board's header opens this block (its server icon: the
  picked project's sheet, or Settings › Projects with several projects).
  **Placement** chooses how new tasks spread over these machines: *Heavy to the
  strongest* (the default: light and standard work at home when it fits, heavy
  work on the machine with most room), *Balance the load* (each task on the
  machine with the largest share of memory and cores left after it) or *Home
  first* (other machines only once home is full). A machine fits a task when
  its free memory covers the task's estimate plus the machine's reserve
  (Settings › Machines; on macOS the memory macOS reports available, its free
  percentage of the RAM, which counts what it can reclaim or compress). An idle machine (no wherdr agent at work there) always
  takes one task its RAM can hold, even with less free memory than that: the
  reserve only holds its second task and beyond; on macOS a *critical* memory
  pressure still holds every task. A task that waits for room names it, and so does the
  coordinator's `autopilot show`. A task too big for every machine it may use
  (their RAM less the reserve is under its estimate) runs on the best one
  instead of waiting forever, and its log says so once. A worker started
  again in its worktree (a catch-up, red CI, a send-back, the step it is woken
  for) is weighed by what it does, not by its type: heavy only while its step
  still lacks its screenshots, standard otherwise.
- **Shown in**: the home tab that shows the project's coordinator and its tasks
  to handle, saved at once. *Automatic* (the default, with the groups it means
  in brackets): every tab holding one of its machines, so a project whose
  machines are in several groups shows on each of them. A machine paused for
  the project is left out, unless one of its tasks still runs there. Or one machine group,
  or *All tabs*. Without a machine group the sheet points to Settings ›
  Appearance › Machine tabs; deleting a group puts the projects shown in it
  back to Automatic ([Machines as tabs](home.md#machines-as-tabs)).

### Workflow

The **Workflow** is *how each task runs, step by step*; the
[Autopilot](#autopilot) is *when the project works without you*. The tab
starts with that line and a link to the Autopilot tab (who starts tasks and
when).

The project's own workflow, read only: pick a task type and its diagram shows
how a task of that type runs. A line on top gives its route in a few words
(for example *Worker, with screenshots → Open a GitHub PR to v3 → Reviewer, up
to 3 rounds → You press “Merge”*), so two types compare at a glance. The steps
are cards laid out in rows that snake across the width (three per row on a
computer, one column on a phone). Each step is a card with its id, its board
column, who holds it (worker, reviewer or coordinator, with the agent and model
from the project's agents; the engine; or you), how it ends (a report, a
verdict, your button, or an action such as *Open a GitHub PR to v3* or *Merge
the GitHub PR · squash · once smoke green*), its timeout, the proofs it needs
(screenshots, a report, a link) and a sentence saying what happens there. A
merge step shows its guard: the branch is protected and you merge, or the
engine merges. Coloured arrows mark the path: an agent works (purple), the
engine acts (blue), the task waits for you (orange), and a dashed red loop
sends the work back from a review, up to its number of rounds, then you
decide. A square travels the path (still when the system asks for reduced
motion). *JSON* shows the whole workflow, read only, with *Copy*.

Nothing in the tab edits the workflow. To create or change one, *Ask the
coordinator* opens the project's coordinator with a first message to complete;
it writes the new workflow (`wherdr pm template edit`) and you accept or refuse
it (below). A project without an accepted workflow says its tasks follow a
minimal one (*to do → work → done*) and shows *Start from a template*: pick a
template or an example to start from, or ask the coordinator to propose one.

What a workflow holds: its task types, and the steps of each. Each step
has an id, a column on the board, who holds it (worker, reviewer, coordinator
or none), how it ends (a report, a verdict, you, or an action) and, for an
action, what it does: land on a branch, push, open a PR, merge a GitHub or
Bitbucket PR, check that a branch was merged, or watch a pipeline, with its
branch, merge method and required checks.
Landing merges the target into the task first (a conflict goes back to the
agent), then pushes it to the target on `origin`. In a repository without
`origin` it moves the local target branch instead (made when missing), unless
that branch is checked out in a folder: switch that folder to another branch.

A **pipeline watch** (`pipeline.watch`) has the engine follow CI or a deploy
by itself, so no agent is woken only to read *still running*. It checks every
`every` (default `1m`) until `timeout` (default `30m`). Its `source`:

- `github` (default): the GitHub Actions runs of the task's commit, or of
  `branch`'s commit on origin now (no run yet: still running, so an earlier
  commit's green run never counts); `workflow` keeps one workflow only.
- `command`: `command`, run in the task's worktree on the project's machine,
  exits `0` done, `1` failed, `2` still running: a CircleCI or Bitbucket
  check, a `helm` or `kubectl` status, a health URL. Its output is the step's
  proof.

Green: the step ends, and the coordinator is not woken. Failed (which run and
job, and the tail of the output) or past its timeout: the task's log and the
coordinator get it once, and the step comes to you, or goes back to the worker
with `"onFail": "worker"` (a timeout always comes to you). A step that had the
coordinator watch the deploy with a recheck becomes, in the JSON:

```json
{ "id": "deploy", "column": "Deploy", "ends": "action",
  "action": { "kind": "pipeline.watch", "branch": "develop", "every": "2m", "timeout": "90m" } }
```

or, outside GitHub, `"source": "command", "command": "./scripts/ci-status.sh develop"`.

A merge waits, up to 15 minutes, for its checks to finish and, after it
pushes the task's last commits, for GitHub to show them on the PR. The engine
looks again every half minute or so, without holding up its other tasks: a
merge never delays another task's start, in its project or another. Past the
15 minutes, the step comes to you with what it still waited for.

After a merge (`github.merge`, `bitbucket.merge`, or `git.verify-merged` once
you merged on the Git host), wherdr deletes the task's remote branch, unless
the project's General tab says to keep branches. It deletes it only when the
branch's head is the merged PR's head (no commit pushed since), no other open
PR uses or targets it, and it is neither a protected branch, a base (the
project's, the step's) nor the repository's default branch. Otherwise it stays,
and the task's log says why (*kept the remote branch task/WHR-12: commit
1a2b3c4 was pushed after its merge*). A PR closed without a merge, or an
archived task, keeps its branch.
In JSON, a task type may set `weight` (`light`, `standard` or `heavy`, see
*Add task* under [Board](#board)).

**Bitbucket Cloud.** A worker step can open the PR with the agent's own
Bitbucket tool (`evidence: ["link"]`). Then either a step that ends with you and
checks the merge (`action: { kind: "git.verify-merged" }`: you merge on
Bitbucket, then press its button), or a step that lets wherdr merge
(`action: { kind: "bitbucket.merge" }`): it finds the task's open PR on
Bitbucket, waits for its builds (and the step's required checks, by name or
key), then merges with a **merge commit** unless the step names another method
(a squash makes a new commit that a later `git.verify-merged` cannot find). A
PR into a protected branch waits for you, as on GitHub, and a merge Bitbucket
refuses (approvals, branch restrictions) says why. The credentials come from
the machine that runs the task: `BITBUCKET_TOKEN` (an access token), or
`BITBUCKET_USERNAME` with `BITBUCKET_APP_PASSWORD`, in the environment
herdr-core runs with; wherdr never stores them.

The ⋯ menu adds *Change log* and *Save as template* (copies the saved workflow
into your templates; the project is untouched).

An accepted workflow change reaches the tasks already under way: each stays on its step,
found by its id. A task whose step is gone goes on to the first step of the new
plan it has not passed yet, as if it had just reached it (an action step runs
its action), and its Log says so.

When the project's coordinator proposes a change to the workflow (only after
your request), a square marks the project's row (*1 to review*) and the
**Workflow** tab, whose first row, *Change proposed by the coordinator*, opens
the review: the change in one line, who proposed it (the project's coordinator,
with the project's colored key, or Alfred), your request that led to it, in
full (*Show all* unfolds a long one) with its time, then the change, *Refuse*
or *Accept*. The review opens on *Diagram*: the proposed workflow drawn as in
the Workflow tab, one changed task type at a time, with the steps added (green),
removed (red, dashed, back where they stood) and changed (cyan: each changed
field before → after, such as holder, agent or model, how it ends, action, rounds
or timeout) framed and named, a legend, and one line on what changes for that
type's tasks (*For feature tasks: review changes its model; a new step shots*).
*List* shows the same change as a list (merge rule, guards; instructions as a
text diff), *JSON* the raw diff. A proposal made before the workflow changed again is refused, and the
review says so: ask the coordinator to propose again. The *Decisions* view links to this review. [Alfred](alfred.md) can propose
a change too, on your request in its chat: you answer it in the same review.

In the coordinator's conversation, a *Workflow change* card sits under the last
reply of the turn that made the proposal (never a later one): what that
proposal changes in one line (from the workflow it was made against, so a change
made before it never shows; an added task type with its steps, PR target and
who merges), the same diagram, compact, for the first changed task type (cards
only, with its marks, legend and what changes for its tasks; a tap opens the
review), who proposed it, your request with its
time and *Go to message* (back to it in the conversation), *Accept*, *Refuse*
and *See all changes* (the review). Once answered, the card shows the outcome, by whom and
when; each proposal keeps its own card, one the coordinator replaced before you
answered says *Replaced*.

#### Reviewer fallback

The workflow's `prefs` (template, task type or task, the nearest wins) say
which agents a task uses: `agent` and `model` for the worker, `reviewAgent`
and `reviewModel` for the reviewer (another model than the worker's, or
`"same"`: a fresh session of the worker's model, with the worker's agent).
`reviewFallbackAgent` and `reviewFallbackModel`, always set together, name the
reviewer to start instead when the review agent's account is out of quota on
the task's machine. Any pair works, and nothing is picked for you:

```json
{ "agent": "claude", "model": "claude-opus-5-5",
  "reviewAgent": "codex", "reviewModel": "gpt-6.1-sol",
  "reviewFallbackAgent": "claude", "reviewFallbackModel": "same" }
```

or a Claude reviewer with a Codex fallback:
`"reviewModel": "claude-sonnet-5-5", "reviewFallbackAgent": "codex", "reviewFallbackModel": "gpt-6.1-sol"`.
The fallback follows the reviewer's rules; *Save* refuses one that breaks them,
or one of the two prefs without the other.

Before it starts a reviewer, wherdr reads the review agent's account (the
reading of the home screen and pacing): at its limit and not yet reset, its
5-hour window at 90 % or more, or held by its [pace](quotas.md#pace), the
fallback reviews instead. A reviewer that hits its limit during a review (an
*account limit* [incident](#why-agents-are-gone)) is replaced at once by the
fallback, which reviews from the start. So is a Codex reviewer that stays open
on its *You've hit your usage limit* message, even when the quota reading shows
no numbers: its account counts as out until the reset time the message gives,
and the reviews waiting on it, or a new round, go to the fallback until then. Each switch is in the task's log
(*review: Codex out of quota until 14:52, reviewed by claude claude-opus-5-5*)
and on the review step of the task sheet's Plan. The next review uses the
review agent again once its quota is back. Leave both out (as in the example
templates) for no fallback: nothing changes, the review waits for the review
agent.

#### Review queue and re-reviews

One reviewer account runs a few reviews at once: 3 while its 5-hour window is
under half used, else 2. The other reviews wait their turn, oldest first, and
their card says so (*Review waits: 2 ahead on Codex*); started reviews finish
before new ones start. A hand-over to the fallback after a mid-review limit
does not wait. `autopilot show` lists each reviewer account with reviews
running or waiting: its 5-hour and weekly use, and its queue.

A review round after a send-back reviews only the commits since the last round
(with that round's findings), not the whole change again. Before a merge, new
commits since the review go back to a short re-review of those commits only;
commits that only merge the base, the task's own change unchanged, and
changes to comments only are not reviewed again (the same rule
as for your approval; a comment-only change is said in the log).

### Guards

Needs: [Workflow](#workflow).

Guards are the rules on branches: the **protected** branches, who may merge into
them (by default only you), and who may merge into the others (by default wherdr
itself, when a step says so). They come from your settings, the
[workspace](workspaces.md#shared-workflow) (for a member project), the project, a
task type and a task; the strictest wins, so a member, a task type or a task can
only make them stricter. A project can also let its coordinator merge an outside contributor's
PR after your yes: never, into the branches not reserved for you, or into any.

In the **Guards** tab:

- **Protected branches**: one chip per branch; type a name and press *Add*, or
  press × on a chip to unprotect it. wherdr never pushes to a protected branch.
- **Who merges into protected branches** and **who merges other branches**:
  *You* (the step waits for you) or *wherdr* (it merges by itself, a
  protected branch too). A task already waiting for you at a merge that a
  change gives to wherdr goes on at once: the engine runs the step again,
  and the task's log says why. A merge left to you that you do on GitHub
  ends the step as merged within a minute: the task goes to *Done*. A merge
  cut by a restart of wherdr (an update, a new build) goes on by itself:
  wherdr asks GitHub where the PR stands.
  Merged, the task goes on (its log says *merged before the restart*); closed
  without a merge, it waits for you with that reason; still open, the merge
  runs again, at most twice, then waits for you. A restart waits up to 20 s
  for a merge that runs.
- **Effect**: what each task type adds and, for each step that merges, whether
  it is left to you. It follows your changes before you save.

Only you, or Alfred (with [`wherdr alfred project guards`](alfred.md) after
your yes), can change guards: a project coordinator never can.

A message that sends you to a tab of the project sheet names it as
*Settings › Projects › KEY › Guards*; an agent also gives its in-app address,
`#/settings?section=projects&project=KEY&tab=guards` (tabs: `general`,
`workflow`, `guards`, `automations`, `autopilot`).

### Automations

Each automation adds a task and starts it at once, on a **schedule** (`every 2h`,
`daily 09:00`, `mon,thu 09:00` or a cron, in this machine's time) or on an
**event**, with an optional filter on the task's title. Each has its prompt (the
task's description) and its task type.

You don't write automations in a form: ask the project's coordinator (or Alfred).
The tab says so, with a button that opens that conversation. The coordinator
proposes a new automation, a change or a removal with
`wherdr pm automation propose`, only in a turn that comes from you. A card shows
what the automation does, when it fires and its prompt, with *Accept* and
*Refuse*. You see it in the conversation and at the top of the tab. A new
automation you accept starts switched on, and a change keeps the switch and the
past firings. The coordinator reads your answer with `wherdr pm automation list`.

The tab lists each automation with its switch (only you turn it on or off), what
triggers it in words (*every weekday at 9:00*, *when a task is merged · docs\**),
its next firing and *Run now*. Its last five results form a short timeline,
newest first: *Fired* with the task it added, *Waits for room*, *Skipped* (the
[pace](quotas.md#pace) held it) or *Failed* with the reason. *What it does*
opens the prompt.

### Autopilot tab

The project coordinator's [autopilot](#autopilot), as in its window, under its
line (*when the project works without you*) and a link to the Workflow tab
(the tasks it starts follow it), and a link to the [pace](quotas.md#pace) of
every account.

### Template library

**Settings › Projects › Template library** lists your saved templates (each
with its version) and the built-in examples. Tap one to read it: the plan of
each task type, then its JSON. A saved template's ⋯ menu renames it (its version
and change log come along) or deletes it, after a confirmation. A project never
follows the library: it starts from a copy (*Add project*, or *Workflow › Start
from a template* when it has none), so renaming or deleting a template changes no
project. To change a template, have a project's coordinator change
its workflow, then *Save as template*.

## Autopilot

Each project has its own autopilot, run by its coordinator; Alfred has none and
acts only when you ask it (in Alfred's conversation, the header's **Agent**
button only picks its agent). On the board with a project picked, and in a
project coordinator's conversation, the **Autopilot** button in the header (a
clock) shows the autopilot's state (green square: on; hollow: asleep) and a
count when the kept conversation ran with another agent. It is only about the
autopilot: a workflow change the coordinator proposed is a *Workflow change*
card in its conversation (see [Workflow](#workflow)). A tap opens its window
(880 px wide on a computer, up to 90 % of the screen's height; a full sheet on
the phone) with two tabs under its title, **Settings** and **Activity**. The
window opens on the tab you picked last (on this device; Settings the first
time); a link to the autopilot setting (`project.autopilot`) opens Settings.
**Activity**, under the autopilot's line and a link to the project's Workflow tab:

- on the board, *Open*, and a warning when its conversation
  ran with another one: *New conversation* with the default, or *Resume* the one kept (for
  Alfred, the agent resumed becomes its default); *Open* opens or starts it; when its
  conversation stopped (its terminal ended, for example when its machine
  restarted), *Resume the conversation* takes it up again with the agent that
  ran it, and *New conversation* starts a new one;
- the autopilot's state, a switch, today's counts and *Run now*;
- **the day's timeline**: a 24 h bar with the autopilot's hours shaded, a mark
  for each wake sent (filled), each wake skipped (hollow; each skipped slot, even for the same reason) and each task it started,
  *now* and the next wake (dashed; outside the hours, their next start); the worker's account
  [pace](quotas.md#pace) as a gauge (the week used against its line or limit,
  then *go* or what it waits for); then the same events listed, newest first:
  *Next wake*, *Now*, each wake sent (*Scheduled*, *Step check*,
  *Engine*, *Incident*, *Run now*: its first reason and *handled* or how it
  ended, a wake not handled highlighted), each wake skipped and why (nothing to
  do, the account ahead of its pace, nothing changed since the last wake…), each
  task the autopilot started (Keep the board busy, a wake; never yours);
  yesterday's below, in the same scroll.

**Settings**: the agent that answers the coordinator (applied at once; Alfred's
window has only this and *Open*, no tabs), then the autopilot's settings in four
groups the form saves together. A bar pinned at the bottom of the tab, visible
while you scroll, says *Unsaved changes* and holds *Cancel* (back to the saved
values) and *Save* (enabled once something changed). Leaving the tab or closing
the window with unsaved changes asks once whether to discard them. The groups:
**Goal**; **When it wakes**: *Every* (empty or `off`: no interval wake;
  stalls then show only through engine wakes), each wake bringing the goal and
  the health summary (see [Who sends a wake](#who-sends-a-wake)); then
  **Routines**, a list with *Add routine* under it. A routine is a row: when
  (days of the week as chips, *Every day* or *Weekdays*, and a time; *Advanced*
  takes a cron or a list such as `mon,thu 09:00`), its own goal (*Summarise
  the night's work for me*), a switch and *Delete*; tap a row or its pencil to
  edit it in place. At its time the coordinator gets a wake `Routine: <its
  goal>` with the health summary, whatever is left to do, within the hours and
  the pace; a slot that comes with the autopilot or the routine off, or
  outside the hours, is skipped. A routine wakes the coordinator with a goal;
  an [automation](#automations) adds a task. An *At* time set in an earlier
  version became one routine with the autopilot's goal. Then the routine events it also wakes on,
  a list with a switch per event and one line on what the coordinator does
  with it: *Task done* (start what follows, tell you, update the notes),
  *Task stuck* (unblock it before the engine's two failed fixes), *Ready for
  you* (usually not needed: you already get the notification and the *Tasks
  to review* card), *Task added* (by someone else than this coordinator, such
  as you, another coordinator or an automation). A new project starts with
  *Task done* and *Task stuck* on and the other two off; an existing project
  keeps its choice (one saved before an earlier version with only these two,
  then the default, had them turned off once). A question, a choice after
  review rounds and a block the engine gave up on always wake it. Then
  *Look for new work* (scheduled wakes even with nothing to do,
  with its own *New tasks / day*); **Limits**: *Tasks / day* (up to 1000,
  empty for no daily limit), *At once* (empty is *Auto*, as many as the
  project's machines have room for; both empty for a new project, while a
  project that kept the older defaults, 10 a day and 2 at once, keeps them,
  with the hint *Older defaults: clear the fields for unlimited and Auto*; a
  task whose step holds no agent, such as a PR or merge waiting for checks or
  the queue, or a step of yours, takes no slot) and **Keep the board busy**
  (see below); **Hours**: *From* and *To*, local hours for automatic work
  (*To* excluded; *22* to *6* spans midnight; empty: all day).

Automatic work (the autopilot, automations) waits while an account is ahead of
its [pace](quotas.md#pace) (a machine whose account waits is skipped) or no
machine the project allows has room for the task
([Machines](machines.md#manage-machines)), whatever the task counts; your own
starts never wait. The autopilot's limits and hours (*Tasks / day*, *At once*,
the hours) hold automatic work only too: a start you ask Alfred or a coordinator
for goes at once, with a word when it goes past one (*started; past the
autopilot's limit of 3 at once*), and still counts in them.

**Keep the board busy** (on by default while the autopilot is on): the engine
itself starts the next task to do, in [board order](#board-order), whenever a machine the project
allows has room, within the autopilot's limits, hours and pace. It never starts
a task that waits for its *after* tasks (those start once they are done), nor
one already under way, and each start goes in the task's log (*started by the
autopilot: room on* a machine) without waking the coordinator. Turn it off to
leave every start to the coordinator's wakes and to you.

The coordinator sees the same with `wherdr pm autopilot show`: whether Keep the
board busy is on and the task it starts next (or why none), the project's
placement strategy, one line per machine the project allows (memory, cores and load, its agents at work by
weight, and the heaviest weight it takes now, or why none: full, not ready,
paced, offline), and what each weight counts (*light* ≈ 0.7 GB, *standard* ≈
1.8 GB, *heavy* ≈ 3.9 GB at first) with the weight of each task type. While a
task runs, the engine measures the memory its worktree's processes take (the
agent, builds, tests, the dev server and its browser). Once 3 runs of a weight
have a measured peak in the project, that weight counts the largest of its
last 5 peaks plus 15 %, for example `heavy ≈ 2.7 GB, 2 cores (from 5 runs)`. `show <task>`
gives the machine a started task runs on. Its instructions say the engine
places tasks, `task start --on` picks a machine and `task add --weight` sets a
weight that differs from the task type's.

### Who sends a wake

A wake is a message wherdr sends the coordinator; its first line names who
sends it. The conversation shows it apart from your messages, as a compact
muted row across the column: the kind as a small coloured tag, its first
reason (*Scheduled wake*, *WHR-9: stuck: …*) and its time; a tap opens the
full text and the coordinator's whole turn. That turn ends at its own end,
at your next message or `!`/`/` command, or where the coordinator speaks on
its own (a background task it ran finished), which all show as usual below it.
Once that turn is over, the coordinator's last answer in it sits under the row, smaller and muted, two lines at
most. Consecutive routine wakes (no incident, nothing changed: no file edit
nor `wherdr pm` command beyond `ack`, `read`, `list`, `show`, `incidents`,
`help`; an answer that asks nothing) fold into one row, *3 routine checks ·
last: "WHR-12 merged"*, 08:00–11:00, with the first line of the last answer in
it, that opens on tap. The fold holds only the wakes and their own turns. An incident, or a wake whose answer asks you
something, keeps its row (in its stronger colour); an answer that asks you
stays a full reply, with its answer buttons:

- **Autopilot**: what needs judgment (an agent's question that is not a
  permission request, the choice after N review rounds), the routine events you
  turned on, *Run now*, and the **scheduled wake** (`Autopilot: scheduled
  wake`), on the autopilot's *Every* interval (and its routines, each with its
  own goal: `Routine: <goal>`): the goal, then a short
  summary of the project: tasks done since the last one, tasks waiting for you,
  tasks stalled for over an hour, and machines idle while to-do tasks wait.
  When nothing in it needs the coordinator, it acks at once with no further
  work. With the autopilot off, no scheduled wake comes (step checks and
  incidents still do). A *Health check* field set in an earlier version joined *Every*
  once: the shorter of the two was kept (3h when it was empty), `off` left
  *Every* as it was;
- **Step check** (`Step check: CO-1 (deploy)`): a step the coordinator holds,
  such as *watch the deploy*, at its start, each `recheck` and its timeout. It
  comes even with the autopilot off. Each recheck with no news on the task
  doubles the next interval (5m, 10m, 20m, 40m, then every hour); any news (a
  commit, its CI, a `tell`, your message to the coordinator, the step ending)
  starts it over from the step's own `recheck`. When a recheck finds nothing
  new, the coordinator postpones the next one with `wherdr pm step wait <task>
  --for 2h` or `--until-user` (no recheck until you write to it or act on the
  task), with a reason written to the task's log. The task sheet shows when the
  next recheck is due. Past the step's time limit, or while it waits until you
  write, the sheet's To do tab says what waits (*Waiting for the coordinator to
  check the deploy*, how long the task has been at that step, and the
  coordinator's last `step wait` reason) with **Ask the coordinator**: it sends
  the coordinator your message *Check where CO-1 (Fix) stands at its deploy step
  and end the step or tell me what blocks it* (starting it first if it does not
  run), as if you typed it, so the rechecks start over. The button then says
  *Asked*. A pipeline that can be polled is better watched by the
  engine (`pipeline.watch`, above), which costs no model turn;
- **Engine**: wherdr gave up on a block after failed fixes
  ([What wherdr fixes on its own](#what-wherdr-fixes-on-its-own));
- **Incident**: [the incident wake](#the-incident-wake).

Waking the coordinator costs a turn with its whole context, so with the
autopilot on and its events left off, it wakes only for these: an agent's
question, a choice after review rounds, a block the engine gave up on, a step
it holds, and its scheduled wake. A task done, ready or started, or
a block the engine fixed itself, wakes nobody. A permission request is yours,
in *Tasks to review*.

Each kind is its own wake, sent one after the other. Every wake ends with
`wherdr pm ack <id>`, whatever its kind.

**Wakes that would change nothing are not sent:**

- a **scheduled wake** while nothing the coordinator could act on changed since
  its last wake: every task where it stood then, no task it could start now
  (each to-do one waits for its *after* tasks, its files, room or a machine),
  no new block, no answer, no message of yours, and its health summary says
  nothing new (empty, or all its lines in the last one sent within 12 hours).
  It counts in the day's skipped wakes, as one with nothing to do;
- an **Engine** wake for a block whose only cause is an offline or paused
  machine: the incident already said so, and the engine goes on once the machine
  is back. It wakes the coordinator only if that resume fails;
- a second wake for an agent's **question** the coordinator already answered
  with `tell`, while the agent's question is still showing.

Each one skipped is listed by `wherdr pm autopilot show` (*skippedWakes*: when,
what and why), never in the conversation.

### What a task's agent said

A coordinator reads a task's agent with `wherdr pm read <task>`, on whichever
machine it runs: the last message of its conversation, or the bottom of its
screen when the conversation can't be read. It reads the agent `tell` reaches
(the one that holds the current step, else the worker); `--to worker` or `--to
reviewer` picks one, and `--lines N` (1 to 200, default 40) sets how much. A project's coordinator reads its own project's tasks only.
When an agent asks a question, its task's waiting line and the coordinator's
wake (*question*) carry the question itself, and `wherdr pm tell` answers it.

### What agents show in the chat

Every agent's instructions include a short *Showing instead of telling*
section: a table of situations, each with the tool to use and an example, so
agents show you things rather than describe them.

- Every agent: a `wherdr` block with `choices "A" | "B"` when it needs one
  choice from you (`choices "OK"` alone for a one-click confirm), and `task <ID>` for a task's live card when its state matters.
- Alfred and coordinators also: a setting highlighted (`ui open --target`), a
  live `status` card, and buttons you click (`ui action step|resume|open`),
  screenshots beside the chat (`ui show shots`). Alfred proposes a setting
  change as a card you apply (`setting set … --propose`); it never applies it
  itself.
- Task agents only write blocks: they have no `ui` command.

The same rules hold for everyone: one card or button group per message, after
the sentence that explains it; in a wake, blocks only (a `ui` command is
refused there); after a refusal, the in-app link in text, never a retry; and
never "I merged it" before the card shows the outcome, since only your click
acts.

### Coordinators' notes

A coordinator writes [notes](alfred.md#notes) with `wherdr pm notes list|show|add|edit|remove|file put|file remove`,
the same commands as Alfred's. It lists, edits, moves (`edit --scope`) and removes any note, whatever its scope. Left out,
`--scope` of `notes add` is the home tab its project shows in (`all` when it shows in every tab; when it shows in several
but not all, it names one). Its help asks it to rewrite a note to keep it short rather than add another, and to change or
remove another project's note only when it is outdated or you ask. Each change is logged with the coordinator's name.

### Coordinators on other projects

A project's coordinator works on its own project only, unless you let it work on
others in its project's General tab (*Other projects this coordinator may act on*):

- **Read**: `list`, `show`, `read`, `plan` and `incidents` on that project;
- **Act**: also `task add|start|stop|edit|note|order|tag|link|check|remove`,
  `tell` and `report back|close`, with the same rules as on its own project
  (in a wake, the other project's autopilot and limits hold its starts and adds).

A task's id names its project (`wherdr pm show DSH-4`); `list`, `plan`,
`incidents` and `task add` take `--project <KEY>`. Guards, merges, approvals,
settings, autopilot, workflow and automations of the other project always stay
with its own coordinator and you. Without the setting, the refusal names it and
links to the sheet. Each action goes to the task's or the project's log with the
acting coordinator's name (`coordinator WHR`), and the other project's
coordinator is told at its next wake. The coordinator's instructions list these
projects and their level from its next start.

## Board

The header has **Decisions** (with a count when some wait), **Add task**, the
project picker, a tag filter when tasks have tags, and,
with one project picked, its [Autopilot](#autopilot) button. The picker offers
*Follow machine tab* (the projects the [home tab](home.md#machines-as-tabs) picked
shows; **All** shows every one, and changing the tab updates the board in place),
*All projects*, or one project, shown as its key badge in its color then its name
(as in every project picker). Your pick is kept and follows you across devices;
until you pick, it is *Follow machine tab* once machine groups exist, else *All
projects*. The first column is **Your turn**, then the
project's columns, or *To do*, *Working* and *Done* for all projects. A done
or archived task is never under Your turn.
Until the board is first read, its columns show the shapes of cards, never
empty columns counting 0.

A card shows the task's title, its id (a badge in the project's color: a tap
copies it, *Copied*, without opening the task), the machine it runs on when its
project allows several (*machine-b*), its step, how long it has been in that
step (*12 min in review*) or, once done, how long it took from start to done
(*42 min*), a dot with its agent's state (worker or reviewer), where its PR stands (*PR open · waiting for checks*,
*checks failed*, *merging*, *The PR conflicts with v3*, *merged …*; *review pending*, never
*ready to merge*, while a review is still ahead or under way), its branch line when it
goes elsewhere than the project's working branch (*task/WHR-12 → develop*), what you have to do under
Your turn, the tasks it waits for, its first tags and its PR link. A refused
step is said in plain words, never as a command: the commands go to the agent.
When the engine has already asked the agent to bring a conflicting PR up to
date, the card says *The PR conflicts with v3: the agent is updating it* and
leaves Your turn while the PR is still in conflict; once it is not, it is back
under Your turn: *The agent brought the PR up to date with v3*, press again. Its menu (right
click, long press, or ••• when it has more than *Open*) offers:

- **Start**, on a task to do that waits for no other task;
- **Start on…**, on the same tasks of a project that allows other machines than
  its own: pick the machine (offline ones are greyed). Before a task's first
  start on another machine, wherdr checks that machine is ready for the
  project, and refuses the start with what fails there: the clone and its
  origin, `git fetch`, push rights (a dry run), `gh auth status` when the
  workflow uses GitHub, node and npm (against `.nvmrc` or `engines`), the
  clone's dependencies (a warning only: tasks cannot share them, see *Worktree setup* under [General](#general)), the
  worker's and reviewer's agent CLI and login, the `~/.wherdr/pm` folders, 5 GB
  free disk, and for a task with screenshots, reaching wherdr (set `APP_URL`
  behind a proxy) and Playwright's Chromium. A machine found ready is not
  checked again for 10 minutes; the menu shows the last check's result. A task
  stays on the machine it first started on. The coordinator does the same with
  `task start <task> --on <machine>`;
- **Stop…**, on a running task: its agent ends, the worktree, branch and work
  stay, and nothing is merged;
- **Continue**, **Take it as it is** or **Archive**, on a stopped task;
- **Check on GitHub**, on a task at its merge step or archived with a PR: its
  sheet opens with what wherdr found (see [Task sheet](#task-sheet));
- **Delete…**, on a task never started (no agent, worktree or branch). A task
  other tasks wait for cannot be deleted; its number is never given again.

**Add task** opens a sheet: the project, a title, the task type (with its steps
in one line), its weight, a Markdown description, the tasks it waits for, and
*Start now*. The weight says what the task needs of a machine: *Light* (docs, a
study), *Standard* (tests and typecheck) or *Heavy* (a build, e2e,
screenshots). *Auto* shows what it would be (*Auto: heavy (screenshots)*): the
task type's `weight` when the workflow sets one, else heavy when a worker step
asks for screenshots, light when the type lands no code (no commit, link or git
action), standard otherwise. The coordinator does the same with `task add
--weight`, and `show <task>` gives it.

### Archived tasks

A done task leaves the board some time after it is done: 7 days by default, set
per project in [General](#general). The engine checks at start and every 6 hours
and writes *archived after 7 days done* in the task's log. An archived task keeps
everything: its description, history, log, PR link, number and `wherdr pm show`;
its branch and PR are left alone. The Done column shows only done tasks not
archived, newest done first; at its bottom, a muted line, **142 archived · show**, opens the list
of the shown projects' archived tasks, newest first, with a search on title, id
or tag and *Show more* for the next page. A tap opens the task's sheet, which says
*Archived* with the date and has **Unarchive**: the task is back in Done, and its
delay starts again. `wherdr pm list` leaves archived tasks out; `wherdr pm list
--archived` lists only them. Check on GitHub still works on an archived task
with a PR.

### Board order

Each column lists its cards in board order: the tasks the coordinator put
first, in the order it gave, then the others, oldest first. Ask the
coordinator (or Alfred) to order them, for example the tasks waiting for a
merge in the order they should merge: it runs `wherdr pm task order <task>
[<task>…]`, which puts these tasks first in their column, in this order, and
leaves the others in their order after them. A done task is refused. The order
is the same for everyone and survives a restart; the project's log says who
ordered what. In a wake, the coordinator orders the board only with the
autopilot on.

Keep the board busy starts to-do tasks in this order, the merge queue takes
approved merges in it when several are ready at once, and `wherdr pm list`
returns tasks in it.

### Spec changes

When you change your mind about a task while it runs, the coordinator records
the change in the task's spec, so the reviewer reviews against what you want
now, not the first description:

- `wherdr pm task edit <task> [--title "<text>"] [--description "<text>"]
  --reason "<one sentence>"` rewrites the title or the description. The
  task's log keeps the reason and a short diff of the old and new text.
- `wherdr pm task note <task> "<text>"` adds a dated spec change under the
  description.
- `wherdr pm tell <task> "<text>" --spec` tells the agent and records the same
  text as a spec change.

The worker's and the reviewer's instructions give the description, then every
spec change, newest last, with the rule *the latest note overrides the
description where they disagree*. A running agent of the task is told at once;
the next ones read it from their step or review round. The task sheet's
Description tab shows the spec changes under the description. The coordinator
makes these changes only in a turn that comes from you, never in a wake.

When a review still fails after several send-backs on findings that
contradict a spec change, the coordinator may pass it, even in a wake and even
when the engine does not offer *pass*: `wherdr pm task decide <task> pass
--reason "<one sentence>"`, the reason citing the spec change (its date,
`YYYY-MM-DD`, or its words). wherdr refuses it when the task has no spec
change or the reason cites none, and then the choice stays yours. It only ends
the review loop: a merge only you may do still waits for you, and a critical
finding with proof stays yours. The pass is
written to the task's log, the coordinator tells you in its next message, and
*Decisions* shows it for a day under *Passed on a spec change*.

### Tasks that touch the same files

Tasks that change the same files do not run at the same time. At the start of
its work, the worker writes the files or folders it plans to change to
`files.txt` beside its instructions file (a folder covers what is in it); the
coordinator can name them ahead with `task add … --files app,docs/board.md`.
Every 5 minutes wherdr reads, for each started task not done yet, those
declared paths and the files its branch changed (`git diff` since the branch
started, new files included). Only a task whose work or review is still ahead
or under way (stopped too) holds its files: once it only waits for its merge,
the tasks behind it start. `docs/llms.txt`, whose conflicts wherdr solves
itself, never makes a task wait.

When a task starts for the first time (by you, the coordinator or an *after*
chain), and its declared paths overlap what such a task declared or changed, it
stays to do and its card says *Waits for WHR-12, same files*. It starts by
itself once that task is done or no longer touches them. **Start anyway**, on
its card's menu or in its sheet, starts it at once. A task with no declared
paths never waits. A worker that changes files beyond its declared ones adds
them to `files.txt` and says which in its closing note; the task's log notes
them too.

## Task sheet

A card opens the task's sheet. Tasks to review, Decisions' *Open task* and a task
link in the chat (`#/board?task=ID`) open it over the page you are on (a bottom
sheet on a phone), with `?task=ID` added to that page's address, so it survives a
reload and can be shared; closing it leaves the page as it was. The sheet shows its id badge by the title (a tap copies it; on a phone a long title takes two lines at most, cut with an ellipsis, a tap shows it whole, and one line once the sheet is scrolled or you type) and step, a note when it waits or was
stopped, the time it spent in each step with the time it waited for you apart,
its review rounds and CI fixes (*work 25 min · review 9 min · merge 8 min ·
waited for you 1 h · 2 review rounds · 1 CI fix*), which branch merges into
which once it has one (*task/WHR-12 → develop · 3 commits*, or *task/WHR-12 will
open a PR to v3* before its PR, with a button to copy the branch name), the
task's PR as a badge on that line (*PR #646 ↗*, opens it in a new tab; on a phone
it wraps under the branches; once that line scrolls away, the badge shows in the
sheet's header by the id, so the PR stays one tap away; nothing before a PR), and its buttons (*Start*,
*Report a problem*, *Open the agent*, *Stop*, *Delete…*). *Open the agent* is there whatever the
step: it opens the conversation of the agent holding the step if it runs, else the worker's (*Open
the reviewer* when only the reviewer runs), so you can ask it something; with both the worker and
the reviewer running, a small menu offers *Worker* and *Reviewer*. Once its agent ended, the button
stays disabled with *Agent is terminated* (a tooltip on a computer, a short line under it on a tap). Step times start
with this version: an older task shows only its total. Below, tabs: **Description** (the text rendered as Markdown, as in the chat but with no raw HTML; tags and the other links, the PR apart),
**Plan** (each step with its column, holder, send-backs, instructions, proofs
and screenshots: a report in Markdown, folded with *Show more*, shown once when
another proof repeats it; a commit as a short sha linked to the commit on the
Git host when the task has a PR; a link labelled, *PR #12*), **Comments** and **History**, all in the sheet's one scroll. A refused merge says why under its button.

**Comments** reads the agents' reports like a PR's conversation, oldest first:
the worker's *Done* (its report, each one as it arrived), the reviewer's *Sent
back* (the findings, with their weight) or *Passed* (what it left as minor),
the worker's *Fixed* (and the findings it contested). Each says who, when and
its program and model; its text is Markdown, folded past a few lines with
*Show more*. A task from before this version kept only its worker's last
report, so its earlier *Done* says just that.

**History** is the task's whole log in one timeline, oldest first: the same
hand-offs, wherdr's catch-ups and CI fixes, the coordinator's and your
actions, and wherdr's routine lines, lighter.

<a id="tldr"></a>**TL;DR.** On a task waiting for you, **To do** starts with at
most five lines in plain words, with no code names: **What changes for you**
(what you will see or what now behaves differently), **What to look at** on
the screenshots when there are some, and **Anything wrong** only when there is
a reason to hesitate (a finding left open, a check that failed, something the
worker could not do); *Full reports in Comments* below it. How it was checked
and what *Merge* does are left out: the step's badge says it.
Claude Haiku writes it through the `claude` CLI on the wherdr machine
(`claude -p`, safe mode, no tools), from the task's title, description,
reports and verdicts, the files it changed with their line counts (never
their contents) and its step; home paths, e-mail
addresses and tokens masked. It is written again only on a significant
change: a report or verdict that comes with new commits of the task's own or
new findings, or the first verdict on new commits. A merge or catch-up with
the base, a rebase, a CI re-run, a report that changes no code (the PR
opened) or a kept approval leaves it as it is. One task a minute; while the pace of this
machine's Claude account holds automatic work it waits, and **To do** shows
the worker's and the reviewer's notes with *TL;DR waits for the pace*. A task
whose last report is more than a day old keeps its TL;DR as it is, unless it
was written with an older prompt and the task is still open: it is written
again once in the new style.

An agent's question gets its own summary in [Tasks to review](#tasks-to-review):
two or three plain lines on what the agent asks, why it cannot go on and what
each option means for you, from the agent's last message (masked the same way).
The same model and pace rule; a question goes before the task TL;DRs, and it is
written once per question, again only when the question changes. While the pace
holds it, the full question shows alone.

**Check on GitHub** shows on a task with a PR at its merge step, or archived:
wherdr reads the PR now, for a merge stuck after a guard refusal, a PR merged
by hand on GitHub, or GitHub slow to see a push. Merged: the merge step ends as
merged and the task goes on (next step or Done), out of Your turn; an archived
task ends as merged. Still open: why it waits (its checks, a review, a branch
only you may merge into), with a link to the PR; a merge wherdr may do is tried
again within a minute. Closed without a merge: said, with **Archive…**. The
coordinator and Alfred run the same check with `wherdr pm task check <task>`
when you ask them to unblock a task.

### A task waiting for you

Open a task under *Your turn* and its sheet starts on **To do**: what the task
needs from you and the buttons for it, before its Description, Plan, Comments and History.

A tap on a card under *Your turn* goes where you act: when the task's agent
(worker or reviewer, on any machine) asks a question or a permission, it opens
that agent's conversation, its question last; anything else opens the sheet on
**To do**. The sheet stays one tap away: *Open the task* in the card's menu. An
agent that is not on screen here opens the sheet instead.

<a id="tasks-to-review"></a>**Tasks to review.** To clear a morning's work in a
few minutes, tap Home's **Tasks to review** card: it shows what waits for you
one at a time. A task to approve shows its key, title and project, its
[TL;DR](#tldr), its newest screenshots (the sheet's viewer, before and after
side by side), its PR and the review's verdict in one line, then:

- **Approve**: the *Accept* of To do; it leaves the list, the next one shows,
  and the engine merges it in its own order.
- **Reject**: say what to change, tap the screenshots that are wrong, and add
  your own (pick a file, or paste one); *Send back* returns it to its worker
  with your note, and each picked screenshot as a download with the task's key.
  It leaves the list too.

An agent's question shows its [summary](#tldr), the options of the agent's
`choices` line as buttons and *Another answer* with *Send*: either goes to the
agent as if you had typed it in its conversation, and the next task slides in.
Under them, *Full question*, folded: the agent's whole last message, drawn as in
its conversation (Markdown, its `wherdr` blocks), scrolling inside the window
when it is long (open when there is no summary). *Open the task* stays. A question answered anywhere (here, in the agent's conversation, a
coordinator's `tell`) leaves *Tasks to review* and *Tasks to handle* at once,
without waiting for the engine's next pass.

While the window is open, its list keeps its order and the task on screen never
changes by itself: a task that becomes ready goes at the end (*2 of 6*), one
handled elsewhere (approved, merged, answered) drops out, and if it is the one
on screen it stays, under a muted *Handled elsewhere: done* line (or what
happened), until you move on with the arrows. Closed and opened again, the list
takes the board's order.

Anything else that waits (a failure, a decision, another
step of yours such as *Create these tasks*) shows the answers of its To do tab
(its choices, *Try again* for a failed action), and *Open the task*. Every
task, whatever its step, also has *Open the agent*, as on the [task
sheet](#task-sheet): its agent's conversation, *Worker* or *Reviewer* when both
run, disabled with *Agent is terminated* once it ended. *3 of 12* with previous and next: a task you pass over stays in the list.
On a computer, → next, ← previous, A approve, R reject. Approve and Send back
say so on their button (*Approved*, *Sent back*) for a moment, then the next
task slides in (the arrows slide too, without it; a fade if your system reduces
motion); a failed action keeps the task with its error. After the last one:
*All done*: its check, the tasks passed over and *Back to the first*, grouped in
the middle (on a computer the window shrinks to them). On a computer it is a large window (960 px wide, up to 90 % of the
screen's height, screenshots two per row): only the task's content scrolls, the
filter, its title and the buttons stay. The filter at the top picks *Follow group tab* (the projects of the
home tab), *All*, a group or a project (its key badge, then its name); it follows you across devices like the
Board's picker.

- <a id="notes-on-a-task-waiting-for-you"></a>**A visual change to merge**: its [TL;DR](#tldr); then its screenshots large (swipe between them on
  the phone, a grid on a computer; tap one to zoom; each is labelled phone or desktop),
  *Full reports in Comments*, then *Merge* and *Open the PR*, or *Send back* with a note: the agent gets your note as what to fix.
  With no TL;DR yet, the **Worker's note** (its closing report: what
  was done, why it is done, what was tested) and the **Reviewer's note** (the
  verdict, what it sent back and was fixed during the rounds, what it left as
  minor) show in its place, each in Markdown, folded to a few lines with *Show more*, full
  width, one above the other (on a phone, *Worker* / *Reviewer* tabs above one note).
  A step you end (*Deployed*, …) shows the same under its badge.
  When the agent reworks the task after its review (new commits since the
  review), its new screenshots replace the shown ones, marked *after rework*;
  the earlier set stays in the Plan tab under *Earlier screenshots*. The merge
  step then sends the task back to review, which sees the new set.
- **A review to settle** after several send-backs: each choice the engine offers,
  with what it does.
- **A stopped task**: who stopped it and why, then *Continue*, *Take it as it is*
  or *Archive*, each with what it does. *Continue* on a step that ends with an
  action runs that action again.
- **A step that ends with you** (*Done*, or the step's own button): what to do,
  and its button, with *Open the PR* when the task has one.
- **The PR** is any link a step gave as its proof (`evidence: ["link"]`, such as
  a PR the worker opened with its own Bitbucket or GitLab tool) or the one the
  engine's `github.pr` opened. A pull request address from GitHub, Bitbucket,
  GitLab or Azure DevOps is added to the card's links as *PR #12*, and opens
  from *Open the PR* at the merge step, or after a refused merge.
- **A PR to merge on your Git host** (a step you end that checks the merge,
  `git.verify-merged`): wherdr does not merge it, you do. Its badge says
  *Merge the PR on GitHub* (or Bitbucket, GitLab, Azure DevOps, *your Git
  host*, from the PR link), and its button *I merged it* checks that the branch
  is in its target; the step's own badge and button text win. Not merged yet:
  *The PR is not merged into develop yet: merge it on Bitbucket (PR link), then
  press “I merged it” again*. It counts as merged when:
  - a merged PR from the branch into the target holds the task's commit, on
    GitHub or on Bitbucket Cloud (with its credentials), squash and rebase
    included;
  - or the task's commit is in the target and the branch has work of its own,
    even once its remote branch is deleted. For a task that continues an
    existing branch (`--from-branch`), the commits that branch already had
    ahead of the target count, whoever made them (a bot's PR branch). A branch
    with no commit ahead of the target at any time is *nothing was merged*.

  When you tell the coordinator it is merged, your word ends the step
  (`wherdr pm step done <task> --user-said "<your words>"`) even if the check
  disagrees: the task's log keeps *verify-merged disagreed: <why>* as a
  warning. This holds only for a step that waits for you, never for wherdr's
  own merge.
- **An agent's question or permission**: its text, and a button to open that agent.
- **A stalled review** (past its time limit, or its reviewer stopped without
  recording a verdict): one sentence says so, and **Restart the review** ends
  the reviewer if it is still there and starts a new one on the PR's latest
  commit, from the start. The step's time limit starts again.
- **A refused merge or a blocked task**: the reason in plain words, and what you
  can do (start it, open its agent). A failed action step (a merge GitHub
  refused) has *Try again* at the top of the sheet, which runs it again and
  writes its result in the task's History each time, even when it fails the
  same way. PR details that come back unreadable are read again (1, 2, 4 and
  8 minutes later), then the error ends with the last lines of the output,
  private parts masked.

On a phone, the To do buttons (*Merge*, the step's button, *Open the PR*,
*Start*, *Open the agent*) stay pinned at the bottom of the sheet while its
content scrolls, so they are always in reach: flush with the sheet's bottom
edge, the home bar's room inside the bar, with nothing scrolling under them;
the tab's last content still scrolls up above them. While you type in a field
of the sheet (*Send back*'s note, *Report a problem*, *Stop*'s reason), the
pinned buttons hide and come back when the keyboard closes: nothing covers the
field, whose own button (*Send back*) stays in view under it, and a long text
scrolls inside the field, the line you type always above the keyboard. A row of buttons that
wraps on a phone shares the width, so no button sits alone on its line.

### Report a problem

Something is wrong with a task waiting for you (the screenshots miss the asked
feature, a part is missing, a bug)? Tap *Report a problem* in its sheet, or in
its card's menu. Say what is wrong, tap the screenshots it is about, and keep
*Block the merge until fixed* on if the merge must wait. It goes to the
project's coordinator (started if it does not run), not to the task's agent,
with the task, its step, your text, the screenshots, the PR and the review: the
coordinator decides whether to tell the agent what to fix, send the step back to
the worker, or add a follow-up task. You never relay it yourself.

The report goes to the task's log, the card says *Problem reported 20:15*, and
the task stays under *Your turn* until the coordinator acts (`wherdr pm report
back` or `report close`), you send the step back, or you *Withdraw* it.

While a merge waits for you, wherdr watches its PR. When the PR starts to
conflict with its base, or falls behind it under a branch rule that wants it up
to date, wherdr merges the base into the branch at once (or asks the task's
agent to resolve the conflicts, starting it again if it was ended, however it
ended; if it could not start, the update is tried again a few times). While
it runs, the task leaves *Your turn* and Tasks to review, approved or not, and
stays in its column with a neutral line instead of the red conflict: *updating
with v3*, *the worker is solving a conflict with v3* (or *fixing the PR* for red
checks), then *updated with v3, GitHub is checking it* until GitHub reads the
new commit without a conflict (3 minutes at most). It comes back to *Your turn*
once the PR is clean, or when the update needs you (its worker waits, the
conflict is not solved in time). An agent's conflict resolution gets a short
re-review first. One update runs at a time per task. The update never takes
**Accept** away: the task sheet's To do tab keeps it, with the neutral line
under it, so you can accept the work while the update runs.

When an approved merge waits on something wherdr cannot do by itself (a
conflict or red checks no agent is on, its worker ended, its machine offline or
paused), *Merging* stops loading: the task is back in *Your turn*, the card says *Merge waits for its worker*, and
the sheet says in one sentence what it waits for, with **Start the worker**,
which starts the worker again in its worktree (or sends to it, if it runs) with
what to do. The merge goes on once its work is in.

**Accept** (the merge step's button when the workflow keeps the default label
*Merge*) is there as soon as the review passed, whatever the PR's state: in
conflict, behind its base, checks running or red, its worker ended. Accepting
and merging are two steps: you accept the work, and wherdr merges it in the
merge queue's order. The click merges nothing by itself and never fails on the
PR's state. It is an approval of the task's screenshots that stays: the log
records who approved, when and at which commit. The task leaves *Your turn* and
Tasks to review at once and shows in its column (*Merging*) with its place in
the merge queue or what wherdr is doing (updating with the base, the worker
solving a conflict, checks running). Later updates keep it: the base
merged in, a conflict resolved, red CI fixed. The card shows *Approved, merges
by itself*, and the task sheet *Approved on* its date. Once the PR is clean and
its checks are green, wherdr merges by itself, even on a branch only you may
merge into, and the log says so. The task comes back to *Your turn* (*Look
again, then merge*) only when its agent uploads new screenshots, or when the
task's own changes to interface files (`components`, `assets`, `pages` and
`layouts` folders) differ from those you approved. These keep the approval,
each said in one line of the task's log at the merge (*approval kept:
comment-only change*, *approval kept: base merge, same interface*, *approval
kept: no interface file changed*):

- changes to comments only, in CSS, SCSS, Less, JavaScript, TypeScript, Vue,
  HTML and Markdown files (compared with comments left out; text in strings,
  Markdown code and every space still count);
- what a merge of the base brought, a conflict solved included, as long as the
  task's own interface change is the same as the one you approved;
- a fix outside the interface files.

When the approval is dropped, the log says why: which interface files changed,
between which commits, or new screenshots. wherdr then asks the task's agent
why (started again if it was released): it uploads new screenshots of the
change with one line, *Back to review because: …*, what changed on screen and
why. Tasks to review and the task sheet's To do show it in a banner on top,
the other task it names as a link, above the new screenshots; until the agent
answers, the banner says what wherdr saw (the files and commits).

It also comes back when wherdr truly cannot go on: a conflict its worker could
not solve, a merge refused by a guard or by GitHub.

Until the merge ends, *Merging* stays loading, on the card and in
the task sheet, with what it waits for under it: its place in the merge queue,
its checks running, an update with its base, or its machine coming back
online. This comes from the approval wherdr keeps, so it is the same after a
reload and on every device. While its checks are red, the merge cannot go on:
*Merging* stops loading, and the card and the sheet say why instead of *merges
by itself*: *Checks failed (smoke): fixing: the worker is on it*, or what the
fix waits for, such as *Checks failed (smoke): waits for its worker, no room on
machine-a (needs ≈3.4 GB: …)* or *…, its machine is offline*. If the
merge is refused, *Try again* comes back in *Your turn* with the reason in plain
words.

#### The merge queue

Each project has a **merge queue**: every task whose merge may go on without
you (a merge the guards give to wherdr, or one you accepted, whatever its PR's
state when you did) enters it. Only
PRs ready to merge now stand in line: no conflict, no update required, the
task's last commit on the PR and its checks green. The first in line merges,
then the next one, a minute apart; the tasks the coordinator put first on the
board come first, in [board order](#board-order), then PRs that touch no file
another queued PR touches, then smaller changes.

A PR that needs work steps out of line until it is ready again, so it never
holds up the others: a conflict with its base, checks still running or red,
work handed to its agent, a merge GitHub blocks (a required review) or
refused (that one is yours, under *Your turn*, until a new commit). A ready PR merges as it is, without first being
updated with its base, unless GitHub requires it: wherdr updates a branch only
when GitHub reports a conflict, or reports it behind because the branch rules
want branches up to date. When the base moves, every queued PR that needs an
update gets it in the same pass, and their checks run side by side. An update
that merges cleanly is pushed by wherdr alone; a conflict goes to the task's
agent (started again if it was ended). What the agent commits for it (a
conflict solved, red CI fixed) is pushed by wherdr whatever the PR's place. An update that fails (a network error)
is tried again twice, a few minutes apart. Checks that fail go back to the
agent as red CI, not to you.

A task waiting in the queue with no work handed to its agent lets its agents
go once they are idle for 10 minutes, as for [a task that waits for
you](#agents-of-a-task-that-waits-for-you); wherdr starts the worker again
only if the queue hands it work.

The card shows the place (*2nd in merge queue*) or why the PR stepped out
(*in merge queue, out of line: conflict with its base*); a refused merge in the
queue stays off *Your turn*, and the log says when a task enters the queue and
when it comes first.

### What wherdr fixes on its own

Waking the coordinator costs a turn with its whole context, so wherdr fixes
the mechanical blocks itself and wakes it only when that fails:

- **a PR in conflict with or behind its base**: wherdr merges the base into the
  branch; a conflict goes to the worker (started again if it was let go);
- **red CI**: when the failed job's log shows an infrastructure error (an HTTP
  5xx, a download that timed out, a lost runner), wherdr runs the failed jobs
  again, once; otherwise, or red again after that, the failure goes to the
  worker;
- **a push refused because the branch is behind its remote**: wherdr brings the
  remote's commits into the task's worktree (a fast-forward, else a merge; a
  conflict goes to the worker), then pushes again;
- **a merge a file's own merge driver did not handle** (GitHub's *Update
  branch* runs none): when the clone's git config sets `wherdr.afterMerge`, a
  command, wherdr runs it at the worktree's root after each merge it makes or
  brings in (a catch-up, a sync, a landing) and commits what it changed before
  pushing. wherdr's own repository sets it with `npm install`, so
  `docs/llms.txt` keeps one line per entry. A PR updated on GitHub is taken
  into the worktree, fixed and pushed at once, also while its merge waits for
  you or for its turn in the queue; as after a catch-up, a merge the engine
  makes has the new head reviewed again;
- **an action interrupted** by a restart of wherdr: run again (a merge done
  meanwhile is recorded as merged);
- **a stalled agent** (below): nudged, then restarted once.
- **a task nobody moves**: one task's error never stops the engine's pass
  for the others; it is written once to that task's **History**. A working task
  wherdr cannot follow (no worker run, its PR unreadable) says why on its card
  (*The engine cannot follow it: could not read the PR: …*). And a working
  task with no stated reason (Your turn, a wait, a hold, its place in the merge
  queue, running checks, an agent holding its step or working on what it was
  handed) that has had no History line, no engine move and no step change for
  20 minutes is re-entered: its step's action, marked running but not running
  or never started, is run again (refused, the mark goes); a merge already
  tried at that commit is tried again once. wherdr looks again after 40 minutes, then 80…, and wakes the
  coordinator once per task and step, saying what it saw and tried. A step
  action that hangs holds its task 30 minutes at most; should it end after
  that, its late result is only noted in History (*its result is dropped*),
  never undoing what a later run did;

With the autopilot's *Task stuck* event on (a new project's default), the
coordinator is woken once as such a block begins, so it can act before the
engine's fixes run out; with it off, these blocks do not wake it. After 2 failed tries on the same
step (or 15 minutes with nothing left to try), wherdr wakes it once (an
*Engine* wake, whatever the autopilot's events) and says what it tried. Every try, and giving
up, is written to the task's **History**. Any other failure (a refused merge, a
check that waits for you) goes to *Tasks to review*, and wakes the coordinator
only when its *Task stuck* event is on.

### A stalled task

A working task is **stalled** when nothing moves: its CI is still red 10 minutes
after wherdr sent the failure to the agent and nothing was pushed, or the agent
holding its step has been idle for 5 minutes without saying it is done. Its card
shows the reason, and wherdr:

- nudges the agent once: the red CI again, with the failing tests read from
  `gh run view --log-failed`, or a reminder to finish its step. Never twice for
  the same cause (the same commit, the same step);
- 10 minutes after the nudge, if it is still stalled: ends the agent and starts
  it again (the worker with the red CI to fix, or the step's holder with its
  step), once;
- 10 minutes after the restart, if it is still stalled: wakes the coordinator
  (*Task stuck*, with the reason and what was tried);
- 30 minutes after the stall began, if it is still there: puts the task under
  *Your turn* and in the **Tasks to review**, with the reason, and
  sends a notification (it needs the *Needs you* level).

The task's **History** lists each of these: the stall, the nudge, the restart, the
hand-over to you and the notification.

A step that runs past its time limit (*Check work: over 3h*, *Check review:
over 45m*) or a stall leaves *Your turn* and **Tasks to review** once the task
is back to work: the coordinator tells its agent something (`wherdr pm tell`),
you or the coordinator start it again, or the step's agent, idle, is seen
working again. The step's time limit and the stall's 30 minutes start again
from then, so the task comes back if its agent stops again. The Log says
*back to work* and who sent it back. On a step the coordinator holds (*Check
deploy: over 90m*), the To do tab says *Waiting for the coordinator to check the
deploy*, with how long and the coordinator's last `step wait` reason, and
**Ask the coordinator** sends it your message (see *Step check* above): the
task is back to work at once, *Asked* on the button, and comes back at its next
time limit. *Report a problem* and *Stop* stay as they are. What only you can do (a merge, an answer,
a permission, a decision) stays until you do it.

A step's time limit counts only the time its agent could work. While the
machine it runs on is offline or unreachable, while the engine waits to resume
it after an incident, or while the task waits for room, a machine or the pace,
its clock stops: such a task never shows *over 3h*, it shows what it waits
for, and the limit goes on from where it stopped once the agent can work
again. The time in step shown on the card stays the real time.

### Why agents are gone

When a task's agents are gone (after a restart, or while wherdr runs), the
engine decides the cause from facts it reads, never a guess:

- **machine offline or unreachable**: its herdr-core does not answer;
- **herdr-core or wherdr restarted** (or the machine rebooted): every agent's
  terminal of a machine gone at once (none still running there), herdr-core
  started after the agents, or
  herdr-core ended them itself (a stop, a restart, the host shutting down);
- **agent killed or crashed**: its terminal ended with an exit code or a
  signal; **out of memory** when its last output says so;
- **account limit reached**: only when the account's reading at that time
  says it was at its limit ([Quotas](quotas.md));
- **unknown**, said as such, when the facts do not decide (an agent that
  exited with 0, a terminal missing on a core older than it).

Each one is recorded as an **incident**, per machine: when, the cause, the
facts used, the tasks and agents hit. The task waits with the cause (*The
agent's terminal is gone: …*), after a restart as while wherdr runs, and its
Log names the incident; wherdr then resumes it by itself
([The engine resumes the work](#the-engine-resumes-the-work)). An incident is open until its tasks run again (started
again, a new agent): what they wait for later is not this incident.

The coordinator lists them with `wherdr pm incidents [--since 2h|3d|<date>]`
(the last 7 days by default), and `wherdr pm autopilot show` gives the last
open one, so it tells you the cause the engine found.

### The engine resumes the work

A task an incident stopped waits for wherdr, not for you: it is not in Your
turn, the coordinator sees it as working (never stuck, nor waiting for you in
its health summary), its card says why it waits (*… wherdr resumes it once host-b is back*).
Once the cause is gone, the engine resumes it by itself, every minute:

- **when**: a restart, a crash or an unknown cause at once; a machine offline
  once it is back (still offline, its tasks keep waiting); an account limit
  once the account's reading says it reset;
- **how**: its worker starts again in its worktree. A Claude worker takes its
  conversation up again (`--resume`, its session id kept from its start) with
  *You were interrupted (…): check git status and continue*; Codex, or a
  conversation that cannot be resumed, gets a new agent that reads its
  instructions with a handover note saying the same. A task stopped at the
  review gets its reviewer again;
- **in order**: the tasks before it (`after`) first. A task that starts after
  one being resumed stays to do and *Waits for WEB-1 to resume*, never
  *stopped*; it starts once that one is done;
- **within the rules**: on its own machine when that machine has room and its
  account's pace lets it ([Machines](machines.md#manage-machines)), one start per machine and
  minute, never a second worker on the task;
- **once in a row**: stopped again for the same cause within an hour of the
  engine's resume, it is not resumed again: the incident's wake says so, and
  the task waits in Your turn until it is started again.

Its Log says *resumed after incident …*, and a stall or a step past its time
limit from the outage leaves Tasks to review once the task works again.

### The incident wake

Once the engine's resumes after an incident are done (none still under way),
the coordinators get **one wake per incident**, never one per task, headed
*Incident: <incident>, wake <id>*, even with the autopilot off. It gives the
engine's facts:

- the cause and the evidence it read (machine, times, exit codes, the
  account's reading);
- **Resumed**: the tasks working again;
- **Still waits**: those the engine resumes by itself, and why (*host-b still
  offline*, *the account's limit until <time>*, *waits for WEB-1 to resume
  first*, no room on the machine);
- **Needs you**: a task stopped again right after its resume, for the
  coordinator to start once the cause is fixed;
- **Needs the user**: a permission, a question, a sign-in, a merge or another
  Your turn.

Each project's coordinator gets its own tasks; the main coordinator (Alfred)
gets every project's, so he can say what happened for all of them. Both
follow one rule: **never state a cause they did not read**. Before explaining
a stop they run `wherdr pm incidents`, `wherdr pm autopilot show` and
`wherdr pm read <task>`; when those facts do not decide, they say the cause is
unknown and what they checked.

### A task's temporary files

A task's worker and reviewer keep their temporary files in the task's
worktree, in `.wherdr-tmp` (`~/.wherdr/pm/worktrees/<task>/.wherdr-tmp`), not
in the machine's `/tmp`, which is often small and shared by every agent:
wherdr sets `TMPDIR`, `CLAUDE_CODE_TMPDIR` and `NODE_COMPILE_CACHE` to it for
Claude Code and Codex alike. git ignores the folder (through the repository's
`.git/info/exclude`), so it is never committed and never keeps a worktree from
being removed. It goes with the worktree when the task ends (done, archived);
it stays when wherdr ends idle agents, for the ones started again later.

Before it starts an agent, wherdr checks the machine's `/tmp`: with less than
500 MB free, the agent is not started and the task waits with the reason
(free some space, then start it again).

### Processes an agent leaves behind

When wherdr ends an agent (the task is done, stopped, released or restarted),
it ends every process the agent started, not only its terminal: the
terminal's process tree and each process group in it (a test runner's shells
keep their group even once re-parented), with TERM, then KILL after 3 seconds,
on Linux and macOS alike.

At start and every 5 minutes, wherdr also looks on each machine for the
processes an agent started that are still there while their task has no live
agent, or no longer exists. It knows them by the temporary folder they
inherited from the agent (`CLAUDE_CODE_TMPDIR`, set to the task's
`.wherdr-tmp`), wherever they run, never by their folder alone. macOS hides
that from its own programs (`sh`, `zsh`, `sleep`): those go with the marked
process they run under or share a process group with, or, once re-parented to
`launchd` with their folder in that task's worktree (or in a worktree removed
since), on their own. It kills them and says so in the task's log (*killed 2
leftover processes, 4 h old, 90 % CPU*). Your own shell, editor, apps and
daemons are left alone by this sweep, even when they run in a worktree, and so
are the processes of a task whose agent runs.

Before removing a task's worktree, wherdr kills every process still working in
it, yours included, so nothing runs on in a deleted folder; the task's log
says how many.

A CPU guard watches the processes of a task (marked, or working in its
worktree): one above 80 % CPU for more than 20 minutes after the task's agent
ended is killed and logged on the task; while the agent runs, its coordinator
is told once instead.

The machine's line in Settings › Machines says *n leftover processes killed*
(since wherdr started), all three counted.

The wherdr template tells its workers to run a test command that could hang
with a timeout (`timeout 600 …`) and to leave no background job running when
they report done.

### Agents of a task that waits for you

Needs: [A task waiting for you](#a-task-waiting-for-you).

A task under *Your turn* (a step you end, a merge only you may do, a failure)
keeps its agents only for a while: once they have been idle for 10 minutes,
wherdr ends them to free the machine's memory. The worktree, the branch and
the files stay, and the card shows the task as before. When the task needs an
agent again (you send it back, a merge finds a conflict, CI goes red, new
commits need a review), wherdr starts the worker or the reviewer again in the
same worktree, with a note on where the work stands. The task's log says when
its agents were ended and started again.

The same goes when you answer and the task moves on: a review decision (*pass*,
say), *Send back*, *Try again* or a merge you confirm hands the next step to
its worker or reviewer, which wherdr starts again at once, also a worker that
had ended (on its own, or by a stop the task went on from). As a safety net,
wherdr also watches every task under way: when the agent that holds its
current step has not been running for 3 minutes (released, ended on its own,
or gone in a wherdr restart), wherdr starts it again in its worktree, with a
note on where the work stands, and the log says so. When it cannot, the card's
status says why (*Waits for its machine (offline)*, *Waits for its machine
(paused)*, no room on the machine), wherdr tries again every 3 minutes, and at
the second failure the project's coordinator is woken once (its autopilot on).
A start wherdr refuses (the agent's program missing, say) puts the task in
*Your turn* with the reason.

When wherdr hands the worker work of its own (a catch-up with the base branch,
a CI fix), the task leaves *Your turn* and its card says *the agent is
updating the PR*: its agents are never ended while wherdr waits for that work.
The task is yours again once the worker pushes or says it is done. If the
worker has ended when wherdr hands it that work, or ends before it pushes,
wherdr starts it again in its worktree with the same message, once. When it
cannot (its machine is offline, paused for the project or has no room, or the
worker ended again), the card says why it waits instead, for example *Waits
for its machine (offline)*, *Waits for its machine (paused)* or *Waits for its agent: it ended. The coordinator, or Stop then Resume,
continues it*, and the project's coordinator is woken once with that reason
(its autopilot on); with no coordinator to wake, the task goes to *Your turn*.
No room on its machine is tried again on every pass, and the coordinator is
woken once only when that has lasted 30 minutes.
Once the machine is back (online, or switched on again), wherdr starts the worker again by itself. Before it
ends a task's agents, wherdr pushes the commits the branch has not pushed yet;
if the push fails, the agents stay and the log says why.

A task has one worker and one reviewer at most. Two starts at the same time
(yours, the coordinator's, the engine's when the task before it is done, a
start held for room) start one agent: the other is refused as *already
starting*, and a start held for room is dropped once the task started another
way. A task whose worker still runs (waiting for your answer, say) is not
started again: stop it first. Should two agents of one role ever run on a
task, wherdr keeps the one it tracks, ends the other and says so in the log.

A message from the coordinator (`wherdr pm tell <task>`) goes to the agent
that holds the task's current step; at a step held by nobody (the PR, the
merge, a step you end) it goes to the worker, started again if it was ended.
The coordinator can pick one with `--to worker` or `--to reviewer`, and its
answer says which agent got the message.

In a wake, the coordinator may tell an agent something only to answer its
question, or, with the autopilot on, to unblock a mechanical block of a task of
its project: `wherdr pm tell <task> "<what to do>" --fix <kind> --reason "<one
sentence>"`, where the kind is `base` (merge the base and solve a conflict),
`ci` (fix a red CI), `machine` (retry after a disk or memory problem) or
`stall` (restart a stalled agent). At any step, a worker that was let go or
ended (on its own or by a stop) starts again with the message, as long as the
task still has its worktree; at the review step, a reviewer that is not
running starts the review again (the message goes to the task's log, the new
reviewer reads its review file); a stopped or finished task is never fixed. Each fix is written to the task's log with its reason, at most
twice per task and step; after that the block is yours, and the coordinator
tells you. Each wake's text lists these fixes. A permission request, a merge,
an approval, guards, settings and limits stay yours.

A step whose action failed (a push refused, a PR not opened) and that the
coordinator, or you, hand to the worker with `--fix` leaves *Your turn* and
**Tasks to review** while the worker fixes it: the card says *the agent is
fixing it*, with no **Try again** in the middle of the fix, and the
message asks the worker to say when it is done. A failed action
wherdr hands the worker on its own (a catch-up, a CI fix) works the same way.
Once the worker says it is done (or pushes, for wherdr's own hand-off), wherdr
tries the action again itself. If that fails again, or the worker stops for 3
minutes, or ends, without saying it is done, the task is back in **Tasks to
handle** with the new reason. The Log says each of these.

A machine's cap of agents (Settings › Machines) counts only the agents working
on a step: not those of a task that waits for you, and not the coordinators.
Its free-memory threshold still holds automatic starts.
