wherdr 3.2.1 brings back the **split terminal** on v3 and fixes **scrolling in an agent's Terminal view**: the wheel and touch scroll Claude Code's fullscreen view again, and a fast scroll is now smooth. It also brings a clearer Autopilot window, questions and choices cards that stay answerable, *N shell running in the background*, Claude's activity verb back in the status line, 12 project colors with dashed badges for workspace members, a workspace coordinator that can finish its members' steps, and three batches of minor fixes from bug hunts. Update as usual: the banner's *Update with Alfred*, or `update.sh 3.2.1` in the install folder; no manual step is needed.

## New

**The split terminal is back.** A pane's **…** menu offers *Split right*, *Split down* (a shell in the same folder, in the same tab) and *Split with agent…*, which opens the New agent sheet on that machine and folder and puts the agent to the right. On a computer, Mod+Alt+S splits right and Mod+Alt+Shift+S splits down, from the terminal too, and both can be changed in Settings › Shortcuts. Drag a divider to resize, double-click it for 50/50. The layout is wherdr's own and shows the same on every device; herdr-app keeps its own. [Terminal](https://github.com/afloury/wherdr/blob/v3.2.1/docs/terminal.md)

**12 project colors.** Cyan, lime, indigo and magenta join the palette, and a new workspace member gets the color least used among its workspace's members. A member's badge now has a dashed border wherever its key or task id shows, so it no longer looks like a top-level project's. Existing colors never change. [Workspaces](https://github.com/afloury/wherdr/blob/v3.2.1/docs/workspaces.md)

## Fixed

**Scrolling in the Terminal view.** Claude Code now draws a fullscreen view that has no local scrollback, so the wheel and touch did nothing in its Terminal view. They now scroll it again, as they do any program that tracks the mouse; other programs keep the local scrollback. [Terminal](https://github.com/afloury/wherdr/blob/v3.2.1/docs/terminal.md)

**Questions and choices cards stay answerable.** A card no longer locks when the agent writes another message below it, after a wake or a report: it stays live until you answer it, then shows your reply. [Conversation](https://github.com/afloury/wherdr/blob/v3.2.1/docs/conversation.md)

**Home.** A workspace member's tasks, Tasks to review included, show only on its workspace's tabs. On the phone, Home scrolls to the very bottom under the floating *+ New* instead of stopping above a blank band.

**Messages.** A message is never typed over a paste in progress or a field that could not be read, never typed twice after a lost connection, and a message ending with `\` is recognized once sent. Every send answers within the app's 2-minute deadline.

**Engine and workspaces.** The engine keeps trying until herdr-core answers instead of giving up after 5 minutes, one paused task's failed resume no longer stops the others, and a chained task held by the autopilot's limits says why on its card. Alfred's commands reach a member's workspace coordinator, and a failed feature split leaves no half-written sub-tasks.

**Settings, notes and plugins.** Settings and notes files are written in turn and never over a file that could not be read. A note's web badge opens in a new tab, and a network blip no longer reads as a missing file. A plugin update clears an earlier failure and reloads all of its files, and an install refuses a fork's commit served under another repository's name.

## Improved

**Smooth fast scrolling.** A fast trackpad flick through a long Claude conversation used to jerk, overshoot and could land at the top in one gesture. Scrolling is now paced on Claude's repaints and matched to its acceleration, so it moves about as far as your gesture. Slow scrolling still moves one row at a time. [Terminal](https://github.com/afloury/wherdr/blob/v3.2.1/docs/terminal.md)

**Autopilot window.** The autopilot's switch and state sit above the *Settings* and *Activity* tabs, so it can be turned on from either. *Run now* is now *Wake now* and says what it does, *Every* says that empty means no timed wake and that a timed wake is skipped while nothing is new, and the goal is marked optional. [Autopilot](https://github.com/afloury/wherdr/blob/v3.2.1/docs/project-management.md#autopilot)

**What the agent is doing.** A working conversation's status line shows Claude's own verb, such as *Orbiting…*, and omp's running step again. When Claude's turn is over but a shell it started still runs, it says *1 shell running in the background* instead of *Claude is working…*. [Conversation](https://github.com/afloury/wherdr/blob/v3.2.1/docs/conversation.md)

**The workspace coordinator on its members' tasks.** A workspace's coordinator can now end or send back a step, decide after send-backs and merge on a member's task, under the same rules as on the workspace's own. A member's own workflow stays yours to change. [Workspaces](https://github.com/afloury/wherdr/blob/v3.2.1/docs/workspaces.md#the-workspaces-coordinator)

**Installer and updates.** Running the installer again keeps the release you updated to instead of moving back to the tip of `v3`, and with auto-deploy `update.sh <version>` installs the latest prebuilt build instead of failing.

[Full changelog](https://github.com/afloury/wherdr/blob/v3.2.1/CHANGELOG.md)

Join us on Discord: https://discord.gg/ky36WYmtVE
