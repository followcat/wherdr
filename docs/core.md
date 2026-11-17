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
their cwd, else a new one. A tab of one terminal not named in herdr-app's layout is renamed
through that terminal's `herdr.title`; closing a tab or a space kills each of its terminals.
Split, move and renaming a tab named in the layout stay in herdr-app.
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

Claude Code, Codex, Devin, Antigravity and Cline terminals open in conversation mode, as in v2, with the same
conversation view, search, queued messages and quotas. The conversation file is found
the way v2 does for Herdr panes, from what core gives: `terminal.get` supplies the
foreground process and pid (Claude Code's `~/.claude/sessions/<pid>.json` names its
transcript), the process tree under the terminal's pid (`ps`, for an agent started by a
shell), the folder and the start time (Codex claims the rollout created right after its
terminal appeared). On a remote core machine the files are read with `machine.exec` on that
machine. A terminal that is not an agent shows only its terminal. Claude Code must keep
saving transcripts: a core started from inside a Claude Code session inherits
`CLAUDE_CODE_CHILD_SESSION`, which turns saving off; start core from a plain shell.

A local Codex attached to the shared app-server (`~/.codex/app-server-control/`) is read
from that daemon's paginated history first, so an older thread selected there shows its
whole conversation. wherdr only reads (`thread/list`, `thread/read`, `thread/items/list`):
it never starts the daemon, resumes a thread or types in the terminal. The terminal title
must match exactly one thread name in the same folder; repeated names are not guessed. A
missing or ambiguous match, another folder, or a failed first read falls back to the
rollout lookup above. Once a terminal has read a daemon thread, a failed read keeps that
thread and its last known messages until the daemon recovers or the conversation changes.
Each read has 1.5 s, a whole request 3 s, and a refused connection is retried after 5 s.
An expired paging cursor reloads the conversation's end. Daemon image attachments are not
shown yet; remote machines keep the rollout reader.

