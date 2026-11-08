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
  turn, working, ready) count the same rows as the headings. When core does not answer, the last
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
- **Group by**: Settings › Appearance › Home screen › **Group by** chooses **Machine** or
  **State** (Your turn, Working, Ready across online machines).

### Alfred

Alfred, wherdr's assistant, is always the first row of the agent list, even
with no agent and projects off. It helps you get started and, with projects
on, coordinates all of them. The first *Start* asks which agent (Claude,
Codex, OMP…, those offered in Settings › Agents) runs it; the choice is kept. It runs with that agent's default
model: change the model inside Alfred. Its ••• menu, *Restart with…*, moves it
to another agent (when an account runs out of tokens, for instance): the old session
stops and the new one carries on from the same home folder, `alfred/` in
wherdr's data folder. There, `AGENTS.md` (and `CLAUDE.md`, `GEMINI.md`,
`QWEN.md`, which point to it) is wherdr's and rewritten at each start; `identity.md` (its name and tone) and `memory.md` (what it learns about
you, cleaned up at each start) are its own. Give it another name and the row
shows it. Alfred reads and changes projects, coordinators and settings with
[`wherdr alfred`](alfred.md): it shows you each
change first and makes it only after your yes.

### Offered agents

Settings › Agents › **Offered agents** is the one list behind every agent choice: the New
sheet, a project coordinator's agent, Alfred's. Uncheck a program to hide it everywhere; drag
a row by its ⠿ handle (or use its arrows) to reorder: the first is the default and comes first
in every picker. Programs only: each starts with its own default model, changed inside the
agent. Alfred runs with any of Claude, Codex, OMP, Pi, OpenCode, Kimi, Gemini CLI, Qwen Code,
Copilot, Amp and Droid (other programs are left out of its picker: wherdr knows no instructions
file they read). A project's coordinator runs with Claude or Codex only: they are the ones wherdr
can keep out of the project's repository (a deny rule for Claude, the sandbox for Codex). Choices and order follow you on every device.

### Machines as tabs

The **machine bar** at the top of the list has **All**, then one tab per machine (this core and
each core machine, online or offline) with its count of rows. A tap shows that machine alone,
with its Claude and Codex quotas at the top; an offline or reconnecting machine says so there.
Settings › Appearance › Home screen › **Machine bar** orders its items, hides some of them, or
hides the bar. In **Groups**, create a named selection of machines; groups follow you across
devices. Machines themselves are managed in [Settings › Agents › Machines](machines.md).

### New agents and tabs

- **New** opens a sheet: an agent (Claude Code, Codex…, those installed on that machine and offered
  in Settings › Agents, in the order set there: the first is preselected) or
  a plain terminal, the machine, a folder (recent folders, a folder browser, Git detection), a
  name, **resume** the last conversation, and an optional first message. The terminal is started
  by core in that folder; it joins the space whose folder holds it, else a new space.
- **+** in a space's tab row starts at once a terminal like the space's current one (same kind,
  same folder) in a new tab of that space; **New tab…** in the tab menu opens the sheet. The new
  terminal carries the space's labels, so it also appears in herdr-app.
- Rename, close, split and move of spaces and tabs stay in herdr-app. Closing an agent's pane
  from wherdr ends its program.
- Worktrees are v2 only.

### Search

The magnifier (⌘K / Ctrl+K) searches every agent and the conversations of the Claude Code and
Codex agents of online machines. Choosing a result opens it.

### Also

**Quotas** (remaining Claude and Codex usage, see [quotas](quotas.md)), **notifications**
([Notifications](notifications.md)), the **passkey lock** (Face ID, Touch ID, Windows Hello,
Android…) and optional [wherdr plugins](plugins.md#wherdr-plugins).

Herdr sessions, Herdr plugin actions and keep-awake are v2 only.
