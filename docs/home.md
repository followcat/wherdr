# Home and agent list

[Documentation](README.md) · [Project](../README.md)

## Features

### Agents on herdr-core

- **Live list** of every hc terminal, on this machine and on each core machine, refreshed from
  core's events. Terminals are placed as herdr-app places them: by their `herdr.space` /
  `herdr.tab` labels, else by the tab of the machine's herdr-app layout that holds them (space
  and tab names and the tab order come from it). Other terminals are grouped by machine and
  folder. Details in [herdr-core › Inventory](core.md#inventory).
- **States**: three only: **Your turn** (blocked: a question or a permission), **Working** and
  **Ready** (idle or done; an agent that reports no status also counts as Ready, as in v2.5).
  A space with several terminals follows its most urgent one. Three counters at the top (your
  turn, working, ready) count what the tab lists: the same rows as the headings, plus Alfred and
  the tab's running coordinators (one waiting for your answer counts in your turn). When core does not answer, the last
  list stays visible, marked offline, and the home says **herdr-core is not responding**.
  An omp card also shows its context usage as a thin line along its bottom edge (green, ochre
  from 60 %, rose from 85 %; paler when it is the last reading); the figures are in the
  conversation header. omp's own status line, gauge and welcome screen never stand as the card's
  preview.
- **Quick answers**: a waiting agent's card shows its question and options; **answer in one tap**
  without opening it. The question is read again before the answer is sent; if it changed, the
  answer is refused.
- **Compact list**: Settings › Appearance › Home screen › **Compact list** shows one line per
  card; Normal adds the current activity on a second line. It follows you across devices.
  Every agent terminal is its own row, with its pane or tab label.
- **Task agents**: an agent the [project engine](project-management.md) started for a task keeps
  its own status, but its row is named after its task: the state square, the task id badge, the
  task title (cut when long; a pane you renamed keeps your name, in the conversation header and
  search too) and how long it has been in its state (`8 min`, `2 h`). A second line gives its
  role, then its machine (when the list mixes several) and its last message: **DEV** (working on
  the task), **REVIEW**, **FIX** (sent back by the review, red CI or you) or **CATCH-UP** (merging
  the base branch). The line starts with the small icon of the agent that runs the role (Claude,
  Codex…); a reviewer's verdict reads as a short line (`Passed, 0 findings`, `2 findings: 1 major,
  1 minor`), never its raw JSON. Several agents of the
  same task (the worker and its reviewer) share one row, in the group of the most urgent: the
  title line, then one line per agent with its own state, which opens that agent; the row's menu
  lists each agent's actions under its role. A reviewer kept between rounds shows dimmed. A
  row keeps its task look after a restart of wherdr or herdr-core: an agent is found by its
  task and role, even when it was resumed or its terminal re-attached.
- **Order**: the header (logo, version, Search, Board, Settings), the counters, the quotas (a
  machine's own quotas under them), Alfred, the [coordinators](#coordinators), then the agents of
  the machines shown, by state (Your turn, Working, Ready). When the list mixes several machines,
  each card carries its machine's name. There is no section per machine. The list never scrolls
  sideways: long titles and badges are cut with an ellipsis, and its scrollbar stays thin, shown
  while the pointer is over the list.

### Alfred

Alfred, wherdr's assistant, is always the first row of the agent list, even
with no agent and projects off. Its row is a card of its own: its emblem (the
wherdr ram in a bow tie, also in its conversation's header), *Your assistant ·
all projects*, and its state (*Not started*, *Ready*, *Working*…) with its
agent. A tap on it opens its conversation. Its card keeps a faint mauve
wash; like other rows, it looks selected (a mauve edge and left bar) only while its
conversation is the one open. It helps you get started and, with projects
on, coordinates all of them when you ask it: it has no autopilot, each
project's coordinator runs its own. The first *Start* asks which agent (Claude,
Codex, OMP…, those offered in Settings › Agents) runs it; the choice is kept, and wherdr
never changes it on its own: if that agent is no longer offered, the **Agent**
button in Alfred's conversation opens a window that says so, and you pick another there. The same window
changes Alfred's agent for its next conversation. It runs with that agent's default
model: change the model inside Alfred. Its menu (right click, or long press on a touch
screen), *Restart with…*, moves it
to another agent at once (when an account runs out of tokens, for instance): the old session
stops and the new one carries on from the same home folder, `alfred/` in
wherdr's data folder. There, `AGENTS.md` (and `CLAUDE.md`, `GEMINI.md`,
`QWEN.md`, which point to it) is wherdr's and rewritten at each start; `identity.md` (its name and tone) and `memory.md` (what it learns about
you, cleaned up at each start) are its own. Give it another name and the row
shows it as soon as its turn ends. Alfred reads and changes projects, coordinators and settings with
[`wherdr alfred`](alfred.md): it shows you each
change first and makes it only after your yes.

With no project yet, Alfred's first message also offers to set up the first one
with you: here, one question at a time, or in the setup window, which it can open
for you (Settings › Projects › *Set up a project*). A user coming from wherdr v2 gets
the offer to set up their v2 projects instead. Home's empty list says so too: *Set up
a project with Alfred* opens Alfred's conversation with the setup asked of it, and
*Open the setup window* opens the same window.

### Coordinators

Under Alfred, while project management is on, one row per running project coordinator, its
project's key badge in the project's color, then its name: the project's, unless you named it
in the project's General tab (*[WHR] wherdr*; the tooltip reads *Coordinator of wherdr*)
([Project management](project-management.md)). A tap opens its conversation, shown as selected
while it is open. A coordinator whose terminal ended (its machine restarted, say) stays, marked
*Stopped*: a tap offers *Resume the conversation* (its last one, with the agent that ran it and
the same options) or *New conversation*. Its menu (right click on a computer, long press on a
phone, where it opens as a sheet) offers, in order: *Open the board* (filtered on its project),
*Project settings* (its General tab), *Autopilot* (its tab, with a check while autopilot is on),
*Rename…* (an inline field; empty gives it its project's name back), *Mute notifications* /
*Unmute notifications* (the conversation header's levels, kept across its restarts), *Restart
with…*, which picks another agent that becomes its default (its folder and memory stay, the
current session stops), and *Stop the coordinator*, after a short confirm: its agent ends and it
starts again on the next message or wake. Mute and Stop show while it runs. Alfred's row keeps
its own menu. A coordinator shows only in its own row, never again among the agents.

Coordinators and **Tasks to review** follow the [machine tab](#machines-as-tabs): a tab shows the
projects whose allowed machines it holds (a project on machines of several groups shows on each
of those tabs), **All** shows every project, and Alfred shows on every tab. An open coordinator
conversation stays open on the tabs that show its project. The board follows the tab too when
its picker is on *Follow machine tab* ([Board](project-management.md#board)); notifications stay
global.

### Tasks to review

Under the coordinators, while something waits for you on the tab's projects, one **Tasks to
review** card with its count: tasks to approve, an agent's question, a failure to try again, a
decision. Under its title, the ids of the first ones as their project's key badge, in its color, on
one line (… when they do not all fit). A tap opens them one at a time (a sheet on the phone), with Approve, Reject and each
item's own answers
([Tasks to review](project-management.md#tasks-to-review)).

### Offered agents

Settings › Agents › **Offered agents** is the one list behind every agent choice: the New
sheet, a project coordinator's agent, Alfred's. Uncheck a program to hide it everywhere; drag
a row by its ⠿ handle (or use its arrows) to reorder: the first is the default and comes first
in every picker. Programs only: each starts with its own default model, changed inside the
agent. Alfred runs with any of Claude, Codex, OMP, Pi, OpenCode, Kimi, Gemini CLI, Qwen Code,
Copilot, Amp and Droid (other programs are left out of its picker: wherdr knows no instructions
file they read). A project's coordinator runs with Claude or Codex only: they are the ones wherdr
can keep out of the project's repository (a deny rule for Claude, the sandbox for Codex). Choices and order follow you on every device.

### Proxies

Settings › Agents › **Proxies** keeps named proxies on the server (every device shares the list):
a name, a URL (`http://`, `https://` or `socks5://`, optionally `user:pass@`), an optional
comma-separated bypass list, and the machines it is offered on (all by default). Entries can be
added, edited, deleted and reordered. A password never comes back: the list shows
`user:•••@host:port`, and an edit that leaves `•••` keeps the stored password.

A proxy is **machine-relative**: `127.0.0.1:7890` names that machine's own proxy. The one picked
in the New sheet — or the machine's remembered choice for paths without a picker (a new tab like
the current one, a task's worker, reviewer or coordinator) — reaches the program as environment
(`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`, upper- and lowercase), never in its command
line, so it stays out of titles and argv.

### Machines as tabs

The **machine tabs** at the top of the list are **All**, then one tab per machine (the host, the
machine wherdr runs on, shown by its host name with a **HOST** badge, and each core machine,
online or offline) with its count: the total of its counters (its rows,
Alfred and its coordinators). A tap shows that machine alone, with its projects' coordinators
and tasks to review,
with its Claude and Codex quotas at the top; an offline or reconnecting machine says so there.
The tabs hide when they would show a single machine. A machine's actions (New agent here, Keep awake,
Reconnect, Machine settings) open on a right click or long press of its tab. With the tabs hidden,
the list shows no machine chips while every machine is online: the New sheet picks the machine.
An offline or reconnecting machine gets one compact line at the bottom (state, name, known
agents) with **Reconnect**. Claude quota setup lives in Settings › Agents only.
Settings › Appearance › Home screen › **Machine tabs** orders the tabs, hides some of them, or
hides them all. In **Groups**, create a named selection of machines; groups follow you across
devices; deleting a group puts the projects shown in it back to Automatic.
Machines themselves are managed in [Settings › Machines](machines.md#manage-machines).

A project's coordinator and its tasks to review show on the tabs holding one of its machines
(**All** shows every project); a machine paused for the project counts only while one of its
tasks still runs there. The project sheet's **Shown in** (General tab) keeps it on one
group or on all tabs instead ([General](project-management.md#general)). Push notifications are
not filtered by tab; the board is, when its picker follows the machine tab.

### New agents and tabs

- **New** opens a sheet: an agent (Claude Code, Codex…, those installed on that machine and offered
  in Settings › Agents, in the order set there: the first is preselected) or
  a plain terminal, the machine (the current machine tab's first online machine; on **All**, or
  when none is online, the host), a folder (recent folders, a folder browser, Git detection), a
  name, **resume** the last conversation, and an optional first message. The terminal is started
  by core in that folder; it joins the space whose folder holds it, else a new space.
  With saved proxies (below), a **Proxy** picker offers **None** plus the entries of the chosen
  machine; the last choice on that machine is preselected, and remembered on the server at launch.
- **+** in a space's tab row starts at once a terminal like the space's current one (same kind,
  same folder) in a new tab of that space. The new terminal carries the space's labels, so it
  also appears in herdr-app.
- A tab's menu (right click, or long press on its chip) has **New tab like this one** (same kind
  and folder as that tab, when its folder is known), **New tab…** (opens the sheet), **Rename
  tab** (a tab of one terminal not named in herdr-app's layout: the name is stored as that
  terminal's name in core) and **Close tab**.
- A space's menu (right click, or long press on its card; on an agent's row, its Space group)
  has **Close space**, except for a project coordinator's or a task agent's space: its project
  manages it.
- Close tab and Close space first say how many terminals stop and how many agents are
  interrupted, then close each terminal as **Close this terminal** does; one that could not be
  closed is named, the others close all the same. Closing an agent's pane ends its program.
- Split and move of tabs stay in herdr-app.
- Worktrees are v2 only.

### Search

The magnifier (⌘K / Ctrl+K) searches every agent and the conversations of the Claude Code and
Codex agents of online machines. Choosing a result opens it.

### Notes

The note button in the header (Mod+Alt+P on a computer) opens the [notes](alfred.md#notes)
Alfred and the coordinators write for you: read-only, a short whiteboard. On a computer of
at least 1280 px they open beside the conversation or Home's list, like Settings (drag the panel's left edge
to resize it); otherwise in a sheet. They follow the home tab by default (**Follow
tab**), with a muted line saying which (*Work · following the tab*); the menu at the top shows
**All** or one tab instead (every group and every machine shown as its own tab, in the bar's
order), and the choice follows you across devices. A tab shows its own notes and the ones
scoped All; a group's tab also shows the notes of its machines, so a machine's note stays
there when the machine joins a group. A tab with no note of its own says so (*No notes for
Work yet*) above the All notes. Each note shows its title, its
scope and its lines: checkboxes you cannot tick, project key badges (a task id opens its
sheet), the agents' own badges, and links. A link to a place in wherdr opens it in place, a
link to another note scrolls to it. A link to a Markdown file the agents wrote under the
notes folder (`plans/x.md`, see [notes file put](alfred.md#notes)) opens it rendered in the
same panel or sheet, with a back arrow to the notes; a long file scrolls there. Links in the
file work the same way, relative to it (`steps.md`, `../other-note.md`), never outside the
notes folder. A link that leads nowhere, or outside the folder, is muted; its tooltip says why. An agent's change shows
within a few seconds, without a reload.

### Also

**Quotas** (remaining Claude and Codex usage, see [quotas](quotas.md)), **notifications**
([Notifications](notifications.md)), the **passkey lock** (Face ID, Touch ID, Windows Hello,
Android…) and optional [wherdr plugins](plugins.md#wherdr-plugins).

Herdr sessions and Herdr plugin actions are v2 only.
