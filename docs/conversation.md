# Conversation and replies

[Documentation](README.md) · [Project](../README.md)

- **Conversation view**: the agent's real transcript (Claude Code, Codex, omp, Devin, OpenCode 2.x and Command Code), rendered as
  Markdown, with grouped tool calls, images (full-screen viewer with pinch / wheel zoom and pan), timestamps, search and infinite scroll back to the
  first message. Reading a conversation never touches the terminal, so it never resizes a pane.
  A command the agent proposes (shell code block, or inline `! command`) can be copied without
  its prompt, or run in the agent's shell mode (`!`, Claude Code, Codex, omp and OpenCode) after you
  confirm the full command.
- **Devin conversations**: read store-first on the machine running the agent —
  the local CLI's own `sessions.db` (`~/.local/share/devin/cli/sessions.db`), a
  private schema guarded by its recorded version (20 as written by Devin CLI
  3000.11.234; an unknown version is never interpreted). A small python3
  script on that machine — the same python3 Herdr's own Devin hook already
  needs — walks the session's message chain read-only, per-session bounded
  queries only. Devin writes one node per message as it happens, so a turn's
  prompt and tool calls appear within seconds, and history it compacted out
  of the transcript is recovered: the earlier thread is stitched back in,
  marked by a "Conversation compacted" note. When the store is not usable —
  missing database, no python3, unknown schema, unknown session — the ATIF
  transcript (`transcripts/<session-id>.json`, ATIF-v1.7) takes over
  unchanged, and a source switch resets the view rather than mixing items.
  Install the Herdr integration with `herdr integration install devin`, then
  start or resume Devin so it reports its session. Same-directory sessions
  are never selected by recency. The reader follows `DEVIN_SESSIONS_DIR`,
  then `XDG_DATA_HOME/devin/cli`, otherwise `~/.local/share/devin/cli`.
  Polling costs a file stat while the store is quiet; when the db and WAL
  stats move, the session's chain signature confirms whether anything
  changed before the conversation is re-read. Cloud sessions are not
  supported by this reader, and a future schema version may need a reader
  update.
- **OpenCode 2.x conversations**: read the existing background service's projected
  history on the agent's machine (local or SSH), with native pagination, reasoning,
  tool progress/results/errors, saved images, previews and search. Python 3 is required
  on that machine. Install `herdr integration install opencode`, then start or resume
  OpenCode so Herdr reports its exact session ID. Same-directory sessions are never
  guessed. The reader discovers `service.json` in OpenCode's state directory
  (`XDG_STATE_HOME/opencode`, normally `~/.local/state/opencode`, with
  `opencode debug paths state` as a fallback), authenticates on the machine, and
  checks `/api/info` for version 2.x. It never starts, restarts or reconfigures the
  service. Credentials and service URLs are never sent to the browser.
  One SSE subscription per machine invalidates the cache; canonical HTTP pages are
  re-read on reconnect and regularly even when no event arrives. Revert, compaction
  and service changes discard old page anchors. Temporary read failures preserve
  already displayed messages. Search uses a 40-page / 8 MB scan budget within the shared deadline
  and reports incomplete results; the last page may exceed the byte budget. Only session-referenced inline or local
  `file:` image files are served; remote image URLs are not fetched.
  Answers go through the service: a blocked pane's pending permission request or
  question shows as the same "Your turn" card other agents get (Allow once /
  Always allow / Reject, a choice list, or a free answer for a single-field
  form), replied to through whitelisted calls and trusted only once the request
  has left the pending list. When the service is unreachable or does not list
  the request, the boxed permission dialog is still parsed from the screen —
  its colour-only cursor read from an ANSI re-read, never guessed — and its
  displayed action and resources resolve exactly one pending request before the
  reply goes out; an ambiguous match is refused. The session inbox is the
  composer's queue: waiting messages appear as queued bubbles and Cancel
  deletes the matching entry, re-listed first. `! command` runs OpenCode's real
  shell through the service and lands as a bash card. The composer status line
  shows the agent, model and per-direction token counts and cost from the
  session record, and the model can be switched for the current session from
  the composer's picker (the transport's one whitelisted write, verified by a
  re-read). Plain text still goes through the terminal; a message sent while
  the pane is blocked is held until its composer box is back on screen, and the
  raw input route refuses a bare Enter there. Stopping keeps its existing
  controls. Version 1.x,
  `--standalone` and explicit `--server` instances are not supported by this reader.