Devin CLI (tested with 3000.11.234) is read store-first: its own
`sessions.db` (`~/.local/share/devin/cli/sessions.db`) holds every message as
it is written, while the ATIF transcript only lands when a turn ends. A small
python3 script on the machine running Devin walks the session's message chain
read-only (`?mode=ro`, `query_only`), with per-session bounded queries
guarded by the schema version recorded in the store — an unknown version is
never interpreted, the database is never copied and no table is scanned
whole. Locally the script is spawned; on a remote core machine it runs
through `machine.exec` there, bounded in bytes and time. When the store
cannot be read — missing database, no python3, unknown schema, unknown
session or a failed query — the saved ATIF-v1.7 files at
`~/.local/share/devin/cli/transcripts/<session>.json` answer unchanged (24
MiB maximum, transferred in chunks of at most 4 MiB so remote replies stay
below core's transport limit), and a switch between the two sources resets
the view once rather than mixing items. The reader
matches the process PID to `session_locks/<session>.lock` only when the lock is
strictly newer than a proven upper bound on process birth. Linux process metadata
provides that bound; if it is unavailable, the reader requires an explicit `-r <session>` / `--resume <session>` launch
argument from core's exact argv or Linux's NUL-separated process arguments. It never guesses from the folder or the newest transcript. Two agents
in the same folder are resolved independently. If a process has multiple matching
locks after an in-process `/resume`, or no session can be identified, use Terminal;
the conversation reader cannot resolve that case. Local `DEVIN_SESSIONS_DIR` and
`XDG_DATA_HOME` overrides are honored; remote machines use their home and the
default path. No database, hook or agent configuration is modified.
If a transcript exceeds 24 MiB, use Terminal; Conversation cannot read that checkpoint.

The store is what shows a turn in progress — the current prompt, tools and
reply appear as Devin writes them — and history Devin compacted out of the
transcript is recovered: the earlier thread is stitched back in behind a
"Conversation compacted" note. When the store cannot be read, ATIF's
once-per-turn checkpoints apply as before. A tool observation saved in a
later step invalidates older pages that held the call, so reloaded history
includes its result. Only inline image data is shown; image paths are never
opened. Model metadata comes from the same source as the page; model
pickers remain v2 only.

Command Code (`cmd`) terminals open in the same conversation mode: wherdr reads its
project transcripts under `~/.commandcode/projects`, matching the header version 3
format inspected at 1.88.3 and, in one run, 1.88.4 — observed versions, not a live
check. Which file a pane displays follows a process-anchored rule: a candidate's own
header must record the process's exact cwd, or the exact launch arguments must name
it. Cmd's flags accept more — `-r`/`--resume` also takes a session name, `--session`
accepts a transcript path or a unique id prefix, `-c` continues the last session and
`--fork-session` forks one started with `-r`/`-c` — but only a full session id or an
absolute transcript path adds a candidate, and it never pins it.

Exact arguments reach the reader two ways: recorded at a root launch, or sampled live
from a non-root target while its argv still carries them — a retitled foreground
command normally shows nothing but `command-code`, and an exec'd Cmd keeps its
shell's pid and start time. The agent's own environment carries no session identity
either — the `COMMANDCODE_SESSION_ID` it sets belongs to the hook and tool children
it launches. Of the candidates the unique newest one persisted after a conservative
bound on the process's birth is shown — a recorded root launch's birth, or for any
other target the later of birth and its first observation as Cmd; that bound applies
even when sampled argv is exact. A session file already saved when that first
observation happens — or after a reader restart or eviction of the observed evidence —
waits for the next persisted write, not just the first assistant flush. Linux process
evidence backs the bound; without it, with a live Cmd peer in the process's own cwd,
with a live peer or an unknown process at a cross-cwd launch candidate's header cwd,
or with an ambiguous newest file, the conversation stays unavailable (the pane offers
**View terminal**) rather than a guess. Unknown processes count only when they share
the target's cwd or an eligible header cwd — and one whose own cwd cannot be read
blocks conservatively, since nothing proves it irrelevant — while guessed launch
arguments are never subtracted. Ownership is re-collected after the file and header
pass, so a target lost, moved or reused between the two samples — or a failed refresh —
answers unavailable too; that census judges live peers, not who wrote a disk file: an
exited peer may still own the newest one.

A new process shows no conversation until its first persisted assistant write lands
(the project directory itself may exist from startup). An in-process `/clear` fixes
the new session id, drops the pane back to its untitled `⌘ Command Code · <dir> ·
<model>` and writes nothing to disk at once; checkpoint and metadata files can appear
at the next user message, but the transcript itself lands with the first assistant
flush — until then the prior eligible file is still shown. A resumed session writes
nothing at startup either: it appends to its old file on the next exchange and keeps
its title. A first reply also triggers auto-naming: the session's metadata file gains
a title one to four seconds later (the transcript gains no `session_info` record),
turning the pane's title into `⌘ <Title> · <model>` — display only, never selection
evidence, and an in-process session picker is not covered. What the disk holds is
what shows: a turn appears once Command Code has persisted it, and a reply still
being written arrives with its next flush. Only inline image data is shown, and
sending stays the normal Enter-key terminal send. For model or effort pickers, launch
shortcuts and permission prompts, use the Command Code terminal itself.

Reads are bounded: a 24 MiB logical window aligned to line starts and anchored on
what was already read (overlapping reads can transfer more than the window), remote
chunks of at most 4 MiB, watched-record prefixes of at most 64 KiB, a newest span of
at most 4 MiB, and caps of 4096 watched records and 64 files.

A whole-second timestamp's continuity is sampled, not proven byte-for-byte: instead
of a whole-file checksum, Command Code fingerprints the claimed prefix's head and
tail 64 KiB windows — one read of at most 128 KiB when they touch, two disjoint reads
otherwise — at most two reads and 128 KiB per fingerprint, and at most four reads and
256 KiB of fingerprint IO in a request that both captures and validates, on top of the
ordinary bounded reads (other agents keep the whole-file checksum). A rewrite
strictly between the sampled windows can evade the check, and opens are bound to the
observed generation, not yet to the validated header's device and inode — a same-user
rename or symlink swap after validation can still serve other bytes, so this is not
a hostile-user guarantee. The projects root, each project directory and each
transcript file itself may not be a symlink; an ordinary `~/.commandcode` ancestor
link is fine. Once a token's state has settled, an unchanged poll re-reads no
transcript body or fingerprint bytes; the lookup's own census, header and metadata
checks still run.

OpenCode terminals open in the same conversation mode, **read-only**: the pane's
session comes from the service the foreground `opencode` process really has, not
from a label or the newest session. A bounded `/proc` census over `machine.exec`
reports every live opencode-shaped process with its generation, cwd and a
conservative birth bound; the target is the reported foreground pid, or the
terminal's root pid when its recorded launch argv proves an opencode launch — a
child opencode (run inside a shell pane) qualifies only once the census has
observed its generation as opencode. The machine's OpenCode service (its
`service.json` discovery) is then asked, through the same bounded helpers the
snapshot reads use, for the sessions of exactly that working directory: the
unique most recently updated row whose update stamp is at or after the birth
bound answers. No session, an incomplete scan, a live opencode peer in the same
cwd (or one whose cwd cannot be read), a tie, or a failed discovery or catalog
all stay unavailable — the pane keeps its terminal view rather than guess. The
session read itself is fingerprint-verified end to end (server generation, page
and metadata), a transport failure keeps the shown view instead of clearing it,
and a proven-absent session clears it at once. The one whitelisted write is
a session-scoped model switch: `PATCH /api/session/<id>` with a fixed
`{model:{id,providerID,variant}}` body, re-read for verification. Sends,
queued messages, permissions and shell actions stay with the OpenCode
terminal.

