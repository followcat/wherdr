# herdr-core

[Documentation](README.md) · [Project](../README.md)

wherdr v3 runs entirely on herdr-core (`hc`). This page is the reference for what it supports.

## Setup

Build with `npm run build`, and start the server with `HC_SOCKET` pointing to the socket of the
desired hc session
([First launch](quick-start.md#quick-start)). Obtain the endpoint from your hc configuration;
wherdr requires an explicit endpoint and never starts or installs core. This avoids accidentally
selecting an inherited agent session. The browser cannot choose the endpoint or issue arbitrary
RPC calls.

`GET /api/core` checks the configured hc: protocol generation 1 and these methods,
in both advertised lists (`hello` and `rpc.discover`): `terminal.list`, `terminal.get`,
`terminal.run`, `terminal.read`, `terminal.attach`, `terminal.send`, `terminal.keys`,
`terminal.interrupt`, `terminal.put`, `terminal.kill`, `terminal.keep`, `events.subscribe`,
`machine.list`, `machine.add`, `machine.connect`, `machine.rename`, `machine.rm` and
`server.status` (`server/utils/core.ts`). A missing method is reported by name. Files,
transcripts and quotas of core machines also use `machine.exec`.

Only the API routes listed in `shared/coreRoutes.ts` answer; every other `/api/` route returns
"Unavailable with herdr-core". Worktrees, Git changes, model and effort pickers, Herdr sessions,
Herdr plugins, the setup guide and the one-tap update are v2 only.

## Inventory

Core mode uses the existing v2 home, workspace cards, tabs and agent screen.
A core poller reads `terminal.list` and `machine.list` and publishes changes through
the existing state WebSocket. The old Herdr poller and TUI
notifications are disabled. Network and passkey guards remain active; legacy
control routes are unavailable in core mode.

The home has one machine-bar item per machine (this core and each `machine.list`
entry, online or offline) with its counters. Terminals are placed like herdr-app
places them: by their `herdr.space` / `herdr.tab` labels, else by the tab of the
machine's `herdr-app` document whose layout holds them; the document (read only,
never written) gives the space and tab names and the tab order. Terminals with no
such placement are grouped by machine and cwd, one tab and pane per terminal.
"+" in a space's tab row (or header) starts at once a terminal like the space's current one (same kind, same folder; "New tab…" in the tab menu opens the sheet to choose). The header map button lists the space's terminals to switch between. The new terminal carries that
space's `herdr.space`, a new `herdr.tab` and `herdr.seen=0`, so it also appears in
herdr-app. Terminals made from the "New" sheet get the space whose folder holds
their cwd, else a new one. Rename, close, split and move stay in herdr-app.
Each pane preserves its full core address behind a stable interface identifier.
Agent identity uses core's `agent` field when supplied, otherwise recognised
application/template/command names. Identity does not gate status: OSC 7501
Working and Blocked lift any program's workspace into Working or Your turn.
Idle and Done appear in Ready; absent or unrecognised status also appears in Ready (as in v2.5).
For online machines, the three home counters (your turn, working, ready) count the same rows as their headings, and the machine tabs count rows too. The Herdr sessions row is hidden; `/api/phone` and a read-only `GET /api/update` (no one-tap update) answer.
A mixed workspace follows its most urgent terminal. On connection loss the last
inventory stays visible offline; subsequent polls reconcile it with core.

Opening a terminal attaches to it through `terminal.attach` on a framed connection,
one per viewer, so several viewers (phone, computer, herdr desktop) work at once.
A viewer attaches at its own screen size, which fits the terminal to it, so core paints
the screen at that width. When another viewer then sets its size, it follows that size
and shows a banner, and does not resize the terminal again until the user takes control:
typing in the terminal or the composer, a key of the keybar, or "Fit to this screen".
A watch-only viewer attaches at the terminal's current size.
The browser returns credit after xterm has written each chunk (core's 256 KiB window
bounds the relay) and scrolls the history it received locally.
The composer sends with `terminal.send` (never retried), Stop calls
`terminal.interrupt` and reports what core observed, keys use `terminal.keys`, and
closing a pane ends its program with `terminal.kill`. Controls that core does not support
yet are disabled or hidden.

Reference: [published 0.1.16 protocol](https://github.com/herdrdev/herdr-core/blob/v0.1.16/schema/README.md).
Generation 1 and both advertised method lists must support the first v3 terminal
milestone; later additive versions are accepted. Plain mode is used here;
terminal streams negotiate framed mode on their own connection. Probe connections close
after each reply and have a three-second deadline and a 16 MiB reply limit.

## Conversations

Claude Code, Codex and Devin terminals open in conversation mode, as in v2, with the same
conversation view, search, queued messages and quotas. The conversation file is found
the way v2 does for Herdr panes, from what core gives: `terminal.get` supplies the
foreground process and pid (Claude Code's `~/.claude/sessions/<pid>.json` names its
transcript), the process tree under the terminal's pid (`ps`, for an agent started by a
shell), the folder and the start time (Codex claims the rollout created right after its
terminal appeared). On a remote core machine the files are read with `machine.exec` on that
machine. A terminal that is not an agent shows only its terminal. Claude Code must keep
saving transcripts: a core started from inside a Claude Code session inherits
`CLAUDE_CODE_CHILD_SESSION`, which turns saving off; start core from a plain shell.

Devin CLI (tested with 3000.11.234) is read through its saved ATIF-v1.7 files at
`~/.local/share/devin/cli/transcripts/<session>.json` (24 MiB maximum, transferred
in chunks of at most 4 MiB so remote replies stay below core's transport limit). The reader
matches the process PID to `session_locks/<session>.lock` only when the lock is
strictly newer than a proven upper bound on process birth. Linux process metadata
provides that bound; if it is unavailable, the reader requires an explicit `-r <session>` / `--resume <session>` launch
argument from core's exact argv or Linux's NUL-separated process arguments. It never guesses from the folder or the newest transcript. Two agents
in the same folder are resolved independently. If a process has multiple matching
locks after an in-process `/resume`, or no session can be identified, use Terminal;
the conversation reader cannot resolve that case. Local `DEVIN_SESSIONS_DIR` and
`XDG_DATA_HOME` overrides are honored; remote machines use their home and the
default path. No database, hook or agent configuration is modified.

ATIF updates once per turn: while Devin works, Conversation retains the last
saved checkpoint. The current prompt, tools and reply appear after the next save.
Compaction can remove earlier history from ATIF, so scrollback and search cover
only what Devin retained. A tool observation saved in a later step invalidates
older pages that held the call, so reloaded history includes its result. Only
inline image data is shown; image paths in ATIF are never opened. Model metadata comes from that checkpoint too; model
pickers remain v2 only.

Text left unsent in Claude Code's own input box (a draft or paste never submitted, or the
prompt Claude puts back after an interrupt) shows at the end of the conversation as
**Not sent** once it has stayed unchanged for two seconds and the colored screen (the first
paint of a passive `terminal.attach`) confirms it is typed text, not Claude's gray suggestion, with **Send now** (Enter, then a
check that the box emptied and a turn started) and **Clear**. When Claude's queue offers
"ctrl+enter to send now", the conversation offers **Send now** too. Each action re-reads the
screen first and refuses a box that changed (`server/utils/coreDraft.ts`).