- **Command Code conversations**: read the local CLI's JSONL sessions on the machine
  running the agent (local or SSH): `~/.commandcode/projects/<project>/<session>.jsonl`.
  Herdr already reports the pane as `cmd`; no separate integration is needed. Text,
  reasoning, tool calls and their results, saved images, search, previews, model and
  pagination are read from the same file the CLI appends to; the composer shows the
  last turn's model and context. Its built-in `/model`, `/effort`, `/permissions`,
  `/compact`, `/clear` and `/config` are offered in the `/` menu. The model can also be
  changed from the composer's picker: it sends `/model <id>` to the pane, and the change
  is confirmed by the `model_change` entry the CLI writes. Command Code has no
  session-scoped confirm, so the choice also becomes the default for **new** sessions
  (`/config` › model). `/effort` stays a terminal command: it is not offered in the
  picker yet.
  The CLI reports no session id: the reader finds the project through the `cwd` in the
  session header and takes its most recently written session, so two live Command Code
  panes in the same folder share the newest one. Herdr has no `cmd` launch kind yet:
  start Command Code in a pane and wherdr reads it. Version 1 sessions and checkpoints
  are not read.
- **Interactive agent screens**: in a conversation, an uncertain menu or panel opens the
  pane's real terminal in a modal window, with arrows, Enter, Escape, Tab, digits and y/n.
  The rest of the app waits behind a scrim (the window fills the screen on a phone); in a
  split, only the cell in use opens it. It closes after the agent's message field returns.
  Close it yourself at any time with its button or a click on the scrim: that releases the
  terminal without pressing Escape, which goes to the agent, and the same interaction stays
  closed until you reopen it. Existing native questions, approvals, menus, waiting screens and
  Claude settings cards keep their controls. The window is a fallback after those
  recognizers, with two explicit exceptions: Codex's two-column `/usage` menu and
  its Agent Command Center. The slash menu still lists and sends commands. On a phone, the window
  temporarily fits the real pane to its width and restores its size on release, using
  the same lease as Terminal view; it does not shrink 120 columns into unreadable text.
  A pane already shown in Terminal keeps its existing live view. Try `/usage` on the
  Codex agent in the browser demo (scripted, no account data).
  In the compact list, native questions keep their preview and one-tap answers.
  Unrecognized blocking screens offer an **Open interactive terminal** button.
- **Composer**: send messages while the agent works (queued, cancellable: the agent's own
  queue when it takes them, else held by wherdr and sent when the turn ends; never left
  half-typed in its field; a message pulled back out of Claude's queue before it read it, or not seen after an hour, is
  marked “Not sent” with Retry / Cancel, and “Not sent” clears once the message shows in its transcript), attach or paste
  photos and the files the agent can read (Claude Code: PDFs, notebooks, text and code of any
  extension; Codex: notebooks, text and code), run slash commands (`/compact`, `/clear`, `/context`, `/usage`…) and see the output
  of local commands. Stop button while the agent works. When Claude Code suggests a reply
  (grayed-out in the empty field), `Tab` takes it on a computer and **Use**, inside the field on
  its right, on a phone: the field gets the text, to edit or send. A long pasted text (log, output) becomes
  a "Pasted text · N lines" card, sent to the agent as it is and shown the same way in the
  conversation, where it opens in full with Copy; long typed messages fold with Show more.
  The draft (text, quotes, attachments) is kept per agent, across reloads: when Herdr closes a
  pane and opens a new one for the same agent (the same conversation, or the same herdr-projects
  coordinator or task, as after `coordinator restart`), the view moves to the new pane and the
  draft comes along. A pane closed for good keeps it under its banner, with **Copy draft**.
