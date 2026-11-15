# Claude and Codex quotas

[Documentation](README.md) · [Project](../README.md)

## Claude and Codex quotas

The home screen shows what is left of the Claude and Codex usage limits (5-hour window and
week, with reset times), for every online machine. wherdr reads each machine's quota files: this
machine's from disk, a core machine's through `machine.exec`, with a 30-second cache.
An account shared by every online machine shows once at the top. Otherwise the machine quotas
come as one block per account (Claude or Codex): its name and the machines that share it as small
chips on the same line (`Codex a0fa` `machine-a` `machine-b`, the chips wrapping only when the line
is full), then its 5-hour and weekly bars with their reset times, or
**Limit reached · resets …**. A machine whose account is unknown (Claude on API billing, an older
reading without an account key) keeps a block of its own, titled with the machine's name.

- **Codex**: nothing to do, Codex writes its limits in its session files. Machines on different
  Codex accounts get one block each (told apart by a short hash of the account ID found in the
  session files; `~/.codex/auth.json` is never read). Codex only writes that account ID in
  conversations created with a ChatGPT login by a recent Codex version. A reading without it
  joins another machine's reading only when both show the same 5-hour window and the same
  weekly window (resets within a minute, week already started), a sign of one account: the
  machines then share one Codex row at the top, like Claude. A machine idle for hours shows a
  5-hour window that has ended: it is then left out of the comparison, and the same weekly window
  plus the account ID that machine last showed are enough. An account ID once read stays known
  when a later read of the file fails. Otherwise it stays under its own
  machine and is never merged with another conversation or machine. A new conversation identifies an account switch even before it
  logs limits; until a reading for that account is available, no Codex gauge is shown. Remembered weekly limits cannot cross account
  identities. Without a known fingerprint, remembered weekly corrections are not reused,
  even on the same machine. Session files are read from `~/.codex/sessions`.

  **Limit reached** shows while the reading says Codex hit its limit and its reset time is ahead
  (no reset time given: for 5 hours after the reading). Once that reset has passed, the row
  reads **Reset since the last reading**, never blocked, and automatic work is no longer held.
  When Codex's session files say the account has credits (`rate_limits.credits`: a balance, or
  unlimited), the row shows them (**Credits: 120 credits**), and a reached limit reads
  **Limit reached · work goes on with 120 credits**: automatic work is not held either.
- **A value no longer known** (its window has reset since the reading, or the reading is older
  than the window lasts: 5 hours, a week) shows **?** on a dashed bar, at the same height as any
  row; hovering it, or tapping it on a phone, says **Last read 2 d ago: send a message to a Codex
  agent to refresh** (Claude rows the same, with a Claude agent). Nothing is written under the row.