## Creating terminals and agents, machines

New opens the usual sheet. A terminal or an agent CLI (Claude, Codex…) is started with
`terminal.run` in the chosen folder, on this machine or on a core machine (`on`), with no
inherited parent, `wait: false` and a request label. Agents run through the machine's shell
with the usual user bin folders on `PATH`. Home, folders (browser, Git detection) and
installed agents of any machine come from `machine.exec`; folders must stay under the
machine's home. When core does not answer in time, the inventory is searched for the label:
found means created, not found is shown as "not confirmed" and is never relaunched blindly.
Resuming the last conversation and a first message are offered: the first message is sent
once the program is ready, waits while it shows a dialog (such as trusting the folder), and the
app says when it was not sent. Worktrees are not offered with core.

Claude and Codex quotas work as in v2 (home rows, Settings › Agents › Claude quotas): the server reads each
machine's quota files, this machine's from disk and core machines' through `machine.exec` (the status line
installer goes on its stdin), with a 30 s cache.

Settings › Agents › Machines lists core's machines with their state, reconnects one
(`machine.connect`), renames (`machine.rename`) or forgets (`machine.rm`) one, and adds one over
SSH (`machine.add` with a target and an optional name, like `hc machine add`). The target must already accept this host's SSH login: wherdr never
asks for a password, installs core on the machine, or accepts a `via` command.

## Agent actions

The **…** menu of an agent holds Take control of this terminal, Reconnect, **Rename pane**,
**Browse files**, **Keep after restart** and Close. These go through core and are shared with
the other hc clients:

- **Rename** writes the `herdr.title` label; an empty name brings the automatic one back.
- **Read / unread** writes `herdr.seen`: opening a finished agent marks its turn as read.
- **Keep after restart** sets `terminal.keep`: a kept terminal comes back as a shell when core
  restarts or loses it.
- **Answers** to a question (one-tap or typed) re-read the screen first; a question that changed
  meanwhile is refused instead of answered blindly. A choice is sent with `terminal.keys`.
- **Attachments** (photos and files) are copied to the agent's machine with `terminal.put`,
  8 MB per file at most.
- **Files**: the agent's folder is read on this machine, or with `machine.exec` on a core machine
  ([Files](files.md)).

## Notifications

Push alerts come from core's events (`events.subscribe`), with herdr-app's rules: **needs you**
when a terminal becomes blocked (or errors), **finished** when it goes from working to idle or
done. Nothing for a sub-agent (a terminal with a parent), nothing before the first snapshot,
nothing while someone views that agent, one alert per terminal, turn and kind, and only if the
state still holds after a short settle. See [Notifications](notifications.md).