- **On-device voice input**: install a speech model in Settings › Conversation, then use
  the microphone beside the message field. Context-capable models receive a bounded snapshot
  of the draft, pane information, attachment names and the last three messages sent from this
  device to this pane. Source text keeps its original words, numbers and writing system.
  Context is a recognition hint; it does not guarantee a spelling or number format.
  The server side supplies the weights: `scripts/fetch-asr-models.sh <model|all>` downloads
  them into `DATA_DIR/models/<name>/` (sherpa-onnx release tarballs, or Hugging Face for the
  WebGPU Qwen3-ASR export — `HF_ENDPOINT` selects a mirror where huggingface.co is gated),
  and the `/models/**` route serves them with byte ranges, behind the passkey lock like the
  API. The browser fetches each file once, in resumable slices, and keeps it in Cache
  Storage, so models survive redeploys and are not part of the npm tarball.
- **Model and effort pickers** for Claude Code, Codex, omp, Devin, OpenCode and
  Command Code (omp: its "Switch Model" selector, `/switch` or `/model`, and its
  thinking level, changed with its own ⇧⇥ cycle; Devin: its `/model` picker,
  Fusion's Lead and Sidekick included; OpenCode: the model only, switched
  through its session API — no effort control; Command Code: the model only,
  via `/model <id>`). Except where the agent itself cannot scope it (Command
  Code's pick also becomes its default), changes apply **to the current session
  only**; wherdr never changes your default model.
- **Codex update notices**: on Linux, wherdr checks the executable of the pane's
  current process, with a bounded cache. Resuming an older conversation does not
  make its original CLI version the running version. If the process cannot be
  inspected, wherdr falls back to the screen and conversation metadata.
**Settings › Conversation › Reply style** chooses how an agent's reply offers to be quoted in
the field, question by question and point by point (a list item or a paragraph that asks
nothing), so that one message answers them all:

| Style | A question | A point |
| --- | --- | --- |
| **Icon** (default) | A small `↳` after it, in the middle or at the end of the message. | A grey `↳` at its end: on hover on a computer, always there and pale on a phone. |
| **Tap the text** | No button: the question is underlined, tap or click it. | Click it on a computer. On a phone, tap it, then **↳ Discuss**: a single tap never quotes, so reading, scrolling and selecting text stay as they are. |
| **List under the message** | A number after it, and the questions listed under the message. | **+ Quote a point** under the message, then the point. Offered when the reply has a list item to quote, or two points or more: not under one paragraph of prose. |

Every one of these is a button reachable with the keyboard (`Tab`, then `Enter`), and selecting a
passage still offers **Reply** on it. A quoted question or point shows `✓`.

**One syntax for every reference.** Whatever you reply to, the field gets one line that names it,
and your answer goes on the lines below:

```
↳ Quote message 11:37 ~k3f : I can merge the PR —
Go ahead.
↳ Quote point 11:37 ~k3f : Shall I tag the release today? —
Yes
↳ Quote decision 11:37 #3 ~k3f : Publish the release notes on the site? —
No
```

| Line | Written by |
| --- | --- |
| `↳ Quote message <time> ~<code> : <start of the message> —` | **Reply** under an agent message. |
| `↳ Quote point <time> ~<code> : <excerpt> —` | `↳` on a question or a point, **Reply** on a selected passage. |
| `↳ Quote decision <time> #<n> ~<code> : <question> —` | **Yes**, **No** or `↳` on a row of a decision table. |
| `↳ Quote decisions <time> #<rows> ~<code> : <questions> —` | **OK to all** on a decision table. |

- The time is the one shown on the agent's message, so an answer to an earlier message is never
  read as an answer to the last one. The types are the same words in every language.
- The code after `~` is three characters wherdr derives from the message (and the rank of the
  table, from the second table of a message on). It tells apart two messages of the same minute
  and two tables of one message, whatever the excerpt shows. The field draws it dimmed, like
  the words before the excerpt; the quote of a sent message leaves it out. The rows of **OK to
  all** are the numbers the table really has: `#1-4`, or `#1,4` when rows 2 and 3 do not exist.
- A reference is a whole line: it starts with `↳` in the first column and ends with ` —` at the
  end of the line, and only there, so an excerpt may hold dashes of its own. The excerpt is plain
  text on one line; a long one is cut with `…` (a message keeps its start, a passage its start
  and its end).
- Several references fit in one message, each followed by its answer.
- Anything else is your own text: a `>` at the start of a line, a `↳` line of an unknown type or
  with words after its dash. Text you paste never becomes a reference either: a pasted line that
  reads like one gets a `\` before its `↳`. A long paste, shown as a **Pasted text** card, is
  sent exactly as it was pasted.
- In the conversation, each reference of a sent message shows as a quote; tap it to see the
  message it names. Messages sent earlier with `> ` lines still show as quotes.

**Settings › Conversation › Quoted replies** chooses how the field shows these lines: **Tokens,
native field** (default) draws each one as a token in the usual field, **Plain text** shows the
same lines as text, a fallback if the tokens misbehave. The message sent is the same.

A **closed question**, one that yes or no answers in full, also gets **Yes** and **No** next to
its `↳` (at the end of its row in the list style). A tap refers to the question and writes the
answer under it (`Yes` or `No`), exactly as Reply and typing would; nothing is sent, so several questions can be
answered in a row before sending. On a computer a click hands the field the focus, the caret
right after the answer, so Enter sends it at once; the keyboard stays down on a phone, and a
button pressed with the keyboard keeps the focus. Tapping the other answer
replaces the first; words you typed under a quote are never replaced. The rule is cautious, and
in doubt only Reply is offered: a single sentence that opens like a yes/no question (`Shall I…`,
`Do you…`, `Is it…`, `Want me to…`, `Est-ce que…`, `Je lance… ?`, `On…`, `Dois-je…`) or ends
with `, OK?` / `, d'accord ?`, with no alternative (`or`, `ou`), no interrogative word (`which`,
`how`, `quel`, `comment`…) and no negation.