Antigravity CLI (`agy`, tested with 1.5.8) is read through its saved
conversations at `~/.gemini/antigravity-cli/conversations/<uuid>.db` (SQLite,
WAL mode; the database and its `-wal` sidecar are copied to a snapshot before
`node:sqlite` opens them, so remote machines read a consistent view through
`machine.exec`, and 256 MiB is the snapshot limit). A remote conversation keeps
one local base copy between reads: the main file ships over again only when
its own identity moves, a WAL still under the same 32-byte header ships only
its grown tail and is appended to the kept copy — but only after the last
frame that copy holds is re-read unchanged, since a rewound savepoint can
rewrite a spilled frame's header in place inside one generation; a restart or
a stale kept frame rewrites the file once. A copy that ends mid-frame is cut
back to the last whole frame (a frame's 24-byte header and its page are
separate writes), so a partial frame is never trusted across reads — and both
files are stat'ed fresh after the copy so a move under it retries rather than
opening a torn pair.
A WAL-mode checkpoint rewrites the database file, so the next read ships it
in full again; a page-level delta would need a page-hash helper on the remote
machine (no such primitive exists on `MachineFs` today), which is why the
copy stays whole — bounded by the snapshot limit — until one lands. Step
payloads are protobuf blobs decoded by a small bounds-checked reader
(`server/utils/agyProtobuf.ts`).
The session is resolved fail-closed from what the `agy` process holds open —
`conversations/<uuid>.db`, its WAL/SHM sidecars or `presence/<uuid>.lock` —
checked on Linux through `/proc/<pid>/fd` and elsewhere through `lsof`, with the
exact `--conversation <uuid>` launch argument as fallback. Descriptors naming
two conversations resolve to nothing rather than a wrong conversation; the
`conversation_summaries.db` index only stands in for an unmatched process when
one top-level live conversation claims the pane's folder. Local
`ANTIGRAVITY_APP_DATA_DIR` is honored; remote machines use their home and the
default path. Checkpoints and internal system steps are not rendered; a tool
result stored in a later step invalidates the pages that held the call, and
model metadata comes from `gen_metadata`. `node:sqlite` needs Node 22.13 or
later and is loaded only when an Antigravity conversation is read: on an older
Node the pane stays in Terminal mode (Conversation unavailable), and no other
agent loads or warns about it.