- **A failed read** (a machine's files could not be read, a core machine slow to answer) keeps that
  machine's last good reading, with its own age, for as long as the reads fail: a refresh never
  swaps a fresh value for another machine's old one, nor splits a shared account into per-machine
  blocks. Each window turns to **?** once that reading is older than the window lasts, so an old
  value never passes for a current one. Kept readings never count for the pace.
- **Claude Code** only gives them to its status line. On each machine, install wherdr's
  invisible status line (it displays nothing, and chains to your existing status line if you
  have one):

  ```sh
  sh scripts/install-claude-statusline.sh
  ```

  The app offers the same thing in **Settings › Agents › Claude quotas**: each machine with
  Claude, its state (set up, installed, update available, not set up), **Install** or **Update**
  (on a core machine, through `machine.exec`, the installer on its stdin) and **Copy command**. The home list never suggests it: no banner, no menu item. Skipped or declined, it is no
  longer suggested on any device (`data/claude-quotas.json`); Settings still offers it. A machine
  whose quotas show from an older status line reads **Update available**, never "not set up".
  Quotas show after the next exchange with a Claude agent. The status line stores the limits in `~/.cache/herdr-web/claude-status.json`
  and a short hash of the account ID (never a token or email) to tell accounts apart. The hash
  and observation time are stored together with the limits in one atomic snapshot, so a
  new login takes effect on the next status-line update. Machines sharing a known account
  use its newest snapshot; an unknown identity never overrides a known account. A failed
  Claude read is retried once.
  Failed attempts are logged with the machine key and error code, without account data.
  After upgrading from the older status
  line, rerun the install command on each machine (or use **Install**) and exchange a message
  with Claude to produce the new snapshot. The status line also requires `python3` in Claude’s
  `PATH` at runtime.

  **API billing** (API key or Anthropic Console credits): Claude Code passes no rate limits, so
  once a session has had an API response the status line keeps its snapshot without them, and
  the machine reads **API usage (no quota)** in Settings and *Claude · API usage, no quota* on the
  home screen (no gauge, no setup prompt); switching back to a subscription shows the gauges
  again after the next exchange. Status lines installed before this need **Update**.

  **New machine**: run `sh scripts/install-claude-statusline.sh` on it once (or **Install** in
  Settings › Agents › Claude quotas), then send a message to any Claude agent there; its quotas
  appear on the home screen.

## Pace

Needs: [Claude and Codex quotas](#claude-and-codex-quotas).

**Settings › Agents › Pace** (also from a project's Autopilot tab) has one row per quota account:
its weekly use against a target line, today's use, the 5-hour window, its name, and whether
automatic work may start now. Its **mode** sets the line: **Free** (the default for a new
account: no line and no reserve, automatic work stops only when the account hits its own 5-hour
or weekly limit; no mode settings), **Free with reserve** (no line: it keeps a weekly reserve
per day left and a 5-hour reserve), **Every day**, or **Working days** (the days you pick). Automatic
work (the autopilot, automations) waits while an account is ahead of its pace; your own starts
never wait. An account with no quota reading is held by task-count limits only. A Codex row also
shows the account's credits, and **Limit reached · work goes on with …** or **Limit reset since
the last reading** when its reading says so. Each machine's
memory state shows below ([Machines](machines.md#manage-machines)).

**End-of-week burn** (under **Mode settings**, per account, in every mode but Free): one switch. On, from now until the
account's weekly reset, automatic work runs with no pace limit: no line or weekly reserve, no
5-hour reserve, and tasks at once are Auto (the machines' room decides). The account's own
limit still stops it (**Limit reached**), and so does a machine with no room. The line under the
switch, and the row, say until when it burns (**Burning until Sun 19:00**); it turns itself off at the
reset. It needs a quota reading, which gives the reset.

A reviewer account near its limit or held by its pace takes no new review:
the project's [reviewer fallback](project-management.md#reviewer-fallback) does it.

## Codex updates

wherdr starts Codex (new agents, task agents, coordinators) with its update check off
(`codex -c check_for_update_on_startup=false`, Codex's own setting for that launch only:
`~/.codex` is never changed), so that an update never ends a fresh conversation. Update Codex
yourself, in a terminal, when no conversation needs it.

- **A message sent while Codex installs or updates itself** is never typed into it: it waits
  as **Queued · sent when Codex is ready** and is typed once Codex is ready. If Codex exits
  instead, it comes back into the message field. The first message of a new Codex agent waits
  the same way, also behind its startup dialog. If typing it times out, it may have reached
  Codex: it is never typed again, and comes back into the field for you to check.
- **If Codex still updates itself and exits** (a new version once it has stopped), the space
  stays open: its terminal becomes a plain `sh`, and the conversation shows a **Your turn**
  card with **Resume conversation** (the same session; Codex's picker when wherdr cannot
  identify it) or **Start fresh**. A message sent meanwhile is refused (**Not sent**): restart
  Codex first. A plain exit of Codex still ends its terminal.

## v2 only: Codex updates and restarts

The Codex **Update** and **Restart Codex** cards below belong to wherdr v2 on Herdr.

- **Codex updates and limits**: in a Codex conversation, a new Codex version shows above the
  field with an **Update** button (runs Codex's official update command on that machine, after
  confirmation), then **Restart to update** on the same conversation. When wherdr cannot run it
  (read-only home), Update exits Codex, runs the command in the agent's own terminal and
  resumes the same conversation (only while Codex is idle). Codex's own weekly-limit warning
  (its footer gauge, or its startup heads-up) is repeated above the field, with its values, while
  Codex shows it.
- **After Codex updates itself and exits**: a **Your turn** card offers **Restart Codex**
  for a new conversation, with the original launch arguments. For an existing conversation,
  choose **Resume conversation** (its exact session, with the original options) or **Start
  fresh**. If wherdr cannot identify the session, Resume opens Codex's picker rather than
  choosing another pane's latest conversation. The usual attention notification applies.
  Nothing restarts automatically: the pane must still show the same empty shell prompt,
  with the shell in the foreground. Unrecognized shell prompts require a manual restart
  in the terminal. wherdr must have observed Codex before it exited.
  **Dismiss** puts the card away for good: the pane is a plain shell again, to use as you like.
  Messages sent meanwhile wait in the queue until the agent returns; if it does not (Dismiss, or
  a Codex that simply left), their text goes back into the pane's message field. Continuation
  prompts (unfinished quotes or heredocs) refuse a restart too. If the final
  transcript read fails, both conversation choices remain available; a session
  contradicted by a guessed match is resumed through Codex's picker.