A **decision table**, a Markdown table whose rows are numbered questions as a coordinator writes
them, gets a panel right under it: **OK to all** refers to the whole table and writes `OK to all`
under it (a second tap takes it back), and each row has **Yes**, **No** and `↳`, which refer to
the row by its number and write `Yes` or `No` under it, or nothing for an answer in words; a row
that asks an open question has `↳` alone. Every answer names the message and the row, even for
the last message: the agent may write another one before you send. Here too everything is composed in the field and you send; on a computer the field takes the focus
after a click, so Enter sends. A table qualifies when it has a
number column (a header `#`, `N°`, `No`, `Num`, `ID` or `Q` over short numbers, each once) and a
question column, known by its header (`Question`, `Decision`, `Choix`…), by cells that all end
with `?`, or by an advice column next to it (`Avis`, `Recommendation`, `Suggestion`…). Any other
table is left as it is.

Above the field, **N questions unanswered** counts the questions of the agent's last message
(and the rows of its decision tables) that your draft does not answer yet; tap it to scroll to
the first one. A question counts once it is quoted, a row once it is answered, quoted or covered
by **OK to all**; when the message asks one thing only, any words you type answer it. The line
goes when everything is answered and when you send, and it never shows for earlier messages,
while the agent is working, or while it waits on a prompt. It hangs from the top edge of the
field, so nothing moves when it comes or goes.