Cline CLI (`cline`, tested with 3.0.74) terminals open on their saved session: the
manifest `~/.cline/data/sessions/<id>/<id>.json` (pid, start time, folder, model) and
the conversation `sessions/<id>/<id>.messages.json`, one JSON document rewritten whole
on every update, cached on size and mtime so an unchanged file is never parsed again.
`--data-dir` in the launch arguments, or `CLINE_DATA_DIR` / `CLINE_SESSION_DATA_DIR`
on the machine itself, moves the store; `--id <id>` names a resumed session. With the
local backend (`--yolo` or `--data-dir`) the manifest's pid is the engine `.cline`
process under the pane's `node …/bin/cline`, and that PID decides; with the hub
backend (`cline -i` alone) it is the user's shared hub daemon, so the pane's folder
and a session started at or after the process start decide, newest first. A folder
with no manifest, an unknown `--id` or no match leaves the pane in Terminal mode
rather than showing another conversation. User texts lose Cline's
`<user_input …>` wrapper, tool calls are paired with their results, and a call the
user denied or one cancelled before it ran (a hook) shows as failed. The screen is
read too: the field is `❯ Ask anything...` between rules above a footer that names
the model and the auto-approve state, a braille spinner while a turn runs, and a
permission box (`Approve tool call?`, its tool, `[y] Approve` / `[n] Deny`) answered
with its own letters rather than a cursor.

Text left unsent in Claude Code's own input box (a draft or paste never submitted, or the
prompt Claude puts back after an interrupt) shows at the end of the conversation as
**Not sent** once it has stayed unchanged for two seconds and the colored screen (the first
paint of a passive `terminal.attach`) confirms it is typed text, not Claude's gray suggestion, with **Send now** (Enter, pressed
again every ~1 s while the box still holds that text alone, then a check that the box emptied and a turn started) and **Clear**. When Claude's queue offers
"ctrl+enter to send now", the conversation offers **Send now** too (ctrl+enter, then a check
that Claude took its queue). Each action re-reads the screen first and refuses a box that
changed (`server/utils/coreDraft.ts`). **Send now** spins and disables the row's buttons from
the tap until the message leaves the screen; a failure says why under it (*Not sent: … Try
again*). One action runs at a time per terminal: the same one asked again, from a second tap
or device, joins the one in flight, so a message is never sent twice.
A message sent from wherdr that Claude left in that box (a photo message is pasted, and
Claude may keep a paste there; a large photo is read and resized before its `[Image #N]`
shows, and an Enter pressed before that is lost; after a long idle, Claude may also ignore
Enter for a few seconds with the placeholder already shown) is submitted by wherdr. After
every send to Claude, idle or busy, whatever core reports, wherdr looks at the box: empty,
the message was taken (but an empty box with *Pasting…* under it is Claude still reading
the photos, several seconds for three large ones: wherdr keeps waiting); otherwise it waits up to about 24 seconds for the box to hold that
message alone, each photo as its placeholder, presses Enter, and presses it again while the
message is still there (up to ten times over about 16 seconds). This also holds for a
message sent while Claude works or ends its turn: Enter then puts it in Claude's own queue.
Enter is only pressed on a box that holds that message alone, so it is never sent twice. A
send that needed more than one Enter, or stayed in the box, leaves one line in the server
log (terminal and Enter count; when it failed, the sizes of what the box held and of what
was expected: characters, images, lines, never the text). A send in progress is noted in
`data/submitting.json` until it ends: if wherdr restarts meanwhile (an update), it resumes
it at startup, the same way and only on a box that holds that message alone.
A message another terminal sent with `hc send` (wrapped in `<hc from="…">`) is shown
without that wrapper, its photos as photos.
Until the send answers, the bubble reads **sending…**, not **Not sent**. While it stays there, its bubble reads **Not sent yet · waiting in
the agent's input**, never **Read by the agent**, and the box's own bubble is not shown
twice: the box is matched to the message by its text alone, whitespace, `[Image #N]`
placeholders and photo paths left out, since the box may show fewer placeholders than the
message has photos, or a photo still as its path. A new message is never typed into a box that holds text: Claude would submit both
as one message. The send is refused ("Not sent", with Retry): send or clear that text
first (`server/utils/coreInput.ts`).

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

Settings › Machines lists core's machines with their state, reconnects one
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
