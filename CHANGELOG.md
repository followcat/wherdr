# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added and improved

- **One-shot terminal modifiers.** Ctrl, Alt and Shift can be armed for the next key-bar or phone-keyboard key. Existing shortcuts and digit buttons remain available; pastes and composed text stay text.
- **Optional individual-agent list.** Settings › Appearance can show standalone agents as separate rows, while workspace cards remain the default and Board task helpers stay grouped.
- **Release distance in update notices.** The banner shows how many newer stable releases are available and a short version list, preserving the installation-specific update action.

## [2.3.0] — 2026-10-28

### Added and improved

- **Worktrees grouped by machine and project (#208).** Settings › Agents organizes worktrees into collapsible machine and project sections.

- **Project headers without a coordinator (#205).** Projects keep a lightweight header even when they have no coordinator.

- **Updated README animation (#206).** The introductory WebP animation shows the current interface.

- **Notification state in row menus (#210).** Right-click or long-press a row to see Mute notifications or Unmute notifications; rows no longer show a muted bell, and card menus list the notification action only once.

- **Project key on the coordinator header (#209).** The project's key appears on the coordinator header's accent square, with the logo kept when no key is known.

### Fixed

- **npm publishes after the GitHub release (#207).** `release.yml` now starts `npm.yml` once the release and its package are public, instead of both starting on the tag and npm failing with "release not found". A version already on npm is not published again.

- **Deterministic TaskSheet menu test (#211).** The model and effort test waits for a closed menu to return focus before opening the next one, avoiding timing-dependent CI failures.

- **New agents keep the typed name (#212).** The Name field labels the new space or the pane in an existing space as typed, including spaces. Thanks to [@SunnySydeUp](https://github.com/SunnySydeUp) for the contribution.

## [2.2.0] — 2026-10-27

### Added and improved

- **Choose one task type (#200).** Work, research and conversation are exclusive choices when creating a task, making the intended kind of work explicit.

- **Request plan approval when creating a task (#202).** Choose whether you or the reviewer approves the plan before the work starts, or keep the inherited setting.

- **Conversations preload on agent card intent (#201).** Hovering over or showing intent to open an agent card preloads the conversation tail so its latest messages are ready sooner.

### Fixed

- **Dictated text survives pasting into the message field (#198).** Capture clipboard text synchronously to prevent Spokely dictation from being lost during paste, preserving paragraph and line boundaries in the HTML fallback. An optional Paste journal in Settings › Advanced records diagnostic events without recording text content.

## [2.1.0] — 2026-10-26

### Added and improved

- **Edit a task description from its task panel (#186).** Save the updated description without leaving the Board; errors keep your text available to retry.

- **Archive completed repository tasks together (#188).** The repository menu offers bulk archiving with confirmation, keeping active tasks on the Board.

- **Board and task panels fit narrow screens (#187).** Columns and overlay panels adapt to the available width, keeping task controls accessible.

- **Working tasks say what they are doing (#154).** On the Board card, the home list row and the task panel header, a task whose agent has finished and that waits for GitHub checks shows a **CI 1/2** badge with its agent logo dimmed and no progress; a task waiting behind another task or for a free slot shows **QUEUED · DEMO-3** / **QUEUED · Q#2**, dimmed, with no progress. A task with an agent at work looks as before.

- **A task opens at once from the sidebar.** Tapping a task's conversation in the sidebar opens the Board and the task's panel right away; while its details load, the panel shows the shapes of its header, tabs and conversation after 300 ms (none for a quick read). The open task is selected both in the sidebar and on the Board (its card gets the sidebar's accent, on phones too, and scrolls into view), and opening a task moves the sidebar's machine tab and the Board's machine filter to the machine that has it when they do not show it already.

- **Faster Board and conversation opening (#178).** Show the device's cached Board and conversations while refreshing, render the last 30 conversation blocks first, and defer Markdown until needed. Empty loads show static skeletons after 300 ms; a slow Board offers Retry. Cache writes are grouped per conversation (trimmed only when written; two tabs of the app, such as the installed app and a browser tab, keep one index of the conversations kept, so none is left unbounded), focus rings use compositor transforms, and build assets and large API responses are compressed. The first Board read waits for tasks instead of returning an empty list while repository keys load.

- **Task limit gauges and one-tap raises (#155).** The Task tab shows each limit as a thin gauge, **Time · this run 2 min 38 / 2 h** and **Tokens 3.4 M / 30 M**, red from 90 %; a limit not set says **No limit**, and the whole task's tokens stay shown when they differ from what the limit counts. At a limit stop, the hint names what **Continue** grants once more (`2 h a run`), and **Raise limit** (#167) offers presets above the typed value: +1 h / ×2 / none for time, ×2 / +10 M / none for tokens. Each preset runs the same `set` as a typed value; a preset not above what was already used is disabled, since herdr-projects would not resume. Durations and token counts read the same everywhere (`2 h`, `45 min`, `3.4 M`, `500 k`).

### Fixed

- **Autopilot wake messages are recognizable (#189).** Automatic coordinator wakes appear as distinct notes in the conversation instead of looking like messages you typed.

- **Unreachable Board machines explain the failure (#185).** The selected machine heading shows its reachability error instead of leaving an unexplained empty Board.

- **Long queued-task badges stay inside the row on mobile (#154).** On Board cards and home list rows a long reference ends in an ellipsis and the task title keeps room to read; in the task panel the badge moves to its own line under the title. The full reference stays in the badge’s hint.

- **New coordinator works on a Git folder the board does not know yet (WHR-134).** Choosing **Other repository…** and a folder now says at once where it stands: **On the board** with its project name, **New project** with the name it will get (`team-hub`, `team-hub-2` when taken), or a short error when the folder does not exist or is not a Git repository. **Add and open conversation** adds the repository to that machine's board first, remote machines included, so the first message starts its coordinator instead of failing with “No repo … on this machine”. herdr-projects 1.2.26 has no command that only adds a repository, so wherdr adds a trigger-only automation for that folder (`automations add --repo <folder> --when merged`) and removes it at once: no task is made, so no “added” automation fires and the repository's first task keeps number 1. A coordinator is always named by its repository's name on the board, never by its folder.

## [2.0.1] — 2026-10-26

### Added and improved

- **Provider quotas have a distinct name (#180).** Cards, compact rows, project summaries, chat status and Claude quota setup now use “Quota” in English and French. “Limit” / “Limite” remains reserved for task time and token ceilings; computations, actions and settings are unchanged.

- **The Board's machine selector follows the sidebar tab (#181, restoring #171).** Opening the Board, or changing the sidebar tab, sets the selector to that tab's machine, group or All machines. A scope chosen by hand stays through refreshes, page reloads and visits to the Board until another sidebar tab is chosen. With no tab, or no Board machine in it, the current scope is kept. Taken out of 2.0.0 because a page reload dropped the choice made by hand; it is now kept on the device with its tab.

### Documentation

- Documentation: prerequisites for Windows remote machines (#182, documenting #132). [docs/machines.md](docs/machines.md#windows-remote-machines) says to set Git Bash as the OpenSSH server's default shell, and the error shown when the remote shell is `cmd.exe` now names that section.

## [2.0.0] — 2026-10-25

This major release follows 1.3.4. Read the [migration guide](docs/herdr-projects-1x.md)
(#152) before upgrading; Docker installs also need the [native migration guide](docs/migrate-from-1.x-docker.md).

### Added and improved

- **Notification defaults and exceptions (#157).** Choose one default notification level and exceptions for coordinators or standalone agents. A separate Sub-agents switch controls task workers, reviewers and attempts. Do not disturb silences every notification; device permission is shown separately.

- **Task settings and provenance (#163).** The task panel’s Settings tab reads effective values and their sources from the task’s machine, including CLI notes and problems, without editing them or rereading on each Board refresh.

- **Start with… a model and an effort (#165).** On the Board, after the program, Start offers the models and effort levels herdr-projects takes for it on that machine (`herdr-projects models <program>`, read once per machine and program), for this start only (`--worker.agent <program>/<model>`, `--worker.effort`). None is picked by default: the program alone, as before. A name the CLI refuses shows its own words; when the models cannot be read, Start uses the program alone and says so.

- **Moving from a 1.x Docker install** has its own guide, [docs/migrate-from-1.x-docker.md](docs/migrate-from-1.x-docker.md), written so an AI agent can run it: back up, stop the container, install the native service, check each step, and go back if needed. The installer, the plugin and the 2.0.0 release notes link to it.

- **Install herdr-projects** now installs 1.2.21, the release wherdr was tested with, instead of 1.2.1 (which had no autopilot, chat-only tasks or settings page). A machine with an older 1.x shows **Update available** in Settings › Plugins, with what the update adds in one line, and **Update to 1.2.21** replaces Herdr's copy of the plugin; tasks and settings stay. wherdr still reads 1.2.1 and later.

- Task logos consistently identify the worker on Home, Board cards and conversation headers. Reviews show a separate reviewer mark and explain whose conversation is open, with access to the reviewer terminal or session. Worker fallbacks show the current agent and who it took over from.

- Switching machine or group tabs restores the last conversation for that selection on the device, with a coordinator fallback, while preserving unsent drafts. All and conversations already in the selection stay open.

- **Coordinators have the names herdr-projects gives them**, the same on the Board, the home list, the conversation header and the menus: **Coordinator**, **`<machine>` coordinator** and **`<repo>` coordinator** (FR **Coordinateur**, **Coordinateur · `<machine>`**, **Coordinateur · `<dépôt>`**). The machine coordinator is no longer called "setup" / "Configuration": it is an agent for the machine as a whole.

- **A failed review can be sent back to the agent** from the task's banner (`herdr-projects review`), its findings listed briefly; **Approve anyway** becomes the second choice. A reply sent while the reviewer waits now says it went to the reviewer.

- **A machine's tab on the home list** no longer repeats its header: its Claude and Codex quotas sit together at the top, an offline machine says so there, and a right click or long press on the tab offers the machine's actions. A group's tab offers **Group settings**.

- **Restart to update (#164)** no longer opens the interactive terminal for a moment while the agent exits: the conversation stays as it is, with only the restart progress above the message field.

- **Task limits** offer explicit controls to continue or raise the reached token or duration limit, and confirm resumption before closing (#167).

- **Remote coordinator links** switch the home machine bar to the coordinator’s machine (#169).

- **Task keys** can be copied with a click or tap (#168).

- **Coordinator Autopilot switch (#174).** The Board and each coordinator's panel (main, machine, project) show whether Autopilot is on, with its next wake. Turning it on asks for the goal (prefilled with the saved one) and optional frequency and limits; turning it off asks for confirmation. The state is always read back from herdr-projects (1.2.15 or later), and a board refusal is shown in its own words.

- **Scheduled section in the coordinator panel (#173).** Each coordinator shows, read-only, its Autopilot wakes, its automations with the tasks they recently started, and its Claude timers.

- **Board settings screen (#175).** A gear on the Board, a right click on a machine tab or a project header opens the settings of herdr-projects on that machine: the board itself, your defaults and each repo, with each value’s source and a reset to the inherited value. Choices come from herdr-projects (agents, models, efforts); refused values show its own message, and settings with an immediate effect ask for confirmation.

- **Hand-overs in task details (#176).** When a stand-in agent takes over a task or its review (provider down, out of allowance, failed rounds), the task details list each hand-over in order, with roles, agents, reasons and times.

- **Scheduled prompts are notes, not stuck messages (#170).** A prompt that Claude Code injects itself (a scheduled task, a background task notification) shows where it ran as a folded “Scheduled task” note, and never as a “Queued · sending…” bubble left under the conversation; messages you typed stay in the queue.

- **New agent and slash menu:** New opens an existing project coordinator or creates one; the slash menu includes plugin skills and MCP prompts (#130, #122).
- **Messages waiting behind other text** explain why they cannot be sent and offer to clear the field (#131).
- **Installation and documentation:** the README links to focused guides in `docs/`. Automatic startup is at login on macOS; on Linux it is at boot with lingering enabled, otherwise at login. The installer checks and reports the actual state (#136, #137).

- **A remote machine no longer stays stuck after an SSH reconnection.** An old SSH master connection exiting late (stopped slowly, or left behind across a wherdr restart) could delete the control socket of the new one: the machine still looked online, but every terminal, file read and conversation refresh failed ("SSH session refused" in a loop in the log) until wherdr was restarted again. Each connection now has its own control socket, masters left by a previous wherdr are stopped at startup, and when sessions are refused wherdr checks the connection and reopens it by itself (at once if the control socket is gone, after three refusals in a row otherwise, waiting longer each time). Meanwhile the machine shows **reconnecting…** instead of a terminal loading in a loop.

- **Normal home list by default (2.0)**: Settings › Appearance › Home screen › Compact list is now off on a new install, so the list shows two lines per task with its current activity and useful labels. A compact list turned on in 1.x goes back to normal once, on the first 2.0 load (whether the value is still in the browser or already on the server); turning it on again is kept and follows you on every device.
- **The “Needs you” banner fits on one line and answers in one tap.** A task waiting for you now shows its kind of wait (■ QUESTION, PERMISSION or SIGN-IN) and its message on one line, unfolded with its chevron; **See ↓** scrolls the conversation to the agent's message that asks and lights it up. Its buttons follow the kind: a question offers the answers the agent wrote (`(keep / drop)`, `1) … 2) …`) as buttons, otherwise **Reply…**, which goes to the message field; a permission offers **Allow** and **Refuse** (and **Always allow** when the agent offers it); only a sign-in keeps **Open terminal**. Links are clickable and short (`PR #484`). On the Board, a task's message also fits on one line after its kind, and its pull request is a link beside the title. English and French.
- **Settings follow you from one device to another.** The theme, the machine bar (shown or not, order, hidden items), machine groups, Compact / Normal, Group by, the machines and projects folded on the home screen, the other home list options, the typewriter and reply style, the default pane view, the Board's grouping, folds and Done, and the file browser's choices are now kept on the server, in one file of its data folder (`settings.json`, written atomically, behind the same protection as the rest of the app). A change made on one device shows on the others at once, without reloading; when two devices change settings at the same time, the last change wins, setting by setting. On the first load after the update, each device merges its values into the server's: the server takes the settings it does not have yet (machine groups built only on the iPad, for example) and keeps the ones it has; from then on the server is the reference. A change made offline, or just before a reload, is sent on the next connection. What depends on the device stays in the browser: content width, sidebar width, terminal font size and rendering, quoted replies mode, language, the last tab, filter or column shown, drafts and message history, notifications, passkey and session. Settings now says which choices follow you and which stay on this device.
- **iPad, second pass:** opening the on-screen keyboard no longer changes the layout. An iPad mini in portrait used to switch to the phone layout, and in landscape the buttons shrank, because a touch tablet was detected by its window, which the keyboard shortens. It is now detected by its screen. With the keyboard open, a side-by-side tab fits the visible area, so the active pane's message field stays above the keyboard; windows such as New agent and the interactive terminal are centred in that area too. Side-by-side panes are easier to use with a finger: 44 px pane buttons, view selector, grip and tab chips, and dividers with a 24 px touch area and a visible notch. The active terminal pane now shows the terminal key bar (Esc, arrows, ^C…) on a touch screen, starting from the left so every key stays reachable in a narrow pane. Phones and computers are unchanged.
- **State grouping keeps every machine in reach.** In State mode, online machines sit in a compact row of chips above the groups; each chip opens that machine's menu (sessions, keep awake, board, plugin actions, Claude quota setup) and shows its keep-awake time and a Claude quota setup marker. Machine-specific quotas follow under the row, and offline or reconnecting machines stay on one line at the bottom with their state and last known agent count.

- **Group the home list by state across online machines.** Settings › Appearance › Home screen › Group by offers Machine (the default) and State. State mode keeps machine and project badges, task details, compact/normal density and machine-bar group filters. Part of #46; offline machines and per-machine controls follow separately.

- **Herdr 0.9.2+ machine diagnostics and terminal mouse:** a remote machine's Options menu checks native reachability and offers the interactive reconnect command plus a wherdr connection retry. Terminal clicks, taps and drags use structured mouse events; Shift + drag selects text. Older Herdr retains legacy input and SSH retries.

- Task sheets offer **Ask the coordinator** before starting work, and in other active states. Questions name the task and go to its project coordinator on its owning machine; the coordinator chat opens after sending. Asking never delegates or changes the task. The separate Chat action still opens the task’s agent. Available in English and French.

- **A message lost during a turn is shown as not sent, with Retry.** A message sent to Claude while it works, then pulled back out of its queue before Claude read it (↑ in its terminal, then erased), stayed “Queued” until the end of the turn, however long. It is now marked **Not sent — it was taken out of the agent’s queue before being read** a minute later, during the turn, with **Retry** (sent when the turn ends) and **Cancel**. A message that never shows in the conversation no longer disappears silently after an hour: it is marked **Not sent — still not in the conversation after an hour**, with the same buttons, unless Claude still has it in its queue. Messages marked not sent are kept for a day, across restarts.
- **A free answer to a Claude question can end with a backslash.** In the “Type something.” field of Claude's question box, Enter right after a backslash starts a new line instead of submitting: an answer like `C:\temp\` was left in the field while wherdr reported it sent. Such an answer is now submitted exactly as typed (the cursor is moved to the line start before Enter), and an answer Claude still holds after Enter is reported as not submitted. A field left on several lines is emptied line by line before typing.
- **Readable GitHub release notes**: stable releases now require a reviewed summary under New / Improved / Fixed / Update and a link to the tagged changelog. The workflow refuses link-only notes before attaching the package and again before publishing; the release checklist includes an example and a local validation command. Rolling v2 prereleases summarize current Unreleased entries and link to the changelog at the packaged commit.

- **A conversation rewritten at the same size or shorter reloads from the bottom.** The incremental re-read of a long conversation could keep showing the old messages when the transcript file was rewritten without growing (same size, or shorter but still past the reading position). The server now tells file states apart by modification time and inode, and sends a fresh bottom that the app starts again from when the file was replaced, shortened, rewritten at the same size, or when the bytes just above the reading position changed. A remote machine's file times now include fractions of a second; where they have whole seconds only, a conversation is only reported unchanged once the second of its last write is over, and a checksum of the file tells whether a list read during that second is still there.
- **A Markdown file is shown formatted in the file explorer.** A `.md` or `.markdown` file opens as a document (headings, lists and task lists, tables that scroll sideways, code blocks with light syntax colours and Copy, links, images written with a relative path, read from the folder), through the conversation's renderer and its sanitising: the file's own HTML cannot restyle the app or run anything. **Rendered / Source** switches to the raw text with line numbers, and the choice follows you across devices. A relative link to another file opens it in the explorer (with its anchor, and its folder in the breadcrumb); a link leading out of the folder is refused. Download, Refresh and the 256 kB limit are unchanged.
- **A menu left open in the agent's terminal is shown in the conversation.** A message sent while Claude's `/status` (or another menu or panel no card shows) covers its input field only said “will be sent when the turn ends”, then “not sent” once the turn was over. The conversation now says the menu is still open, with **Close menu** (a single Escape, only while the field is still hidden, so a turn is never interrupted) and **Send anyway** (closes it and types the waiting messages at once, even during the turn).
- **A task's sheet says Queue, and can start after other tasks.** When every slot of the task's board is taken (`board.agents` tasks at work), **Start** says **Queue**, with the place the task would get (“3rd in the queue · all 2 slots are taken”); it still runs `delegate`, which queues it. **Start after…** picks the tasks to wait for, found by key, id or title on every machine the Board reads (another machine's as `machine:KEY-12`, or typed), and runs `delegate --after`. A task that waits says for which tasks (done ones marked), with **Stop waiting** (`after --clear`); one in the queue says its place. herdr-projects' refusals (a wait in a circle, an unknown task, a machine that does not answer) are shown as it words them, in French too.
- **A task's banner shows where it stands now, and offers Finish.** herdr-projects keeps an old failure on a task after it moves on: a review that failed the day before stayed the banner of a task now stopped at its limit, and a pull request error stayed after the agent had fixed it and asked something new. A failure older than the task's last stage change or agent restart is no longer the banner and gets no buttons (no **Send the error to the agent**); the Task tab keeps it as an *Earlier failure*. **Finish** (`herdr-projects finish`, after a confirmation) takes the work as it is, then runs its checks and review: offered when the agent stopped at a limit (Retry gives it the same limit again) or without a summary, and when its agent is at rest while the row stays on “Finishing”. One line under the banner says what Retry and Finish each do.
- **Claude quota setup moves to Settings › Agents and the setup guide.** Fixes “Claude quotas not set up” shown under machines whose Claude quotas were displayed (a regression of the atomic snapshots above: an older status line was reported as not installed; it is now *Update available*). The home list no longer shows an install banner: a machine's **…** menu offers **Set up Claude quotas** (or **Update**) and **Don’t suggest again**. Settings › Agents › **Claude quotas** lists each machine with Claude, its state, **Install** / **Update** and **Copy command**. The setup guide adds an optional **Quotas** step when a machine needs it; leaving it without installing stops the suggestion on every device (`data/claude-quotas.json`).
- **Send acts on the touch itself on a phone**: on an iPhone with the keyboard open, a tap on Send could do nothing until the keyboard was closed. The likely cause is a tap that drifts slightly while the keyboard makes the page pannable: it becomes a pan and Safari sends no click. The button no longer waits for that click; it sends when the finger lifts on it. The keyboard stays up after sending, and a finger that slides off the button still cancels. Not yet confirmed on a real iPhone.
- **Claude's suggestion on a phone**: the grayed-out reply Claude Code suggests in the empty field gets a **Use** button inside the field, on its right (a 44 px target), since a phone has no Tab key. It fills the field, editable, without sending it, and leaves the keyboard as it was. The former chip above the field was hidden behind the “N questions unanswered” tab. Computers keep Tab.

- **A draft follows its agent when Herdr replaces its pane**: when a pane is closed and a new one opens for the same agent (the same conversation, or the same herdr-projects coordinator or task, as after `coordinator restart`), the open view moves to the new pane and the message being written (text, quotes, pasted texts, attachments) comes along; opening the new pane from the list brings it back too. A pane closed with no successor keeps its draft under the “pane closed” banner, with **Copy draft**.
- **Yes, No and OK to all hand the field the focus on a computer**: after a click, the caret sits right after the answer written in the field, so Enter sends it at once. On a phone the keyboard stays down as before (Enter adds a line there), and a button pressed with the keyboard keeps the focus, to answer the next question.
- **Enter sends in a narrow computer window too**: a window narrow enough for the phone layout no longer turns Enter into a new line when the device has no touch screen (Shift+Enter still adds one).
- **Windows remote machines are reached through a relay (#144, fixes #132).** wherdr no longer passes a Windows socket path (`C:\…`) to `ssh -L`: it uses Herdr's `remote-api-bridge` and `remote-client-bridge` over the same SSH connection (Herdr 0.9.3+). The OpenSSH server must use Git Bash as its default shell; see [docs/machines.md](docs/machines.md#windows-remote-machines).

- Task panels use one compact header and Conversation / Terminal / Task tabs, with structured Needs you explanations and actions, setup failures kept visible, and the Board’s state vocabulary on home rows. The Task tab holds descriptions, closing notes, review findings, limits and actions in English and French.
- Claude quota snapshots bind the account fingerprint and observation time atomically. Update older status lines to remove the ten-minute identity cache. Failed Claude reads are retried once; after two failures, that machine's Claude gauge is temporarily omitted until reading recovers, instead of reusing an old account reading indefinitely. This supersedes the earlier keep-last-reading behavior for Claude; Codex is unchanged.

- Home machine bar: named groups with editable membership and machine order, combined counts, server storage, and reorder/hide controls (English and French).

- **wherdr.dev shows the herdr-projects 1.x Board**: the herdr-projects story and its live demo now show the Board (a task reviewed, approved and moved to Done; the Coordinator turning a message into a task) instead of herdr-projects 0.2's Project panel, threads and TASKS.md.
- Coordinator failure messages distinguish startup and message delivery errors, and report the actual pending message count in English and French.
- **Useful home list densities**: Compact keeps each Board task on one line (agent, key, truncated title, progress, duration and state, with Your turn when needed). Normal adds one activity line with relevant limit or review labels. Large detailed cards are removed; coordinators and other agents stay dense too, while agents outside the Board keep their one-tap answers. Normal is now the default (see above).
The release includes the merged work in #70, #133, #135, #136, #137 and #139.
PRs #153, #154, #155 and #71 are reserved for 2.0.1 and are not included.

### Breaking changes and migration from 1.3.4

- **Shared display settings** now belong to the server (`DATA_DIR/settings.json`), rather than each browser. Each browser imports only keys missing on the server once; existing server choices win. Back up the data directory before upgrading. Screen and hardware preferences, language, drafts and authentication remain local. Compact list resets to Normal once; enable it again in Settings if wanted.
- **Upgrade checklist:** back up wherdr's data and any herdr-projects 0.2 projects first. Follow the [herdr-projects migration guide](docs/herdr-projects-1x.md) before running upstream 1.x; the old Project panel is replaced by the Board. Docker users must [move to the native service](docs/herdr-projects-1x.md#moving-from-docker-to-the-native-service). Native plugin users can update through Herdr, npm users with `npm install -g wherdr@2.0.0 && wherdr restart`, and Homebrew users with `brew upgrade wherdr && brew services restart wherdr`, once 2.0.0 is published. Open each browser once to import its settings, then check Settings and the Board.

### ⚠ Breaking change: native service only (2.0.0)

- Docker support is removed completely: no images, compose files, container modes or read-only Board in 2.0. Run wherdr as your user through the installer or Herdr plugin (`systemd --user` on Linux, LaunchAgent on macOS). Existing plugin settings switch to native on update, with a migration message. Published 1.x images remain on GHCR unchanged for users staying on 1.x; see the [migration guide](docs/herdr-projects-1x.md#moving-from-docker-to-the-native-service) to keep the same port and data.

### ⚠ Breaking change: herdr-projects 1.2.1 or later (2.0.0)

- **herdr-projects 0.2 is no longer read; wherdr now reads herdr-projects 1.2.1 and later.** Upstream herdr-projects 1.x is a different product (one work board of tasks, each handed to an agent, reviewed and merged on your yes), and wherdr now follows it. wherdr 1.3.4 is the last version for herdr-projects 0.2. See [docs/herdr-projects-1x.md](docs/herdr-projects-1x.md) for the move, with a backup and the way back.
  - **New Board**: every machine's herdr-projects tasks, in the board's own five groups (needs you, ready to approve, working, to do, done), side by side on a computer and one at a time on a phone. A task shows its key, title, the line its agent reports, the agent, progress, pull request and review; it opens its description, plan, branch and what went wrong, with **Reply** (to its agent, or a plan sent back), **Approve** (merge, or yes to a plan, after a confirmation) and **Open its agent**. wherdr reads the board only through herdr-projects' command line (`list --json`, `details <id> --json`, `tell`, `approve`, `coordinator tell`), one command at a time per machine and only while the Board is open.
  - **herdr-projects missing, 0.2, or older than 1.2.1**: Settings › Plugins and the Board say “Update herdr-projects to 1.2.1 or later, or downgrade wherdr to 1.3.4”, with the commands; nothing else in wherdr changes, and wherdr never runs herdr-projects there (its first run would take over the older install's files). **Install herdr-projects** installs `eliasstravik/herdr-projects` pinned to v1.2.1.
  - **Removed with herdr-projects 0.2**: the Project panel (TASKS.md lists, threads, inbox, routines, settings, memory), the Board of projects, threads and agents, thread limits per machine, **New project** and the other 0.2 actions, `Mod+Alt+P` and `Mod+Alt+Shift+N`, the grouping of coordinators and threads in the agent list, the herdr-projects folder marks in folder pickers, and the “Notify for: project coordinators” setting (every agent now notifies, as without herdr-projects).
  - **Board actions, as herdr-projects 1.x does them**: a task opens with **Start** (a task of the backlog, `delegate`), **Stop** (its agent, after a confirmation), **Retry** (as herdr-projects 1.2.1's `retry` takes it: a failure of the agent or of the finish line, an agent stopped without a summary, a task a limit stopped; a task that failed before its agent got going offers **Start** again) and **Archive** (never in a stage where something runs, whatever the column), beside Reply and Approve, each only where herdr-projects can take it. **+ New task** adds one with a title, a description and its repo (`add --repo`); **Start now** puts an agent on it at once (`--delegate`).
  - **Every machine, by repo**: the Board opens on every machine, grouped by machine then by repo, each repo in the board's five groups (columns on a computer, where an empty one stays narrow; stacked sections that fold on a phone); the whole board in five groups stays one tap away (**By status**), and a machine can be shown alone. The machine shown stays on the device; the grouping and folded headings follow you across devices; nothing about the projects is kept by wherdr.
  - **Talk to agents in a side panel**: no chat box on the Board. A task opens its agent in a panel, in wherdr's own agent view (conversation, terminal, message field), under its title, its description (folded after a few lines), the Watcher's progress, and the agent's closing note or research report once there is one; its sheet and actions (Approve, Stop…) stay one tap away. A machine's heading opens that machine's Coordinator, a repo's heading that repo's project coordinator; one not started yet takes a first message that starts it, then shows its conversation. The panel always says who you talk to (machine, repo, task). Beside the Board on a computer, full screen on a phone with a way back. A task with no agent (to do, or its agent gone) opens its sheet, with **Start**. A message being written to a coordinator stays with it while its machine is away.
  - **Push for the Board**: herdr-projects' `board.notify` can run `herdr notification show`, which wherdr already relays; Settings › Plugins › herdr-projects gives the one command. The push names the task and what happened (needs you, ready to approve, failed), one per task, and opens that machine's task on the Board (never the same id on another machine), once the Board has read it afresh; a machine that does not answer keeps the request until it does.
  - The wherdr agent skill now describes what reaches a herdr-projects 1.x agent from the Board.
  - **Done hidden by default**: the Board shows the work in progress, in four columns (needs you, ready to approve, working, to do), in both views and on every screen. **Done · 9** at the end of the column heads (the last tab on a phone) shows Done and hides it again, kept on the server; shown, it lists the newest first across every machine shown (by when each task was made, read from its file), the latest five then **Show all**, as herdr-projects does. Machine and repo headings still count done tasks, quietly.
  - **Board Coordinator roles and hosts are explicit**: the main Coordinator appears once at the top, naming its host; its picker keeps unavailable machines visible with the reason. When none is reachable, the Board says so. Machine lanes offer “<machine> setup”, repo lanes “<repo> coordinator”; hover or long-press for each role, also shown in the panel header.
  - **Task keys as herdr-projects names them**: a task reads `APP-6`, its repo's short key (`repo.key`) and its number, not its repo's name in capitals. `list --json` gives ids only, so wherdr asks each repo's key once (`show --repo <name> --json`) and again every ten minutes. Until a key is known the task reads `#6`, as on herdr-projects' board.
  - **Coordinators by name in the agent list**: a herdr-projects coordinator lives in the home folder's space (`~`) or its repo's; its row now reads what it coordinates (“Coordinator”, “demo-app coordinator”), from its tab's name.
  - **The agent list groups the board's spaces again, as Herdr's sidebar does**: each machine's Coordinator and machine coordinator on top, then one group per repo, headed by the repo's own space (its name, and the branch and behind count of that machine's checkout, `main ↓38`; its terminal and menu at hand), with its project coordinator and its tasks' spaces under it: task key and title, state, progress and time on it (`42% 17m`), and the line the board reports. Only the board's repos are grouped: other spaces, worktrees included, stay where they were. Most urgent first inside a group; groups fold (kept on the device); the group says its most urgent state. A repo coordinated from another machine keeps its tasks here, with **Coordinated from <machine>**. The link is Herdr's own (a worktree space shares its repo space's `repo_key`), and the board's files (tasks, reviewers, attempts, coordinators: `GET /api/tasks/links`), never its command line. Other spaces stay in Your turn / Working / Ready.
  - **One row per task, its reviewer included**: herdr-projects puts a task's reviewer in a tab of the task's own space (“Agent”, “Reviewer #1”), and the list showed it as one more row (“APP-33 · review”), doubling every task under review. The reviewer is now part of its task's row, which says the stage, “Under review · codex” (“Plan review”, “Planning”, “Comparing attempts” for the plan reviewer, the planner and the Picker, “2 attempts” for attempts at work), shows the reviewer's state, and opens the task's space on the reviewer's tab while the review runs; the Agent tab stays one tap away there. A planner and its plan reviewer, and several attempts (“Agent A”, “Agent B”, “Picker”), stay in their task's row too. The counters (summary, machine heading, repo group) count tasks, not tabs. The link comes from the board’s files (the task’s pane, `link.reviewer`, the planner’s `plan.home`, attempts), never from titles. A space two tasks share gives each task its own row; a task with only its reviewer left open keeps its “Under review” label.
  - **A repo's project coordinator leads its group**: it no longer looks like one more task. It sits in its own row right under the repo's header, before the tasks, with the coordinator's icon (in its agent's color) instead of the agent's logo, the label “Coordinator” (the header already names the repo), its state and its last message. Folding the group folds its tasks only: the coordinator stays in view, and the header's counts then say what is folded. The machine's Coordinator and machine coordinator at the top use the same icon and label style; a coordinator's card no longer shows herdr-projects' internal folder. Tasks keep their key and layout.
  - **Repo groups headed by their coordinator**: in the agent list, a repo's group now starts with its project coordinator, larger than its tasks: the wherdr mark on the theme's accent, the repo's name in the title face, a **Coordinator** label and its state, without its last message (its question and one-tap answers still show when it asks one). Under it, a bar folds the group and sums up its tasks (“4 TASKS · 1 YOUR TURN · 1 LIMIT”), with the branch and the repo space's **…** menu, which holds its terminal (the separate terminal button is gone). The tasks hang under the bar, indented on a rule, and fold with it (kept per project on the device). A repo with no coordinator here keeps the same layout, with its initial and no label.
  - **Closing a space that holds a task's agent says so**: closing a repo's space closes its whole worktree group in Herdr; the confirmation now names the herdr-projects tasks whose agents it stops, and its button says it (“Close and stop 2 tasks”). The same for a task's own space or its agent's pane.
  - **Start names its agent, and takes another one**: a task's sheet shows, beside **Start**, the agent it starts with by default (its `worker.agent`, as `show <id> --json` resolves it, and where that comes from) and the other agents installed on its machine. One click on Start starts it with that default, as before; picking another agent starts it with that one for this start only (`delegate --worker.agent=<agent>`). herdr-projects keeps that pick as the task's own setting while the run lasts; wherdr then puts back what the task had (`unset`, or `set` to its earlier value) once the run is over and before its next Start, so the task's default, the repo's and your own settings are unchanged. A default agent not installed on the task's machine is shown but cannot be picked, and Start waits for an installed one.
  - The app, `/api/health`, npm package and Herdr plugin manifest all report 2.0.0.
  - **Board commands find agents installed in a user folder**, on an SSH machine as on this one: a non-interactive SSH session only has sshd's default PATH, so herdr-projects there could not find an agent in `~/.local/bin`… and refused to start the Coordinator (“"claude" is not installed here”). The remote command now gets the same PATH as the local ones and the login service (see Agent PATH in the README), the one an interactive login shell would have: first the PATH herdr-projects recorded from a login shell there (`env.json`, in its order, its JSON escapes decoded, under `HERDR_PROJECTS_DATA_DIR` or `HERDR_PROJECTS_HOME` as herdr-projects finds it), then the usual user folders that exist, then the session's own PATH and the system folders. Everywhere, the user's folders now come before the system ones, so an older system-wide copy of an agent no longer wins over theirs.
  - **A coordinator that cannot start says why**: when herdr-projects gives up starting a coordinator (its `coordinator status --json` keeps an `error`, such as “"claude" is not installed here, so it cannot be the Coordinator.”), the Board's side panel shows that reason instead of “starting” forever, with **Try again** (`coordinator restart`: started again, the message still waiting goes in). The panel says “starting” only while herdr-projects does, and names each coordinator once: “The Coordinator is starting”, “the devbox coordinator”, “the web coordinator” (no more “The Coordinator coordinator”); the machine coordinator is named after its machine, as herdr-projects names it.
  - **The Board's machine filter lists this machine again**: wherdr's own machine was missing from it (its key is empty, and the select drops an item with an empty value), although its tasks showed. It is now there under its name, and kept when chosen. A machine Herdr does not name reads as its key on the Board, never as this machine's name.
  - A machine is one board, shared by its named sessions (one list, one queue). A machine whose read fails says why on the Board; its last tasks stay, marked with the time they were read.
  - **Archive closes the task's sheet, with Restore at hand**: the sheet used to stay open with **Archive** still shown, and an agent's panel could even reopen it once herdr-projects closed the task's space. Archiving now closes the sheet and the task's panel, takes the task off the Board at once, and a toast offers **Restore** (`restore`) for a few seconds. **Archived**, beside the Board's views, lists each machine's archived tasks (`list --json --archived`); an archived task's sheet, from there or from a link to it, shows an **Archived** tag and only **Restore**, read-only as in herdr-projects. After Start, Stop, Retry, Approve or a reply, the sheet stays open and reads the Board and the task again before its buttons come back, so they match the task's new state; a refusal stays written in the sheet.
  - **A task's sheet opens its chat instead of a message field**: the **Reply to its agent** field and **Open its agent** are replaced by one **Open the chat** button, which closes the sheet and opens the task's agent in the Board's side panel, where you reply. It shows wherever the task has an agent or herdr-projects takes a reply; when the agent has no pane now, the panel shows a message field instead, which replies through herdr-projects (`tell`). **Stop**, **Approve**, **Retry** and the other actions stay as they were.
- **Machine bar on the home screen**: a square band at the top of the list, “All” (with its count) then each machine (its online / offline square and count); a tap shows that machine only, “All” shows them all again, and it scrolls sideways on a phone. The choice is kept on the device. Settings › Appearance › Home screen › Machine bar turns it off, orders its items (drag the ⠿ handle, or arrow keys on it) and takes some off it, a machine taken off still showing under “All”; **Reset: All + every machine** puts it back. Each machine's **…** menu (a single machine's too, on its session row) also has **Open the board**, which opens the Board already filtered on that machine (`#/board?machine=<key>`).
- **Do not disturb no longer adds a button to the home header**: the crossed-out bell next to Settings is gone, so the header keeps its shape when quiet mode starts or ends. While it is on, one discreet line in the agent list says until when (“Notifications silenced until 08:00”) and opens Settings › Notifications (a small crossed-out bell under the counters when the list is collapsed to a rail, below its buttons); the header's “…” menu, when it shows, keeps the entry.
- Agent copies reach this device's clipboard ([#47](https://github.com/afloury/wherdr/issues/47)): the terminal now handles OSC 52 (`ESC ] 52 ; c ; <base64> BEL`), the sequence TUI agents use to copy over SSH or tmux, and writes the decoded text to the browser's clipboard. Write only: a request to read the clipboard (`?`) is ignored, and so is a copy over 100 kB (a short message says so). When the browser refuses the write (iOS Safari outside a tap), a message “The agent copied text — tap to copy” copies it on a tap. On by default; Settings › Terminal › Clipboard › Agent copies turns it off on this device. **Needs Herdr to pass OSC 52 through**: Herdr 0.9.5 keeps it for its own terminal clients and does not send it to wherdr's terminal session yet.
- CI: a pull request that only changes the README launch film (`assets/`) or its tooling (`tools/launch-video/`) no longer runs the browser tests; the required `checks` and `e2e` checks still report.
- Fix Ctrl+V in the terminal on Windows, Linux and ChromeOS ([#45](https://github.com/afloury/wherdr/issues/45)): xterm sent it to the agent as ^V, so the browser never pasted; text needed Ctrl+Shift+V and clipboard images (a Win+Shift+S screenshot) never reached the agent. Ctrl+V is now left to the browser there: text is pasted once and an image goes through the photo upload, as with ⌘V on a Mac. On a Mac and an iPhone, Ctrl+V still reaches the agent. F12 opens the browser's developer tools again while the terminal has focus. Also fix `herdr-plugin.sh update` stopping with “SOURCE: unbound variable” on macOS: its bash read the first byte of the “…” after `$SOURCE` as part of the variable name; a test now checks every shell script for this.
- **Private by default**: wherdr now answers only this computer and your tailnet. Every request and WebSocket is judged on the address its connection comes from, which a client cannot forge: loopback; a tailnet address only when Tailscale, running on this machine, lists it as a peer (read from Tailscale every 10 s, never guessed from an interface in `100.64.0.0/10`). Proxy headers from a local proxy (`tailscale serve`) can only refuse more. While Tailscale Funnel exposes wherdr's port (HTTPS, TCP or TLS-terminated TCP), every connection from this computer is refused, with a page that says how to turn Funnel off. A relay you run yourself on the machine still counts as this computer: the README and Settings › Security say so. A device on another network gets a page saying why (HTTP 403, `network`). wherdr refuses to start on an address other than loopback or this machine's tailnet address as Tailscale reports it (`HOST=0.0.0.0`, a LAN address). `WHERDR_TRUSTED_NETWORKS` names other private networks (ZeroTier, WireGuard: `10.147.17.0/24`); `any` accepts every network, with a warning at startup, a banner in the app that cannot be hidden and a setup guide that recommends the passkey.
- Funnel detection fails closed on the target too: any Funnel route counts unless its target clearly leads to another port (`0.0.0.0:7683`, other spellings of loopback, unparsable targets count; Funnel for another service's port does not). A Funnel exposure, once seen, stays until a valid reading shows it gone: a failed or late reading, or Tailscale briefly not found, does not reopen wherdr. Tailscale is read again before every WebSocket upgrade and at most 2 s before an HTTP request, and open WebSockets are closed (1008) when a new reading no longer allows them.
- When Tailscale's state cannot be read, wherdr cannot check Funnel: it serves connections and says so in its log at startup.
- **The passkey is never required**, on any network: it needs HTTPS, and wherdr recommends it without imposing it. Settings › Phone works from every device wherdr answers, networks added with `WHERDR_TRUSTED_NETWORKS` included. A passkey already set up locks the app as before. Settings › Security, the setup guide and the README (*Network access*) list short good practices: prefer Tailscale; a network added without HTTPS gets no passkey, no installed app and no notifications, and any device on it can control the agents; create a passkey as soon as wherdr is reached over HTTPS.
- The **Update** button of the new-version banner shows on every device that can open wherdr, not only on `localhost` or after a passkey unlock.
- Long conversations are re-read incrementally: when the agent writes, the server now sends only the new messages and the ones that changed (a tool that got its result, the last reply), instead of the whole bottom of the conversation. With 2,000 messages loaded, a new message costs about 350–500 bytes instead of about 420 KB, and messages already shown keep their objects, so the view has less to redo. When the server cannot vouch for the list a device holds (server restarted, list forgotten, another item count), or for `/clear` and another session, the device gets the full list, as before. Fixed on the way: re-reading a long conversation whose bottom starts past the first 2 MB no longer drops its first message.
- Add a 15-second animated README launch film using real captures of the app’s demo build: launch an agent on desktop, follow the same conversation on a phone, approve its test request, then open project tasks and the Board. Includes silent square and 16:9 MP4s, a 720 px animated WebP, and reproducible Playwright/HyperFrames/FFmpeg tooling in `tools/launch-video/`. Animated headlines, camera moves, zooms and a desktop-to-phone handoff surround the unchanged app captures; a subtle button highlight suggests approval, with no hand or simulated controls. Clarify phone home-screen installation without an App Store.
- Play videos in the Files window and from a file named in a conversation, on this computer or a remote machine: MP4, M4V, MOV and WebM open in the browser's own player (inline on iPhone, full screen from its controls) instead of “Binary file”. The video is streamed straight from the agent's machine: whole (200) without a Range header, one byte range (206) with one, as Safari on iPhone and iPad requires, and HEAD gives its headers alone. A video of any size plays and seeks without being held in memory: one process per request opens the file once, takes its size from its metadata and seeks to the range (`dd skip=`), so nothing before the range is read, BusyBox included; it stops as soon as the browser drops the request. Each answer carries an ETag, and `If-Range` with another version gets the whole current file. The first satisfiable range is served, an invalid Range header is ignored. A file is served as a video only when the opened file's container signature matches its extension (`video/*` with `nosniff`). When the browser lacks the codec (a `.mov` outside Safari, for example), the window says so and keeps Open and Download; Refresh tries the player again. Download is unchanged (50 MB max). The file preview no longer reads a whole file to learn its size.
- iPad layout: in portrait (iPad mini 744 × 1133, iPad Air 820 × 1180) the app now uses the computer layout instead of a stretched phone view. The agent list stays a narrow column and slides over the conversation when opened (closed by a tap outside, Escape, or picking an agent); on the home page it opens by itself. Landscape keeps the docked sidebar. On touch tablets buttons are 44 px. Once a hardware keyboard is proven (an arrow, Escape, Tab or a ⌘/Ctrl/Alt chord), Enter sends the message (Shift+Enter adds a line); the proof is forgotten on any touch and when the message field loses focus; otherwise, including with the floating on-screen keyboard, Enter adds a line. Phones are unchanged, including large ones in landscape (932 × 430).
- **A message sent while the agent works is no longer left half-typed or wrongly marked “Not sent”.** Claude Code (2.1.304) puts a message typed during a turn in its own queue and takes it at its next step or at the end of the turn; Codex (0.163) adds it to the running turn at once. wherdr typed it and gave up after 4 seconds when the agent's screen lagged (a long session, a loaded machine): the text could stay in the agent's field until someone pressed Enter, and the bubble said “Not sent” even when the agent took it later. Now a lagging screen gets more time; a send given up takes its own text back out of the field (never anyone else's), and during a turn the message waits as **Queued · will be sent when the turn ends**, then goes once the agent rests, unless its transcript shows the agent took it after all (never twice). Codex's field is checked the same way after Herdr's `agent.prompt`. “Not sent” goes away by itself as soon as the message shows in the saved conversation, and a bubble whose request failed no longer comes back once the server had the message.

## [1.3.4] — 2026-10-18

- Fix **Install herdr-projects** installing a version wherdr cannot read: upstream herdr-projects is now a 1.x that is a different product (a task board, with no projects, `TASKS.md` or threads) and whose first run moves `~/.herdr-projects` to `~/.herdr-projects-legacy`. The button and the copied command now install the 0.2 line from the fork (`herdr plugin install afloury/herdr-projects --ref v0.2.36 --yes`); installing from upstream, even pinned to v0.2.35, is not safe, because the plugin's own `herdr-projects update` would then offer 1.x. Installation is pinned to v0.2.36, which provides prebuilt binaries for macOS and Linux on ARM64 and x86_64; wherdr allows two minutes for the checkout and download. Settings › Plugins › herdr-projects now says when a machine has 1.x (“Not supported”, with the command to go back to 0.2, the warning not to run 1.x over 0.2 projects and a link to upstream's guide), and warns when a 0.2 installed from upstream would update itself to 1.x. Project actions on a machine with 1.x say it is not supported instead of “Projects binary not found”. README, the agent install guide on wherdr.dev and the wherdr skill point to the fork and say 1.x is not supported yet.
- Render plain bullet tasks with the same full-width text and badge footer as other project tasks. Every unfinished task, including custom lists and In progress entries, offers a question draft to the coordinator.
- Render PDF previews with a bundled, lazily loaded PDF.js worker on every device, including iPhone and iPad: all pages fit the window, with Retina canvases rendered near the viewport and released off screen. Open and Download keep their existing URLs.

- Fix missing Codex conversations and messages reported as “Not sent” on remote Linux machines using dash when a recent session day has no folder. Remote folder and file reads now identify missing paths independently of shell error wording, including byte-range reads.
- Say why a conversation is missing when Herdr's integration of the agent is not installed: instead of “No conversation for this agent yet.”, the conversation of an agent already at work (or running before wherdr started) explains that wherdr cannot find it without the integration, shows the exact command (`herdr integration install codex`, `claude` or `omp`) to run on the agent's machine, then restart the agent, with Copy command and View terminal. wherdr reads `herdr integration status` on that machine (cached for a minute) only when a conversation is not found; a brand-new agent that has not been asked anything still shows “No conversation for this agent yet.”
- Fix project skills and commands missing from the “/” menu of a Claude Code conversation when the agent runs in a subfolder: like Claude Code, wherdr now reads the `.claude/skills` and `.claude/commands` of the pane's folder and of each parent folder, up to the Git root and never past the home folder. When macOS refuses to list those folders (a project under Documents, Desktop… on a Mac reached over SSH without full disk access), the menu now says so, with the setting to turn on, instead of silently showing no project commands; typed in full they still work. A skill or command added on the machine shows up in the menu within about 20 seconds, without reloading the app.
- Fix Codex being interrupted by scrolling its terminal: Codex tracks the mouse, so each scroll becomes a wheel report written to its terminal. A trackpad flick sent about 60 of them a second; when Codex read them late, the tty buffer filled up (about 1 KB on macOS) and a read could end right after the Escape that starts a report. Codex took it for the Escape key, interrupted its turn and typed the rest (`[<65;76;23M`) into its field. Scrolls are now merged and sent at most every 75 ms (a two-second flick: 270 bytes instead of 1,200).
- Show a Codex turn stopped by Escape as “Interrupted” in the conversation, as for Claude, and show text left in Codex's input field above the message field (it would otherwise be sent glued before the next message), with a button to clear it.

- Fix “No subfolders” shown for a folder that macOS refuses to list (Documents, Desktop, Downloads… over SSH without full disk access): the folder browser now says “macOS blocks access to this folder” with the setting to turn on (Remote Login › “Allow full disk access for remote users” on a remote Mac, Full Disk Access on this Mac), or “Permission denied” for plain Unix rights. Parent and the path field stay usable. The Files window reports the same refusal instead of an empty folder.

- Preview PDFs in the Files window and from a file named in a conversation, on this computer or a remote machine, with PDF.js (up to 50 MB, like Download). **Open** shows the same PDF in a new tab, where an iPhone uses its native viewer with every page. The PDF is served as `application/pdf` with `nosniff`, framed by the app only, and runs nothing in wherdr's origin; other binary files still show “Binary file”, and Download is unchanged.
- Passkey lock: the duration chosen in Settings → Security is now the only rule. The passkey is asked again at the first opening after the last unlock plus that duration, used or not in between; the 12-hour idle lock is gone. Open sessions move to the new rule without a new unlock, and a changed duration applies to them right away (a session in use is not cut on the spot).
- Release unmounted conversations while keeping per-agent drafts, attachments, pasted text and prompt-history draft restoration persistent.

- Fix a message ending with a backslash never reaching Claude Code: Claude reads “\\” then Enter as a line break, so the message stayed in its input field while wherdr showed it as sending. Such a message is now typed with a trailing space that Claude drops, and submitted with its backslashes intact; a send that leaves part of the message in the field is reported as not sent.

- Fix Claude Config tab clicks using the real focus legend, verify each tab transition, and report failed switches.
- Lighten an open tab: the interactive-terminal window is driven by state changes and one timeout at the end of its debounce instead of a 100 ms poll; the Markdown and question caches are capped in characters, least recently used first, and drop the earlier versions of a reply still being written; the Claude and omp spinners stop while the page is hidden and resume on the right frame and elapsed time.

- Recall previous messages and slash commands with ↑/↓ in the message field, with per-agent history and draft restoration.

- Make native menu arrows responsive, focus Claude settings tabs before switching, show the live Codex usage terminal with its subtitle, and dismiss stale command previews when native controls appear.

- Refresh consecutive agent questions faster and refuse outdated card answers, including keyboard confirmation, typed replies and menu clicks. Identify full questions before display truncation. Re-read viewed cards independently of slow batches with reserved RPC capacity; keep newer captures when an older batch completes. Menu clicks identify the target and its details across scrolling. Publish a viewed pane as soon as its read completes; keep native forms disabled with an explanation during read failures and bound screen-read concurrency.
- Native-answer validation and input are separate Herdr RPCs: Herdr protocol 22 has no conditional send. A question can still change between the checked read and key injection, or recur identically; this race is not closed by wherdr.

- Use “Done” consistently for completed project threads and “Mark done” for their action, sharing the Board’s status labels.
- Fix npm release archive paths and allow manual publication of an existing release from `main`.
### Added

- **Board project filter**: the filter button in the Board header hides chosen projects, or the
  agents outside projects (**Other agents**). The choice is kept on the device; column counts
  follow the filter, and a new project shows until you hide it.

## [1.3.3] — 2026-10-12

### Added

- **Live terminal window for interactive agent screens**: ambiguous menus and panels open
  the real pane in a modal window, with a key bar and an always-visible Close button.
  The scrim of the other windows covers the whole app and keeps clicks and focus in the
  terminal; a click on it closes the window, Escape goes to the agent. In a split, only the
  cell in use opens it.
  A stable return to the message field closes it; manual dismissal lasts for that interaction.
  The window fits the pane to its container and releases its existing size lease when closed.
  Existing native questions, approvals, menus, waiting screens and Claude settings cards
  retain their controls, compact-card previews, one-tap answers and notifications.
  The window is a fallback after their recognizers, with explicit exceptions for
  Codex's two-column `/usage` and Agent Command Center.
  Codex `/usage` is no longer copied into a static result and a guessed two-column choice list.
  The browser demo includes a scripted version of the interactive usage screen.

- **Project panel › Settings and Memory tabs**, both read-only. **Settings** shows what
  PROJECT.md sets (name, goal, coordinator and thread profiles, parallel threads, auto-resolve
  delay, nudge, mute, repositories), with the plugin's default marked for a key the file leaves
  out; safety settings are not shown. **Memory** lists MEMORY.md and the files of `memory/` with
  the title and hook the index gives them, and opens one as Markdown. With six tabs the bar
  scrolls sideways on a phone; a fade on its edge says there are more.
- **Project panel › Inbox and Routines tabs**. **Inbox** lists the project's unhandled inbox
  items (a thread's new report, a routine due, a machine out of reach…), oldest first, with the
  thread's title when the item is about one; **Done** marks one as handled (`herdr-projects
  inbox done`). **Routines** shows each routine's schedule, whether it is enabled, its kind and
  its last and next run, read-only: approving or switching a routine stays in the terminal.
  herdr-projects has no JSON for either yet, so the inbox is read from the project's `inbox/`
  files and routines from the tab-separated output of `routine list`, whose run texts are shown
  as printed.
- **Project panel › Threads tab**: every thread of a herdr-projects project, as `herdr-projects
  thread list` gives it. Open threads sit under their group (Your turn, Ready for review,
  Working…) with machine and profile; resolved ones stay in their own folded section, by pages of
  30. One filter covers both (ID, title, machine, profile). A tap opens the thread's record
  (`thread show`): state, Next list, branch, dates, and its actions, run by herdr-projects on
  the coordinator's machine: **Acknowledge**, **Restart**, **Stop** and **Resolve** (the last two
  ask first), plus Open agent, View report and Pull request. The panel now has tabs (Tasks,
  Threads). Nothing changes without herdr-projects.
- **Diff review on a line or a block of lines**: in Changes, comments start from the gutter and
  the code is plain text that can be selected and copied — a click on a line no longer creates a
  comment. With a mouse, a **+** shows on the hovered line: click it, or press and drag over
  other lines for a block (Shift+click changes the block of the open editor). On a phone, tap a
  line number, tap another line to extend, then **Comment** in the bar pinned at the bottom. On a
  keyboard, arrows move between lines, Shift+arrows choose a block and Enter opens the editor;
  ⌘/Ctrl+Enter saves, Escape cancels without closing the window. A block stays within one hunk.
  Each comment is a thread under the last line of its block, with its lines ("Lines 12–18"),
  Edit and a two-step Delete; drafts, including an editor left open, are kept per agent on the
  device, and a block that leaves the diff or whose code changed is flagged after refresh. Send review appends
  `file:12-18 — remark` and a short excerpt of the block, grouped by file, to the message draft
  without sending it or replacing existing text. Old-line labels for deletions, remote agents
  and demo support.
- Publish checksummed GitHub release packages independently of npm moderation. Native
  plugin installs and one-tap updates verify these packages, including the agent skill;
  Homebrew uses the same GitHub archive. npm publishes that exact archive separately.
  Registry and formula availability gate update notices; the legacy GitHub latest marker
  advances automatically only when existing 1.3.x updaters can safely install the version.
  Plugin installs fall back to the prebuilt npm archive before compiling. Preserve validated
  update notices on transient failures; require a prepared draft with notes before publishing.
  Release readiness reports missing npm/Homebrew conditions and leaves an unchanged latest alone.

- Bundle the wherdr agent skill in npm / Homebrew packages and Docker images. Native
  starts and one-tap updates refresh the shared host copy; the Herdr Docker plugin
  extracts it after pulling the image. Manual Docker installs have a host-side helper.
  Existing unrelated skills are preserved, and missing agents or write failures do not
  prevent startup. Document plain task URL links in the skill.

- **Board**: one view of everything, in four columns (Blocked, Todo, Ongoing, Finished): every
  agent pane, also outside projects, and with herdr-projects every project, thread and
  `TASKS.md` task, read for all projects at once (`GET /api/board`). Opened with `H` or the
  board button above the agent list; each card opens its Project panel, thread, report or
  agent. Moving a task card (drag and drop on a computer, **Move to…** everywhere) sends the
  coordinator the Project panel's message, or the new `↳ Mark blocked`, `↳ Move to To do` and
  `↳ Mark done` (coordinator rules and `skills/wherdr/SKILL.md` updated). Thread and agent cards
  follow their state. English and French, phone and computer, demo included.
- **Inline diff review**: comment on lines in Changes, edit or delete remarks, and keep a
  device-local draft per agent. Missing lines are flagged after refresh. Send review appends
  grouped file/line remarks to the message draft without sending it or replacing existing text.
  Includes old-line labels for deletions, keyboard/touch controls, remote agents and demo support.
- **Yes / No in one tap**: a closed question of an agent's reply now has **Yes** and **No** next
  to its `↳ Reply`, in the three reply styles. A tap quotes the question and writes the answer
  under it, as Reply and typing would; nothing is sent, so several questions are answered in a row
  and the keyboard stays down on a phone. The other answer replaces the first, typed words are
  never replaced. Offered only when yes or no answers the question in full: a single sentence
  with a yes/no opening, no alternative, no interrogative word and no negation; otherwise Reply
  alone.
- **Decision tables answered row by row**: under a Markdown table of numbered questions (a
  number column, and a question column known by its header, by its question marks or by an advice
  column next to it), **OK to all** accepts the whole table, and each row has **Yes**, **No** and
  `↳`. Every answer names the message and the row it refers to
  (`↳ Quote decision 11:37 #3 : … —`, then `Yes`), so an answer to an earlier table is never read
  as an answer to the agent's last message. Composed in the field, sent by you; a table of another
  shape gets nothing.
- **N questions unanswered** above the field: the questions of the agent's last message, and the
  rows of its decision tables, that the draft does not answer yet. A tap scrolls to the first
  one. It goes once everything is quoted or answered and when the message is sent, never shows
  for earlier messages or while the agent works, and takes no room: nothing moves when it comes
  or goes. When the message asks one thing only, any typed words count as its answer.
- The demo's Claude agent now ends its reply with a closed question, to try the one-tap answers.
- **Restart after Codex updates itself**: when Codex's own installer exits to its shell,
  a Your turn card offers a one-tap restart and sends the usual attention notification.
  A new conversation reuses its launch command; an existing one can resume its exact session
  or start fresh. If the session is uncertain, Resume opens Codex's conversation picker.
  Restart checks the foreground process and the unchanged empty prompt before typing.
  Dismiss puts the card away and gives the pane back as a plain shell; the messages that waited
  for the restart go back into the message field.
- **Browse files** in an agent's ⋯ menu: a read-only browser of its project (the Git root, or the
  agent's folder outside Git), opened on the agent's folder. Folders and files with their sizes, a
  breadcrumb to go back up, text files with line numbers (first 256 kB), images up to 2 MB.
  Hidden files (name starting with a dot) are shown; **Show hidden files** hides them, remembered
  on the device. Local and remote machines alike; nothing above that root is shown, symlinks
  included, and nothing is written.
- **Preview** and **Download** on a file path in an agent's reply (and on a sent attachment),
  whatever machine the agent runs on: Preview shows the file in a window like Browse files, and
  Download saves it on the device you are using, where Copy path alone did not help when the
  agent runs on another machine. Browse files' preview gets a **Download** button too. Files in
  the home folder only, symlinks included, up to 50 MB.
- **Discuss a point**: a list item or a paragraph of an agent's reply that asks nothing can now be
  quoted in the field like a question, to answer it in the same message. Not offered on code,
  tables, quotes, titles, an introduction ending with a colon or a point of one or two words.
- **Settings › Conversation › Reply style**: three ways for a reply to offer its questions and
  points, saved on the device. **Icon** (default): a small `↳` after each question and a grey one
  after each point (on hover on a computer, always there and pale on a phone). **Tap the text**:
  no button, the underlined question is tapped; a point is clicked on a computer, and on a phone
  tapped once to show **↳ Discuss**, so that a tap while reading never quotes. **List under the
  message**: a number after each question, the questions listed under the message, and
  **+ Quote a point** to pick a point, offered only when there is a choice (a list item, or two
  points or more), not under a reply of plain prose. All of them work with the keyboard.

### Changed

- **One syntax for every reference: `↳ <type> <reference> : <excerpt> —`.** Replying to a
  message, quoting a question, a point or a passage, answering a row of a decision table and the
  Answer / Clarify / Comment actions of the Project panel all write the same kind of line, the
  answer on the lines below: `↳ Quote message 11:37 : I can merge the PR —`,
  `↳ Quote point 11:37 : … —`, `↳ Quote decision 11:37 #3 : … —`,
  `↳ Quote decisions 11:37 #1-4 : … —`, `↳ Decision: <task> —`. The reference ends with ` —` at the
  end of its line only (an excerpt may hold dashes), a long excerpt is cut with `…`, and several
  references fit in one message. A short code after the time or the row (`11:37 #3 ~k3f`) tells
  apart two messages of the same minute and two tables of one message, so an answer never
  replaces the answer to another table; the field draws it dimmed, the sent quote leaves it out.
  **OK to all** names the rows the table really has (`#1,4`, not `#1-4`, when rows 2 and 3 do
  not exist). The field draws each one as a token and the sent bubble as a
  quote that leads to the message it names. **Reply** under a message no longer opens a box above
  the field: it adds its line like the others. A `>` typed at the start of a line is plain text
  again; messages already sent with `> ` lines still show as quotes. Pasted text never becomes a
  reference: a pasted line that reads like one gets a `\` before its `↳`, and a **Pasted text**
  card is sent exactly as pasted. The Project panel drafts that started with `↳` now put the
  answer on the next line instead of after the dash, and **Problem** and **Question** write the
  same kind of line (`↳ Problem: <task> —`, `↳ Question: <task> —`) instead of `✗ Problem: … — `
  and `? Question: … — `; the `wherdr` skill and the coordinator rules explain the new lines.
- **Quoted replies: two choices.** Settings › Conversation › Quoted replies keeps "Tokens, native
  field" (default) and "Plain text", the same `↳ … —` lines shown as text, as a fallback. The
  experimental "Tokens, rich field" is removed; a device set to it moves to the native field.

- **↳ Reply looks the same wherever the question is**: the button of a question that ends a
  message was only shown on hover on a computer, while one in the middle of a paragraph stayed
  visible. Both now show the same way, and the labelled tag gives way to the icon (or to the
  style chosen in Settings).
- **Compact list by default**: the agent list (home screen on a phone, sidebar on a computer)
  now shows one line per agent or space unless you chose otherwise. A device where Settings ›
  Appearance › Home screen › Compact list was never touched switches to the compact list; a
  device where it was turned off keeps the detailed cards. Turn it off there to get the preview,
  folder and model back on the cards.
- **One-tap answers in the compact list**: the one-line card of an agent waiting for an answer
  opens on its question, the requested action and the same answer buttons as the detailed card,
  then folds back to one line once answered. The other cards stay one line.
- **Quoted replies: tokens in the native field by default.** Settings › Conversation › Quoted
  replies is one list for the device in use, instead of one for a computer and one for a phone.
  "Tokens, native field" is the default and no longer marked experimental. Every device moves to it once, whatever it had saved (a choice could not be told
  from the former default); a choice made afterwards is kept. The preview plays once instead of
  looping, and has a **Replay** button like the typewriter preview.

### Fixed

- Show Claude usage-limit waits above the conversation field with automatic resume, cancel,
  usage credits and reset actions when offered, without opening the interactive terminal.
- Disabled routines and resolved threads (their record in the Project panel, their card on the
  Board) use neutral gray badges; enabled routines stay green.
- A pane whose agent changed while its session stayed the same could show an empty
  conversation ("No messages yet.") until a new message arrived: its transcript was read as the
  other agent's. A transcript is now always read as the kind its file says.
- Preserve unchanged skill files and repair only recorded managed broken links. Respect
  `WHERDR_SKILL=off` and persistent uninstall across starts and updates. Docker extracts
  only skill data with the local helper and the one-command installer refreshes it too.
  Bound updater refreshes, preserve service paths, and report manual helper failures.
- **Back pressed while the app loads**: an address change that arrived during startup (Back
  right after a reload, a hash set as the page loads) was undone, and the app stayed on the view
  it started on. The last address asked for now wins.
- The manual Homebrew formula update uses the authenticated GitHub user's noreply
  identity in its temporary clone, including on machines without a Git email configured.

- **Project panel messages never answer the coordinator's screen**: a button pressed while a
  Claude or Codex coordinator waited on a question or a permission dialog typed its message there
  and pressed Enter, which could answer it. Panel and Board messages now always go through the
  message queue, held until the coordinator's input field is back, and are refused when the pane
  no longer runs an agent. One task message is sent at a time, app-wide.
- **TASKS.md lines are cleaned before use**: control characters, terminal escape sequences and
  invisible direction marks in a task line are removed, so a button never types them into the
  coordinator's terminal. Very long lines (over 2,000 characters) are ignored, and headings are
  read without a regular expression that could stall the server on long runs of spaces.
- **Tab threads open from the Project panel**: a thread opened as a tab of its coordinator has no
  pane name; it is now found by its herdr-projects token.
- **One diff line per row in Changes**: since inline review, every line of a diff was 44 px high
  (a blank line after each one) with the comment marker under its line number. A row is one line
  of code again, on a computer and on a phone; the marker shows beside the number on hover or
  keyboard focus.
- **Long folders scroll in Files**: a folder taller than the window (1500 files, for example) did
  not scroll with the wheel, the trackpad or a finger, so its last files were out of reach. Changes
  had the same defect, and its review bar now stays pinned while the diff scrolls.
- A confirmation asked from an open window (a sheet on the phone) showed behind it; it now
  sits above every window.
- **Pasted text cards on every device**: a message with typed words and a text pasted into the
  field showed its card only on the device that sent it; elsewhere it was one long folded message.
  The server now remembers which parts were pasted (`pastes.json` in its data folder, the last 100
  texts, each for 30 days), so every device shows the same card, for Claude, Codex and omp, queued messages
  included. Not covered: a paste typed into a Codex or omp terminal, and messages sent before
  this version.
- **Codex restart after an update**: Project panel messages wait instead of being typed
  into the stopped shell. Unfinished quotes and heredocs refuse a restart; uncertain
  transcripts offer both choices without reusing a contradicted session ID. A rapidly
  replaced Codex keeps its own launch arguments.
- **Terminals in split panes**: every visible terminal fills its cell and stays connected
  when focus changes. Moving focus routes keyboard input without replacing terminal instances.
  Divider resizing updates all terminals while dragging. Leaving the tab restores original
  sizes, respecting later resizing by a Herdr client. The browser demo follows the same sizing
  behaviour and places short Claude exchanges at the top without inserting blank rows.
- **Panes side by side on a computer**: with the default background (Settings › Appearance ›
  Desktop › Background "wherdr grid"), a conversation shown next to another pane had the dotted
  grid and the two lines of the reading column running through its messages and around its
  field. A pane in a split is back on a plain background, full width; the grid stays in the
  margins of a pane opened alone. Seen in the online demo, the same in the app.
- **Blocking prompt on the "wherdr grid" background**: the grid no longer shows behind the
  question and its choices; the reading column stays plain and framed there too.

## [1.3.2] — 2026-10-10

### Added

- **The tailnet address enables itself**: wherdr reads what `tailscale serve` publishes on its
  machine (at startup, every 30 seconds, and when an address it does not know is opened) and
  adopts the HTTPS address that points to its own port: allowed host and `APP_URL`, with no
  visit to Settings › Phone, so a server without a screen works too. An address removed from
  `tailscale serve` is refused again. In Docker, wherdr reads Tailscale's socket, mounted by the
  new `docker-compose.yml` (`/var/run/tailscale`; it gives the container Tailscale's local API
  with the host user's rights, see the README, and can be removed); the address it suggests now
  carries the machine's name, not the container's. Nothing a request sends can enable an
  address, and one that `tailscale funnel` opens to the Internet is never adopted.
- **The installer sets the phone up in Docker**: it offers to run `tailscale serve` (asked
  first), hands the address to wherdr and waits for it to answer. Run again later, it checks the
  phone address of the wherdr already installed.
- **Project panel › Add info**: each working thread (its card under In progress, or the In
  progress task of a thread) has an **Add info** button. It opens a multi-line text field (a
  full-screen sheet on the phone); what you type is sent to the coordinator as
  `↳ Info for t-NNNN: …` (`↳ Info pour t-NNNN : …` in French), and the coordinator passes it on
  to that thread as is. The `wherdr` skill and "Copy rules for the coordinator" describe the new
  message.
- **wherdr.dev for search engines**: `sitemap.xml` generated at build time with the date of each
  page's last change, a `robots.txt` that names it, a canonical link, complete Open Graph and
  Twitter Card tags with a new 1200×630 share image, and `SoftwareApplication` structured data.
  The demo and the installer script stay out of search results.
- **Update in one tap**: with the Herdr plugin (Node.js mode), a global npm install or Homebrew, the
  "wherdr X.Y.Z is available" banner (home screen, Settings › About) has an **Update** button, for
  a session on this computer or unlocked with a passkey. wherdr installs the new version in a
  detached process, restarts, and waits for `/api/health` to report it; the app shows an
  Updating screen and reloads on the new version. A version that does not answer within 60 s is
  rolled back by itself (previous plugin copy, previous npm version, previous Homebrew keg), and
  the app says "Rolled back to X.Y.Z". Log: `~/wherdr/update.log`. Docker and npx keep showing
  the command.
- **Browser demo at [wherdr.dev/demo](https://wherdr.dev/demo/)**: the real app, built with
  `npm run build:demo` (static, no server), on scripted agents that run in the page — two
  projects, Claude Code, Codex and omp in different states, a split with a dev server, the Project
  panel, diffs, terminals. Sending a message gets a scripted answer, sometimes after an
  Approve / Deny card. Nothing runs: `fetch` and `WebSocket` are answered in the browser and every
  other request is refused. Linked from the top of the site and of this README.
- **Long pasted text as a card**, like Claude Desktop: a pasted log or long text (more than 12
  lines or 1,500 characters) shows as a "Pasted text · N lines" card under the message, with its
  first lines. A tap opens the whole text in a scrolling window (a sheet on the phone), in a
  monospace font for a log, with **Copy**. Pasting such a text into the message field adds the
  card instead of filling the field; it can be removed, and is sent to the agent as it is.
  Claude's `<pasted_content>` blocks are recognized; for Codex and omp, the texts pasted from
  this device are.
- **Long typed messages fold** after about 12 lines, with a fade and **Show more / Show less**.
- **Continue on the tailnet address**: a passkey only works on the address it was created on.
  When wherdr's tailnet address is published and answers, the setup guide opened on `localhost`
  shows a **Continue on <machine>.<tailnet>.ts.net** button that reopens it at the same step
  there (`#/setup?step=…`), and the passkey card (guide and Settings › Security) sends the lock
  to that address. No automatic redirect. The Herdr plugin (first install, **Open**),
  `wherdr open` and the installer's summary use that address too when it is already published,
  and `wherdr phone` makes wherdr adopt an address published by hand (`APP_URL`).
- **Why wherdr**: a section at the top of the README and on wherdr.dev that says in six points
  what wherdr adds to Herdr.

### Changed

- **Setup guide for agents** (`https://wherdr.dev/agent.md`): a third of its size, so fetch
  tools return it whole (it also says how to read the raw file). The agent detects what is
  installed before asking (wherdr, herdr-projects, Tailscale), sets the phone address through
  wherdr instead of editing `plugin.env`, offers no login service to a plugin or Homebrew
  install, and finishes on the tailnet address: passkey with the bootstrap token, then the phone.
- **Settings › Appearance › Theme**: the theme list is split into three titled sections —
  wherdr (Titanium first), Agents (Claude Code, Codex, omp, omp Light) and Herdr (Follow Herdr,
  herdr.dev and Herdr's built-in themes). Each theme carries its section in `app/utils/themes.ts`.
- **Website install section**: three tabs side by side — curl (the one command, selected by
  default), Package managers (Homebrew, npx, bunx, pnpm dlx) and Herdr plugin — above the
  "Ask your AI agent" card, instead of a folded "Other ways" block. The Docker-by-hand tab is
  gone from the site; Docker stays documented in the README and through `WHERDR_MODE=docker`.

### Fixed

- **↳ Reply on a question in the middle of a paragraph**: a question followed by other
  sentences ("Shall I start step 1 now? A slot is free.") now gets its **↳ Reply** button, placed
  right after the question; the quote added to the field is the question alone, not the
  paragraph. A paragraph or list item with several questions gets one button per question, in
  order (questions that follow each other stay one quote). Still no button for a "?" in code, in
  a URL, in quoted words (`You asked "can it be faster?"`), in a title or a table, nor for a
  question the agent answers itself ("Is it done? Yes.", "Why? Because…"). On a computer, a
  button in the middle of a paragraph stays faintly visible instead of appearing on hover.
- **A pane gets its size back when wherdr's terminal closes.** Opening the terminal on a phone
  resizes the real pane to about 40 columns, and with no Herdr client attached to lay it out
  again (a machine driven from afar) it stayed that narrow: the agents' screens were cut (omp's
  model selector, its status line without the model…). wherdr now remembers the pane's size when
  its first terminal opens and gives it back when the last one closes — after 2 seconds, or
  30 seconds after a connection that dropped (locked phone, lost network), so a terminal that
  comes back keeps its size. A size set meanwhile by an attached Herdr client is left alone, and
  the sizes to give back survive a restart of wherdr. The width is read from the pane's PTY;
  in Docker, where it is out of reach, the pane gets the width of Herdr's layout.
- **Docker: the machine is no longer called "wherdr"** when `HOST_LABEL` is missing from `.env`
  (the container's host name was shown, so Settings › Plugins read "wherdr · Not installed").
  wherdr then shows the name Tailscale gives the machine, and the installer writes the host's
  short name (without its domain) in `.env`. A `HOST_LABEL` you set, or a name chosen in the
  app, still wins.
- **Settings › Plugins**: the button says **Install herdr-projects** instead of **Install**.
- **"This address isn't enabled yet" (403) on a server without a screen**: the page no longer
  only says to open wherdr on the computer. It gives the command to run on the machine
  (`wherdr phone`, or the installer again for Docker and the Herdr plugin), and the address is
  now enabled without it in the usual case (see above).
- **Phone address checks** (`wherdr phone`, the installer, the plugin) ask `/api/health`, which
  goes through the host check, instead of the static manifest, which answers for any host name:
  an address wherdr refuses is now reported as refused, not as answering.
- **Setup guide and Settings › Phone opened on the tailnet address**: they show that address and
  its QR code instead of asking to open `http://localhost:7683`.
- **Project panel**: opening it with the board already loaded (reopening a coordinator) no longer
  breaks it with "Cannot access … before initialization".

## [1.3.1] — 2026-10-08

### Added

- **One install command for macOS and Linux**: `curl -fsSL https://wherdr.dev/install | sh` now
  checks Herdr (and links https://herdr.dev when it is missing), then installs the wherdr Herdr
  plugin: wherdr in `~/wherdr`, started now and with Herdr, its setup guide opened in the browser
  and **prefix+i** for its panel. On a Mac without Node.js 22 it offers `brew install node`; on
  Linux, Docker works too. A wherdr that already runs is never replaced: the script says so and
  offers its update; a `wherdr` container managed from another folder is never touched. On a
  server without a screen (or over SSH) it opens nothing and prints the address, an `ssh -L`
  tunnel and the phone steps. `WHERDR_MODE=docker` keeps the previous Docker Compose setup.
- **Herdr plugin**: `WHERDR_NO_BROWSER=1` in the environment of the install opens no browser.

- **Homebrew**: `brew install afloury/tap/wherdr`, then `brew services start wherdr` runs it now
  and at every login, and `wherdr open` opens the setup guide. The first install also brings
  Homebrew's Node.js. A Homebrew install shows `brew upgrade wherdr` in the update notice. Each
  version tag updates the formula in `afloury/homebrew-tap` when the `HOMEBREW_TAP_TOKEN` secret
  is set.
- **Animated packets** switch under Settings › Appearance › Desktop › Background › wherdr grid
  (on by default): off, the dotted grid stays still. Saved on the device.
- **Install it as an app**: README section and website block on installing the PWA from Safari
  (iPhone, Mac), Chrome, Edge, Brave and Android; Arc cannot install web apps.

### Changed

- The agent list header shows the wherdr server version next to Herdr's
  (`WHERDR 1.3.1 · HERDR 0.9.3`); a tap opens Settings › About.
- The plugin button left the agent list header: with a single machine, plugin actions are in the
  **…** menu of the machine's session row. wherdr's own plugin actions are no longer listed, and
  actions that open a pane or popup in Herdr say **Opens in Herdr**.

### Fixed

- **Claude Code settings card (`/usage`, `/status`, `/config`, `/stats`)**: recent Claude Code
  versions draw the settings panel with a key legend, so wherdr took it for an interactive menu
  and showed its text squashed on one line. The card is back: tabs read from the screen (Stats
  included, robust to a tab more or less), active tab highlighted, usage gauges with their reset
  time (an empty 0 % gauge too), the rest as readable lines without the keyboard help.
- **Stop on a Claude Code `!` command**: Claude puts the cancelled command back into its input
  field (shell mode), which kept every following message "Queued · will be sent when the agent's
  input is free". From the conversation, Stop now empties Claude's field when it holds exactly
  the command wherdr sent, and the command comes back into wherdr's field, like an interrupted
  prompt.

- **Stop on an omp `!` / `$` command**: the cancelled command no longer comes back as
  "Queued · sending…" (then "Not sent"). omp writes nothing for it before the first prompt of a
  session; seeing the run on omp's screen is now enough to take the message off the queue.

- **`wherdr` command on a Homebrew install**: `status` and `doctor` show the Homebrew service
  (`brew services`) instead of "started another way" / "not installed"; `logs` reads its log
  (`$(brew --prefix)/var/log/wherdr.log`); `start`, `stop`, `restart` and `service install` point
  to `brew services start|stop|restart wherdr`.

- **Interface language**: without a saved choice, wherdr follows the browser's first preferred
  language it speaks (English when English comes first), instead of switching to French whenever
  French is anywhere in the list.

- **No "New version available" banner right after an install or update**: a service worker left
  by a previous install on the same address, or a new version deployed while the app was closed,
  is now activated silently when the page opens (the page already runs the new build). The banner
  only appears for an update that arrives while the app is in use, so nothing being typed is lost.

## [1.3.0] — 2026-10-08

### Added

- **Herdr key for the wherdr panel**: the plugin install appends one marked `[[keys.command]]`
  block to Herdr's `config.toml` on the first free key of `prefix+i`, `prefix+u`, `prefix+y`,
  `prefix+m`, `prefix+alt+w` (never one Herdr or your config already binds), reloads Herdr's
  config and prints `Press prefix+i in Herdr to open the wherdr panel.` The panel shows the key;
  `sh scripts/herdr-plugin.sh key uninstall` removes the block.

- **Other private networks** (README): wherdr works with any private network that gives it an
  HTTPS address with a valid certificate. Headscale, NetBird, ZeroTier and WireGuard use a
  reverse proxy on the private address (Caddy, certificate from the DNS challenge) and `APP_URL`;
  Cloudflare Tunnel only behind Cloudflare Access, with an explicit warning. Settings › Phone
  links to it ("Using something else?"), and so do wherdr.dev, `llms.txt` and `agent.md`.
- **Setup guide** at first launch, a centered modal over the blurred app on a computer, full screen on a phone: what wherdr is, the
  Herdr version and the agents found on this machine (or how to start one), the phone
  (Settings › Phone's Tailscale setup), then the passkey lock and notifications. Skip is always
  there; finishing or skipping is saved on the server (`data/onboarding.json`, tied to the
  machine), so other devices do not show it again. Reopen it from Settings › About. A phone
  already on the tailnet address gets Add to Home Screen (iOS and Android) instead.
- Settings › Phone: Check, Check again and publishing now show their result next to the button,
  with the time of the check: "Reachable", or the precise cause (address not found, connection
  refused, timeout, invalid certificate, no HTTPS on the port, not https://, something else
  answering with its HTTP status). The state rows flash when refreshed. In Docker, the
  `tailscale serve` command keeps the HTTPS port of an address already published on another port.
- The Herdr plugin opens the setup guide in the browser at the end of the first
  `herdr plugin install` (`open` on macOS, `xdg-open` on Linux with a display); updates and
  headless servers open nothing, the address is printed.
- wherdr.dev: the Install section recommends a method for the visitor's system (macOS: the Herdr
  plugin; Linux: the install script) and lists the prerequisites (Herdr, Tailscale for the phone).
- **Settings › Phone** ("Use it on your phone"): live state of the phone address, checked by the
  server. Native mode: **Make wherdr reachable from my phone** runs `tailscale serve` (asked
  first; private to your tailnet), **Remove from my tailnet** undoes it. Docker: the exact
  command with Copy, then the address it printed, checked through Tailscale's DNS. Once the
  address answers, wherdr sets `APP_URL` to it (`data/app-url.json`, no restart; an HTTPS
  `APP_URL` in the environment wins) and only then shows the QR code. Known Tailscale errors
  (HTTPS certificates off, Linux operator rights, not connected, port used by another service)
  are explained with a link. Only for this computer (localhost, not through a proxy) or an
  unlocked session.
- The Herdr panel is reduced to the state, **O** Open wherdr and **P** Set up my phone (opens
  Settings › Phone); the other keys stay as a quieter fallback. `wherdr phone` prints the real
  state and that page's link. The QR code is never shown for an address that does not answer.
- `wherdr` agent skill (`skills/wherdr/SKILL.md`) for herdr-projects coordinators: the
  `TASKS.md` lists and badges the Project panel reads, `(agent → t-NNNN)`, and what to do with
  each message its buttons send. The Herdr plugin links it into `~/.claude/skills` and
  `~/.agents/skills` (Codex, omp) when those agents are installed, never over a foreign skill;
  `herdr-plugin.sh skill uninstall` removes the links.
- npm package `wherdr`, prebuilt: `npx wherdr`, `bunx wherdr` or `pnpm dlx wherdr` runs it
  without cloning or building. Installed globally (`npm install -g wherdr`), the `wherdr` command
  also has `start` / `stop` / `restart` / `status` (background server, pid and log in `~/wherdr`;
  *started* only once the port answers, otherwise the end of the log), `logs [-f]`, `open`,
  `phone` (tailnet address, `tailscale serve` command, QR code), `service install|uninstall`
  (macOS LaunchAgent or `systemd --user` unit with the absolute runtime path) and `doctor`.
  Published by `.github/workflows/npm.yml` on each version tag (npm Trusted Publishing). The
  website's install section adds npx, bunx and pnpm dlx tabs.
- Herdr plugin: `herdr plugin install` (exact command in the README) now starts wherdr at the end of the install
  (`✓ wherdr is running → http://localhost:7683`), or says why it could not without failing the
  install. One **wherdr** action opens a panel: state, local and tailnet addresses, version, mode,
  auto-start, the phone QR code, and keys S start, X stop, R restart, O open, L log, U update,
  A login service on/off, P phone setup, Q quit (also `wherdr panel`). In native mode wherdr runs
  from `~/wherdr/app`, which outlives Herdr's temporary build folder and plugin updates. The other
  actions are gone, except **wherdr: open in the browser**. The README and the website give the
  three-step path and how to uninstall (Herdr has no uninstall hook).
- `WHERDR_SERVICE_NAME` names the login service (LaunchAgent `dev.<name>`, unit `<name>.service`)
  for a second wherdr next to the usual one.
- Herdr plugin: wherdr installs with `herdr plugin install` (`herdr-plugin.toml` at the root; exact
  command in the README). It runs the published Docker image on Linux when Docker Compose works, Node.js
  22 otherwise (always on macOS), from `~/wherdr`; starts wherdr detached with Herdr unless
  something already answers on its port; and adds Start, Stop, Restart, Status, Open, Update and
  Phone setup actions. Stop only stops what the plugin started. The website's install section
  lists it as its second method, after the one-line installer.
- Settings › Conversation › Quoted replies is now a choice of how the field shows the quotes, per
  device (computer and phone): "“>” lines" (plain text, default), "Tokens, native field" (the
  plain field, its quote lines drawn as tokens: typing, dictation and autocorrect unchanged) or
  "Tokens, rich field"; both token options are marked experimental. The preview shows the chosen
  option; a former switch turned on keeps the rich field.
- Chat: images an agent's tool returned (omp `read` of a PNG, a screenshot, Claude `Read`,
  Codex `view_image`) show as thumbnails under the action, even when the action block is
  folded, and open in the image viewer. An image already shown higher up (a photo you sent that
  the agent reads back, even re-encoded, or the same bytes read twice) shows as a small
  "↑ Same image as above" link instead, which opens it in the viewer.
- Settings › Appearance › Desktop (computer only): Background "wherdr grid" (default) shows the
  website's dotted grid with light packets in the margins of the conversation; "herdr grid" keeps
  the flat line grid. Content width moved here from Settings › Desktop. Phones show no grid.
- Component tests (Vue components mounted in a Nuxt environment) and end-to-end tests in
  Chromium and WebKit, at iPhone and desktop sizes, against a fake Herdr server.
- GitHub Actions CI on pushes and pull requests to `main`: unit, component and end-to-end tests,
  type check and leak check.
- herdr-projects New project: choose the agent profile of the coordinator and of the threads
  (Claude, omp, your own profiles…) among those the plugin allows on the project's machine,
  with the plugin's defaults for new projects selected, names shown as written. Written to the
  project's `PROJECT.md`.
- herdr-projects shortcuts and menu entries, where the plugin is on the agent's machine:
  `Mod+Alt+P` shows or collapses the Project panel of the current agent's project (opens the
  coordinator from a thread), `Mod+Alt+Shift+N` opens New project. Agent menus, agent cards and
  the project's header in the list get a Projects section: the Project panel, New project…,
  Continue as a project…, Pause this project… and Check herdr-projects setup.

### Changed

- **Plugin action renamed** `wherdr` → `panel` (`afloury.wherdr.panel`). Herdr has no action
  aliases: change a key bound to `afloury.wherdr.wherdr`; the install warns about one.

- Quoted replies as tokens in the field are marked experimental and are now off by default on a
  computer too (Settings › Conversation › Quoted replies).
- The crossed-out bell of the agent list (do not disturb on) now opens Settings › Notifications
  instead of turning notifications back on at once.

### Fixed

- omp: changing the model from the field no longer fails with "omp's model selector did not show
  up" when the pane is narrow (left at the phone terminal's width, typical of an SSH machine
  with no Herdr client attached). omp then cuts the model ids and the footer; wherdr now widens
  the pane for the time of the choice and gives it its width back, or says the terminal is too
  narrow (wherdr's terminal still open). omp's `ascii` symbol preset is read too.

- Settings › Phone right after publishing: while Tailscale gets the HTTPS certificate (timeout,
  TLS error or refused connection during the first 90 seconds), the address shows a loader,
  "Getting the HTTPS certificate from Tailscale…", and is checked again every 4 seconds, instead
  of a red error under green rows. The result next to the button now follows the same state as
  the rows, and the QR code only appears once the address really answers. A published address is
  allowed as a host at once, so the first scan never lands on "Host not allowed".
- A browser opening an address wherdr does not allow yet now gets a short page in English and
  French saying what to do, instead of raw JSON; API requests keep the JSON error. The page
  reveals neither the allowed hosts nor APP_URL.
- Agent list header: with plugin actions and do not disturb on, the last buttons were cut off in
  a narrow sidebar. The title now shrinks first, then the plugin, settings and bell buttons move
  into a “…” menu as needed.
- Herdr plugin, native mode (macOS): Start failed when Herdr's server `PATH` did not contain
  node (n, nvm, fnm, Volta…) yet said “started”. The install now saves the absolute path of node
  (or Bun) in `~/wherdr/plugin.env` (`WHERDR_RUNTIME`), Start looks in the usual folders when it is
  gone, and reports success only once the port answers, with the end of the log otherwise. The
  install downloads the prebuilt npm package of its version when it exists instead of building.
- Claude Code's `/config`, `/status` and `/usage` results highlight the active settings tab again:
  the tab Claude Code now draws in reverse video (seen under Herdr 0.9.3) is recognized.
- Remote (SSH) machines: busy machines no longer show "Connection closed by UNKNOWN port 65535",
  "Conversation not up to date" or "Threads unavailable". wherdr keeps its reads under sshd's
  session limit per connection (`MaxSessions`, 10 by default), leaving room for terminals,
  shares identical reads already running and retries a refused session. A quota read that fails
  no longer shows "not set up / Install": the last reading stays, as do the project's threads.
- omp with nerd-font or ascii symbols (`symbolPreset`): a running `!` command shows the Stop
  button again, and Stop or Escape cancels it; the working step, the tool approval dialog and the
  model selector are read with every symbol preset.
- An action waiting for its approval no longer shows the finished-turn line ("✓ 2 s · 1 action"):
  it stays in progress until it is approved.
- Phone: bottom sheets (the "…" menu, confirmations, command and plugin results) close with a
  tap on their handle or a swipe down from the handle, the title or the list scrolled to its top;
  they stop at 85 % of the screen height, leaving room above to tap outside.

- A long "!" command sent to Claude Code no longer also stays below as a "Queued" bubble while it
  runs: the screen wraps it (mid-path), and the wrap no longer hides that it is the same command.
  Codex "!" commands now show as command blocks with their output, and their bubble goes away.
- "/" menu of the input field: on an SSH machine, the skills and commands (user and project)
  are read in one SSH session instead of one per folder and file, a refused session is retried
  once, and if they still cannot be read the built-in commands show (asked again on the next
  "/") instead of no menu at all.

- omp: a new conversation (no message yet) now shows its model and effort in the field, read
  from omp's status line, and both can be changed from there. After a turn, "auto" shows the
  level omp picked ("auto · low", and "This turn: low" in the menu) instead of a bare "auto".
  The model selector also works with omp's nerd-font symbols and its 18.6 Task-model toggle.

- Messages sent to omp while it shows a tool approval dialog ("Allow tool: eval", bash, MCP…)
  are no longer typed into the dialog and lost (their Enter could even approve the tool): typed
  replies and Project panel buttons (Reviewed, Tested, Launch, Unblock…) are held and delivered
  once the dialog is answered and omp's input field is back.
- omp's tool approval now shows in Conversation as a "Your turn" card: the tool, its full input
  (folded when long) and the dialog's buttons (Approve, Deny…), instead of "details in the
  Terminal tab".
- The model and effort under the input field no longer turn into a bare "Model" when reading the
  transcript briefly fails (SSH machine connection dropped, timeout): the last known value stays.
- An omp `!` or `$` command sent while omp is working no longer stays "Queued · sending…" (then
  "Not sent", inviting a second run): omp runs it at once but records it only when the next prompt
  starts, so its bubble now goes when that turn ends; the "You ran" block shows once omp records it.
- Pasting an image (`⌘V` on a Mac) into a terminal, full view or side by side, now reaches the
  agent: it is uploaded to the agent's machine and its path pasted through Herdr, which omp and
  Claude Code attach as an image. Before, the terminal only pasted text and the image was lost.
- The installed app no longer opens on a blank screen when its server accepts the connection but
  never answers (a phone on a tailnet whose wherdr host is gone): it shows the app from its cache
  after 3 s, then the last known state, and goes live once the server answers again.

## [1.2.0] — 2026-10-05

### Added

- Full omp conversations: transcripts, reasoning, tool actions and results, status line,
  questions, slash commands, shell commands, model and thinking controls, restart, and branding.
- wherdr Titanium, Graphite and Neon Purple themes, plus omp themes and a configurable animated
  composer focus border.
- Compact home list with one line per agent or space; more desktop shortcuts and a collapsible
  agent sidebar.
- Replies to several agent questions or selected passages in one message, with optional quote
  tokens in the composer.
- Run or copy shell commands from an agent's reply, with confirmation before running them.
- File attachments for supported document and code formats, alongside photos.
- Zoom and pan in the conversation image viewer; clickable links and Nerd Font icons in terminals.
- Codex update and weekly-limit notices, including an update path through the agent's terminal.
- Published multi-architecture Docker images and an in-app notice when a new wherdr release is
  available.
- Passkey maximum unlock age and **Lock all devices**; per-machine thread limits for
  herdr-projects.

### Changed

- Sent messages appear in the conversation immediately, with clear queued, sending and failed
  states; queued messages retain their attachments and send in order.
- Project cards and task lists better reflect coordinator tabs, thread queues and review status.
- Context menus open as bottom sheets on touch screens; phone sheets and desktop pane controls
  are easier to use.
- Terminal selection uses on-screen xterm selection again; wrapped lines copy without added
  line breaks.
- The passkey session's 12-hour timeout now measures inactivity instead of time since unlock.

### Fixed

- Claude Code sends no longer merge with text from another writer, and messages wait while an
  interactive menu occupies the agent's input.
- omp startup messages, shell command bubbles and Stop behavior; queued first messages and
  photos can be recovered when cancelled.
- Direct links to tabs, remote conversation reads, and pane state during server reconnection.
- Permission and question cards in short panes, plus keyboard handling for interactive cards.
- iPhone sheet placement, terminal and console overflow, and image and file display edge cases.

### Security

- Reject API calls initiated from another site and reject unknown or SVG conversation images.
- Leak checks can scan every commit in a range; test fixtures no longer use captured machine names.

## [1.1.0] — 2026-09-28

### Added

- Reorder machines, identify the local machine and keep a remote machine awake.
- Silence notifications per device; show a **Blocked** list in the project board.
- Create herdr-projects projects from wherdr with a clearer setup flow.

### Changed

- Show Herdr space names on cards and the full installed version in the header.
- Improve project action input, backlog handoff and worktree close confirmation.

### Fixed

- Correct Claude Code effort changes and their displayed value.
- Keep desktop composer controls clear of terminals and hide internal project markers.
- Make leak checks work from a Git worktree.

## [1.0.0] — 2026-09-27

First public release.

### Added

- Live agent list with answer previews and one-tap replies to permissions and questions.
- Claude Code and Codex conversations with Markdown, tool calls, images and search; live terminal
  view with mobile keys; composer with queued messages, photos and slash commands.
- Per-session model and effort controls; new agents, folder browser, Git worktrees, changes view
  and global search.
- Multiple machines and Herdr sessions, herdr-projects grouping, and Claude and Codex quotas.
- Web Push notifications, offline reading, passkey lock, themes, and English and French layouts
  for desktop and phone.
