wherdr 3.1 adds **workspaces**, one coordinator for several repositories. Alfred now passes your requests to the right project's coordinator and gives briefs, themes get Dark, Light and System modes with custom themes, and keyboard shortcuts can be changed. It also fixes several conversation and engine problems, including two that users reported. Update as usual: the banner's *Update with Alfred*, or pull and rebuild; no manual step is needed.

## New

**Workspaces.** A workspace is one coordinator for several repositories. Create one from *Settings › Projects › Add workspace* or ask Alfred; it shows as a row in the sidebar under its tab group, with its members' badges and their tasks working and waiting for you. A feature that spans repositories is one card on the board, with its sub-tasks, their order and what they wait for, and Tasks to review groups them. The workspace's root `AGENTS.md` / `CLAUDE.md` reach every member task's worker and reviewer, and each member inherits, ignores or replaces them. The workspace's coordinator never edits a member repository itself: it sends code changes through tasks. [Workspaces](https://github.com/afloury/wherdr/blob/v3.1.0/docs/workspaces.md)

**Alfred routes your requests.** Ask Alfred for something in a project: it finds the project (with choices when unsure), passes your request to its coordinator, and tells you which task it created. [Requests about a project](https://github.com/afloury/wherdr/blob/v3.1.0/docs/alfred.md#requests-about-a-project)

**Briefs.** Alfred knows your home tab groups and the open tab. Ask for a brief of this group, another one or all of them, or a daily brief: what merged, what waits for you and for what, what is stuck. [Briefs](https://github.com/afloury/wherdr/blob/v3.1.0/docs/alfred.md#briefs)

**Themes, dark and light.** Each theme has a dark and a light palette, and *Settings › Appearance* picks Dark, Light or System, which follows the device live; the terminal follows too. The wherdr themes (without Neon Purple), the agent themes, Vesper, Gruvbox and Kanagawa stay; Catppuccin Latte and omp Light now open as Titanium and omp in Light mode.

**Custom themes.** *Create theme* starts from a copy of any theme: change its main colors and terminal palette for Dark and Light, with a live preview and a contrast check. Custom themes sync to your devices, and export or import as JSON.

**Keyboard shortcuts.** *Settings › Shortcuts* gives any shortcut new keys, refuses keys another shortcut already uses, and resets one or all. Tooltips, menus and the help follow your keys on every device. [Computer, phone and iPad](https://github.com/afloury/wherdr/blob/v3.1.0/docs/devices.md)

**Pages and images shown by agents.** An HTML page an agent shows renders beside the conversation in a sandboxed frame, with *Preview* and *Source*. A tap on a shown image opens the zoomable viewer.

**One login incident.** When a Claude or Codex login expires, Home shows one notice per machine and account, instead of a question per task. Once you log in again, the stuck agents restart one by one and are told to continue where they stopped.

**Browser demo.** A v3 browser demo shows Alfred, coordinators, the board, Tasks to review and Notes with made-up data, and the README animation and launch film are recorded from it.

## Improved

**Conversations.** A coordinator's folded routine checks get a summary (merged, waits for you, quiet) and one readable line per wake. A '!' command run from a reply shows at once as a live card with a *Running* line, and every '!' block gets *Run*.

**Settings and sheets.** The project sheet saves each field by itself, after typing or on leaving it, with a discreet *Saved*. Settings in the side panel show section names when there is room and an icon rail otherwise; previews fold under *Show me*; *Add machine* opens a sheet with a confirmation. The Tasks to review filter shows how many tasks wait under each group and project.

**Tasks.** An agent you are writing to is kept 30 minutes after your last message, and writing to a released agent brings it back. Screenshots of a visual task are tied to its final commit, and a send-back asks the worker to retake only the screens its changes affect. A coordinator's step back sends a task waiting for you back to its worker with your words. With no working branch set, a task starts from the branch its workflow opens PRs to.

**Claude quotas.** Claude Ultra accounts no longer show a 5-hour window, which they do not have; Pro and Max keep it.

**Workflow proposals.** A coordinator's workflow proposal no longer opens Settings by itself: accept it from the card in the conversation, or from the proposal row on the project's Workflow tab.

**A second v3 install** keeps its own project-management folders, and its uninstall removes them.

## Fixed

**Blank home list with the old *Compact list* setting** ([#857](https://github.com/afloury/wherdr/issues/857)). The *Compact list* and *Show terminals* settings are gone and their stored values are cleared, so every home row shows its default look.

**Codex conversations on the shared daemon** ([#810](https://github.com/afloury/wherdr/issues/810)). A local Codex attached to the shared app-server no longer shows *No conversation* on an older thread: wherdr reads that daemon's history page by page. Thanks to [@Ovalene2333](https://github.com/Ovalene2333) for the fix.

**Conversations.** A remote agent's turn no longer disappears after a very long line, such as a large screenshot. A conversation search no longer stops at the first line larger than its read window, such as a screenshot (thanks to [@followcat](https://github.com/followcat)). A message with several photos sent to Claude, working or idle, is submitted instead of staying in its input (even while Claude still shows *Pasting…*, and after a wherdr restart mid-send), and is not shown twice. A '!' command run while Claude works runs once and shows once. A run's task badges wrap inside the row, and the conversation never scrolls sideways.

[Full changelog](https://github.com/afloury/wherdr/blob/v3.1.0/CHANGELOG.md)

Join us on Discord: https://discord.gg/ky36WYmtVE
