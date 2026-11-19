wherdr 3.2 opens **plugins** to the community: a *Community plugins* switch, off by default, and plugins installed from GitHub at an exact commit. **omp** joins as a task agent and coordinator, **Antigravity CLI** and **Hermes Agent** conversations open on their transcript, and workspaces gain read-only context folders, shared skills and plan files ticked as tasks finish. It also ships everything prepared for 3.1.1, which was never released: workspace member settings, a workspace from New › Project, a command on task state changes, questions cards, and fixes to photo messages, message states, keep awake and Devin conversations. This release also carries security and reliability fixes from three bug hunts, Tasks to review in place of the Decisions page, and updates that roll back on their own. Update as usual: the banner's *Update with Alfred*, or `update.sh 3.2.0` in the install folder; no manual step is needed.

## New

**Community plugins.** No plugin loads until *Settings › Plugins › Community plugins* is on, and it is off by default. Plugins run inside wherdr with **full access**: they can read your conversations, write to your agents and run commands on your machines. There is no sandbox and no permission system in 3.2, so turning the switch on first shows that warning; only turn it on for plugins you trust. The switch holds for every device, and turning it off stops running plugins everywhere. An install that already had plugins keeps them on. [Plugins](https://github.com/afloury/wherdr/blob/v3.2.0/docs/plugins.md#community-plugins-switch)

**Plugins from GitHub.** *Install from GitHub* takes `owner/repo` (optionally `@tag`, `@branch` or `@commit`) and shows the plugin's name, version and exact commit with the full-access warning before anything is written. *Check for update* shows the new commit and installs only when you press *Update*, and *Remove* deletes a plugin. [Install from GitHub](https://github.com/afloury/wherdr/blob/v3.2.0/docs/plugins.md#install-from-github)

**omp as an agent.** A task's worker and reviewer may run on omp, and a project's or workspace's coordinator may too, as an option that is never the default. Thanks to [@SunnySydeUp](https://github.com/SunnySydeUp). [Projects](https://github.com/afloury/wherdr/blob/v3.2.0/docs/project-management.md#worker-and-reviewer-agents)

**Antigravity CLI conversations.** An `agy` terminal shows its name, icon and live state, its conversation opens on the saved transcript (locally or on another machine, with Node 22.13 or later), and its + menu offers its commands. Thanks to [@followcat](https://github.com/followcat).

**Workspace context, skills and plans.** A member's task can read other members' code through read-only context folders. Skills in the workspace root's `.claude/skills` reach every member task's agents. A feature can name a spec's `tasks.md`, and wherdr ticks its lines as the sub-tasks finish. Thanks to [@SunnySydeUp](https://github.com/SunnySydeUp) for context folders and plan files. [Workspaces](https://github.com/afloury/wherdr/blob/v3.2.0/docs/workspaces.md#context-folders)

**A command when a task changes state.** *On state change* in a project's General tab runs a shell command on the project's home machine when a task starts, waits for you, is done or fails, for example to sync a tracker. The task's facts come as `WHERDR_TASK_*` environment variables, and a workspace shares the command with its members. [Project management](https://github.com/afloury/wherdr/blob/v3.2.0/docs/project-management.md#general)

**Commit message template.** *Commit message* (`{tag}: {title}`…) sets the title of squash merges and of `git.land`'s merge commit, shared by a workspace like the branch name.

**Several questions in one card.** An agent can ask up to 8 questions in one card, and one *Send* answers them all in one message, in the chat and in Tasks to review.

**Waiting on another task.** A worker that reports *blocked on* a task or a repository parks without stalling and continues in the same conversation once that is done; a cycle comes to you as a decision. A coordinator can also pause a task until its machine has room, and the engine resumes it.

**A workspace from New › Project.** A *Project | Workspace* switch creates either one, with a *Browse* button beside each machine's root folder. A workspace root may itself be a git repository, adopted as a member with `repo adopt .`. [Workspaces](https://github.com/afloury/wherdr/blob/v3.2.0/docs/workspaces.md)

**Themes from Alfred.** Ask Alfred for a theme and it proposes one as a card with a preview and a contrast check. The theme editor previews a small version of the whole app and gets a *JSON* tab.

**Hermes Agent conversations.** A `hermes` terminal shows its name and icon, and its conversation opens read-only on the session the pane shows, locally or on another machine. It is built from Hermes' source and not yet tested with a real Hermes: feedback is welcome on [#48](https://github.com/afloury/wherdr/issues/48).

## Improved

**Tasks to review replaces the Decisions page.** The board's *To review* button and old `#/decisions` links open Tasks to review, where every decision waiting for you already is.

**Updates roll back on their own.** If the new build does not answer with its version, or its restart fails, `update.sh` puts the previous build back, restarts and says so. A checkout of your own, and every macOS install, builds with `npm run build:aside`, which leaves the running build whole if the build fails. [Installation](https://github.com/afloury/wherdr/blob/v3.2.0/docs/installation.md)

**Workspace members.** Each shared setting of a member says *From <workspace>* or *Own value · Use <workspace>'s*, and is overridden or reset one field at a time. The workspace's working branch, branch name, placement and archive settings now reach its members, and a member with its own workflow can follow the workspace's again. In the sidebar, each member shows its own counts, and *n waiting for you* opens the waiting task.

**Settings › Projects.** *Add project*, *Add workspace* and *Open the board* sit above the list, with a tab filter, a search, and members folded under their workspace. The template library is gone from the interface: coordinators and Alfred write workflows, and saved templates stay on disk.

**Everyday use.** Every send button of Tasks to review, and keep awake, shows a loader until the server answers. A refused action offers *Try again* with the reason for herdr-core or network failures. A relative file path in a chat opens the right file. A stale *Limit reached* quota shows as unknown and no longer blocks pacing. The file browser also protects agents' credentials and `~/.config/gh`. A coordinator's header menu offers *Open the board*, its settings and *Autopilot*.

**Windows host (experimental).** wherdr starts on Windows and keeps the inherited PATH ([#870](https://github.com/afloury/wherdr/issues/870)). [On Windows](https://github.com/afloury/wherdr/blob/v3.2.0/docs/installation.md#on-windows-experimental)

## Fixed

**Security fixes.** Alfred and coordinators now apply a change only in a turn that comes from your own message, and updating a plugin never turns *Community plugins* on without its full-access warning. An unreadable settings file is never taken as empty, so nothing is switched on or overwritten by mistake. Updating to 3.2.0 is recommended.

**Worktrees and the engine.** A done task's worktree is now removed after a squash merge, big ones included, freeing disk space. Starts that herdr-core never confirmed no longer stay *starting*, parked tasks no longer hold autopilot slots, one project's failing starts no longer stop the others, and removing a project with open tasks is refused.

**Messages.** Held Codex messages survive a restart and are never typed twice. Enter that confirms an input method candidate (on Safari too) never sends the message.

**Photo messages to Claude.** A photo reaches Claude as an image, is never left stuck in Claude's field, and a multi-line message with a photo is submitted within about 20 s with your text kept in its bubble.

**Message states.** A message reads *Sending…* until it is in the transcript, never *Read by the agent* before, and *Not sent* only once the server gave up. A message sent at the same moment as a wake keeps its own bubble, and a running '!' command keeps its place in time.

**Devin conversations.** A Devin started without `-r` shows its conversation, and an idle Devin no longer opens the interactive terminal over it. Thanks to [@followcat](https://github.com/followcat) for both fixes.

**Keep awake** works again on a remote Mac, and a failed read says *Could not reach <machine>* with the reason.

**Tasks.** Workspace members inherit the workspace's worktree setup and machines, and a machine's status card shows its RAM instead of *0.0 GB*. `feature split < plan.json` reaches the server from a coordinator's folder. A review round adds to the task's report instead of replacing it, a coordinator's first messages survive a restart, and a failed migration never stops the board.

[Full changelog](https://github.com/afloury/wherdr/blob/v3.2.0/CHANGELOG.md)

Join us on Discord: https://discord.gg/ky36WYmtVE
