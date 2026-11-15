wherdr 3 runs on [herdr-core](https://github.com/herdrdev/herdr-core) (`hc`) instead of Herdr, and adds built-in project management: you talk to a project's coordinator, agents carry its tasks through your workflow on a board, and Alfred, wherdr's assistant, helps you set it up. It installs from the `v3` branch **beside** wherdr v2, imports v2's machines and settings, and leaves v2 untouched, so you can compare both and go back at any time.

## New

**Projects, board and tasks.** Turn project management on, add a project from a repository on any machine, and its tasks go through the steps of its workflow on a board, done by agents. Guards set the protected branches and whether a merge waits for you or is done by wherdr. The task sheet shows a short TL;DR to decide, the time per step, the waits for you, review rounds and CI fixes, with the task's description, plan and log. A task whose declared files overlap a started task's waits for it to finish, unless you start it anyway. [Project management](https://github.com/afloury/wherdr/blob/v3.0.0/docs/project-management.md)

**New project in one sheet.** *New › Project* picks a machine, then a repository there (or any folder); the coordinator starts at once and its first message looks at the repository and proposes a workflow, saying why. There is no template step: you accept or refuse the proposal, and the Workflow tab shows each task type as a diagram. [Getting started](https://github.com/afloury/wherdr/blob/v3.0.0/docs/project-management.md#getting-started)

**A coordinator per project.** You talk to the project's coordinator: it adds tasks and follows them on the board. It is named after its project (rename it in the project's General tab), and its row menu opens the board, project settings and autopilot, and renames, mutes, restarts with another agent or stops it. It keeps its own memory of your decisions across restarts and changes of agent. Its autopilot keeps the board busy within its limits and hours, with a timeline of the day, and Pace decides when automatic work may start against your Claude and Codex quotas. [Coordinators](https://github.com/afloury/wherdr/blob/v3.0.0/docs/home.md#coordinators)

**Coordinators on other projects.** In a project's General tab, let its coordinator **Read** other projects (list, show, plans, incidents) or **Act** on them (add, start, stop and edit tasks). Guards, merges, approvals and settings stay with each project's own coordinator and you. [Coordinators on other projects](https://github.com/afloury/wherdr/blob/v3.0.0/docs/project-management.md#coordinators-on-other-projects)

**Tasks to review.** A card on the home screen counts what waits for you, filtered by project or tab group. A tap opens it one task at a time: *Approve*, or *Reject* with a note and the wrong screenshots marked (add your own), then the next one slides in. An agent's question shows a short summary and its choices as buttons, or your own answer. *Open the agent* reaches the task's agent from there and from the task sheet. [Tasks to review](https://github.com/afloury/wherdr/blob/v3.0.0/docs/project-management.md#tasks-to-review)

**Accept at any time.** Approving no longer waits for a clean PR: *Accept* shows as soon as the review passed, whatever the PR's state (in conflict, behind, checks red). The task leaves *Your turn* at once, and the engine merges it in the merge queue's order, bringing the base in, having the worker solve conflicts and fixing red CI first. [A task waiting for you](https://github.com/afloury/wherdr/blob/v3.0.0/docs/project-management.md#a-task-waiting-for-you)

**Notes.** Alfred and the coordinators keep a short read-only whiteboard for you: reminders, checklists and task badges, by home tab, with links to Markdown files (plans) that open rendered in the same panel. The note button opens it beside the conversation on a computer, in a sheet on the phone. [Notes](https://github.com/afloury/wherdr/blob/v3.0.0/docs/home.md#notes)

**wherdr handles the routine blocks.** A merge queue merges ready PRs one after the other. A PR in conflict or behind its base, red CI from an infrastructure error, a push refused because the branch is behind, and a stalled agent are handled by wherdr, or handed to the task's agent, before the coordinator is woken up. Work cut by a restart or a crash resumes by itself. [What wherdr fixes on its own](https://github.com/afloury/wherdr/blob/v3.0.0/docs/project-management.md#what-wherdr-fixes-on-its-own)

**A sturdier engine.** One slow merge or failing task no longer holds the others: step actions run apart from the engine's pass, with time limits, and a sentinel restarts or reports any task left without an owner or a reason. A simulation test drives the real engine through four tasks from to-do to done, with fake agents and a fake GitHub, so stalls show up before a release. Step timeouts pause while a machine is offline, and a start on an unreachable machine is tried again.

**Alfred.** wherdr's assistant guides the first setup, brings your v2 projects over, and changes settings only after your yes. When you click *Apply* or *Cancel* on one of its cards (or a coordinator's), it is told and goes on by itself. [Alfred](https://github.com/afloury/wherdr/blob/v3.0.0/docs/home.md#alfred)

**Machines.** Each task goes to a machine its project allows, by memory, cores and load; a project's machines view shows where the next task goes and why. Keep a machine awake from wherdr, set the hours it takes automatic work, or pause it for one project. A project shows on the home tabs of its machines. [Machines](https://github.com/afloury/wherdr/blob/v3.0.0/docs/machines.md)

**Quotas.** Claude and Codex quotas per account, and one Codex account used on several machines now shows as one row. [Quotas](https://github.com/afloury/wherdr/blob/v3.0.0/docs/quotas.md)

**Agents show instead of tell.** Agents ask a choice with buttons (a single choice is a one-click confirm) and show a task as a live card; Alfred and coordinators also highlight a setting and show status cards, and propose a setting change, a workflow or an automation as a card you apply.

**Conversations.** On-device dictation, and a neural read-aloud voice that runs on the phone. Devin conversations open on their transcript. SVG diagrams show as a safe preview. Conversations are lighter and faster, also with many agents: wherdr reads only what a transcript added and keeps the last read on the device.

**Phone.** The task sheet keeps its action bar flush at the bottom and the typed text above the keyboard, long titles are clamped, and sheets no longer hide their last lines.

**Updates.** When a new version is out, a home banner offers **What's new** (the release notes) and **Update with Alfred**, which follows the [update guide for agents](https://github.com/afloury/wherdr/blob/v3.0.0/docs/update-with-an-agent.md): plan, your yes, backup, update, health check, rollback on failure. Each release may carry *Upgrade notes* with the manual steps it needs.

## Update

wherdr 3 is a new install, not an in-place update of v2. What changes, what v2 alone keeps, and how to move are below.

### Changed

- herdr-core (`hc`) replaces Herdr, and other machines are hc machines reached over SSH.
- wherdr installs from source (the `v3` branch) and runs as a user service. v3 is a GitHub release only: no npm or Homebrew package.
- Beside v2, it has its own port, data folder, service and address.
- To update, use the banner's *Update with Alfred*, or pull and rebuild; a small machine can instead receive builds made on another machine of your tailnet.

### Gone (v2 only)

- Herdr sessions, the Herdr plugin and its actions, and the relay of Herdr notifications.
- The herdr-projects board: v3 has its own projects and board.
- The npm and Homebrew packages, the curl installer, Docker and the one-tap update.
- Worktree management and the Changes view.
- The model and effort pickers and the slash-command list.
- Split panes: with hc, every terminal of a space is a tab; split and move stay in herdr-app.

### How to move

The easiest way: give the *v3 beside an existing v2* prompt of [Install with an agent](https://github.com/afloury/wherdr/blob/v3.0.0/docs/install-with-an-agent.md) to a coding agent on the machine that runs v2. To do it by hand, follow [Migrate from v2](https://github.com/afloury/wherdr/blob/v3.0.0/docs/migrate-from-v2.md). Its installer script prints its plan first and imports v2's SSH machines and synced settings. Alfred then offers your v2 projects in **one card**: *Apply* adds the checked ones and starts their coordinators, each of which proposes a workflow. Passkeys and push notifications are added again in v3.

### Known limitations

- The install script needs Linux with `systemd --user`; on macOS, install by hand.
- The build needs about 1.5 GB of memory.
- hc is not installed for you: install it first.
- Workspaces (one coordinator for several repositories) are not part of 3.0: they come in 3.1.

[Full changelog](https://github.com/afloury/wherdr/blob/v3.0.0/CHANGELOG.md)

Join us on Discord: https://discord.gg/ky36WYmtVE
