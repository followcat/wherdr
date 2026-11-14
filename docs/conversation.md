# Conversation and replies

[Documentation](README.md) · [Project](../README.md)

Claude Code, Codex, Devin and Antigravity terminals open in conversation mode; any other terminal shows only its
[terminal](terminal.md). How wherdr finds the conversation file on herdr-core is described in
[herdr-core › Conversations](core.md#conversations).

- **Conversation view**: the agent's real transcript (Claude Code, Codex, Devin and Antigravity), rendered as
  Markdown, with grouped tool calls, images (full-screen viewer with pinch / wheel zoom and pan),
  timestamps, search and infinite scroll back to the first message. Reading a conversation never
  touches the terminal, so it never resizes it. A command the agent proposes (shell code block,
  or inline `! command`) can be copied without its prompt.
- **Following new messages**: a new or growing reply (typed in as it arrives, or shown at once)
  keeps the view at the bottom only if you were at the bottom. Scroll up (wheel, touch, keyboard
  or scrollbar) and the view stays where you are until you scroll back to the bottom or tap the
  **↓** button; content above that changes height (images, folding) does not move it. A
  conversation still opens at its last message.
- **SVG diagrams**: complete code fences labelled `svg` render as isolated, theme-aware images.
  **Source / Preview**, beside **Copy** in the card header, switches the same card between the
  diagram and its original markup; **Copy** always copies that markup. Click or use Enter/Space
  on the image for the full-screen viewer. Static shapes, text and local definitions are
  supported, up to 150,000 source characters, 2,000 source elements and 10,000 expanded
  reference instances. Incomplete, unsupported or unsafe diagrams stay readable code. Scripts,
  foreign HTML, animation and external resources are rejected; raw inline SVG is not inserted
  into the page. Other fence languages and file-explorer document fences remain code.
- <a id="live-status-cards"></a>**Live status cards**: a code fence labelled `wherdr` whose lines are all `status …` shows one
  card per line, read from wherdr's own data, never from what the agent wrote:
  `status machine:<key or name>` (online or offline, free memory, load, agents),
  `status quota:claude` or `status quota:codex` (5-hour and week windows left),
  `status pr:<KEY>#<n>` (the PR of a task of project KEY, as the engine last read it) and
  `status op:<task id>` (the step the task's engine runs now, such as a watched pipeline, and
  since when). Up to 8 lines. Cards refresh every 15 s while they are on screen; a source that
  is gone (machine removed, no quota read, unknown task or PR) shows **unavailable**. A PR or
  operation card opens its task. On a phone the cards stack, one per line. A block with any
  other line stays code; file documents never show cards.
- **Links into wherdr**: an agent sending you somewhere in wherdr gives its in-app address, as a
  Markdown link (`[Phone](#/settings?section=phone)`) or as inline code that is only the address
  (`` `#/board?task=KEY-12` ``). Either shows as an action button with an icon and a readable
  label instead of the address: the link's text, or the place's name for inline code (*Open
  Settings › Projects › KEY › Guards*, *Open Task KEY-12*, *Open Board › KEY › ui*). A tap opens
  the place in the app, on a computer and a phone,
  without reloading; Back returns to the conversation. Other links open in a new tab, other
  inline code stays plain. The addresses: `#/`, `#/decisions`, `#/board` (with `?project=KEY`,
  `?tag=TAG` or `?task=ID`), `#/settings?section=<section>`, a tab of Settings › Conversation
  `#/settings?section=conversation&tab=<tab>` (`display`, `dictation`, `read-aloud`) and a
  project's sheet `#/settings?section=projects&project=KEY&tab=<tab>`; Alfred and coordinators get the list in
  their instructions.
- **Task cards**: an agent shows a task where it stands with a code fence labelled `wherdr`, one
  line `task KEY-12` per task. Each line shows the task's row as in the sidebar's Tasks to
  handle: its key, title, step and what to do, read live from the board (every 15 s, and after
  an action in a task's sheet), never what the message says. A tap opens the task's sheet over
  the conversation. A task that is not on the board says so; a block with any other line stays
  plain code. Alfred and coordinators get this in their instructions.
- <a id="places-an-agent-opens-for-you"></a>**Places an agent opens for you**: when you ask Alfred or a project's coordinator to show you
  a place, it can open it in the wherdr you are on (`wherdr alfred ui open
  '#/settings?section=phone'`, `wherdr pm ui open '…'`): of the apps showing its conversation,
  the one you last used (within 15 minutes), and no other, so a computer left open on the same
  conversation stays as it is while you are on your phone. On a computer window at least 1280 px
  wide, a Settings place opens in the side panel beside the conversation (bare `#/settings` on
  Appearance, "Opened by Alfred" at its top; close it with ×). The agent is told where it went
  (phone or computer), and ends its reply with a "Place in wherdr" card (a ```wherdr block of
  `open <in-app link>` lines) that names the place: a tap opens it, now or later. That card is the
  one element shown for the place; only if the reply ends without it does an "Opened by Alfred"
  bar appear above the message field, in the conversation column and as wide as the field (× dismisses it). With
  no app in use on the conversation, it gives you the link instead. Opening is all it does: it
  changes no setting. It works only in a turn that follows your message (never in an Autopilot
  wake), and a coordinator opens its own project's places and global Settings sections only. To
  show you where a setting is, the agent points at it (`wherdr alfred ui open --target
  terminal.key-order`; `ui targets` lists the settings it can point at): on a wide computer the
  side panel opens on its section and highlights it; on a phone the card names the setting with a
  crosshair, and a tap opens the page and highlights it. A part of a project's sheet takes the
  project too (`ui open --target project.guards --project WEB`): its sheet opens on that tab,
  highlighted. Other targets include *Machines › Add machine* and *Phone › Use it on your phone*.
- <a id="buttons-an-agent-puts-in-its-reply"></a>**Buttons an agent puts in its reply**: Alfred or a project's coordinator can give you the
  button for a task instead of telling you to go and find it (`wherdr pm ui action resume|step|open
  <task>`): *Resume WHR-12* for a stopped task, the step's own button (*Merge*, *Approve
  screenshots*) for a step that waits for you, or *Open WHR-12*. The card says who suggests it and
  sits in the reply (a ```wherdr block of `action <id>` lines). Only your click runs it, through
  the same action as the task sheet, and only if the task still waits the same way: if it moved
  on since, the card says *This changed since* and runs nothing, with a button to open the task.
  After the click it shows the outcome (*Merge: done by you · 14:02*, or *approved by you, merges
  once ready* for an approved merge whose PR is not ready yet); a refused step action (a PR in conflict, red
  checks) keeps the button, with the reason under it, as the task sheet does. The agent can add one only
  in a turn that follows your message, never in an Autopilot wake, and a coordinator only for its
  own project's tasks. A button lasts a day, and a new one for the same task and action replaces
  the older one. An agent's token cannot click (`/api/ui/act` refuses it); without a passkey,
  though, any program on this computer reaches the app's API, as the task sheet's buttons do.
- **Setting changes Alfred proposes**: Alfred never changes a setting itself, even after a yes in
  text. It proposes one (`wherdr alfred setting set <key> <value> --propose`) and its reply carries
  a card: *Setting change proposed · by Alfred*, the setting (*Conversation › Reply style*), before
  → after (*default → list*) and the message of yours it answers. *Show me* opens Settings on that
  setting and highlights it; *Apply* changes it from your session (never a token); *Cancel* drops
  it. The card then says *Applied by you · 14:02* or *Cancelled by you*. If the setting changed
  since (in Settings, on another device), it says so and applies nothing. Only in a turn that
  follows your message, never in a wake; a new proposal for the same setting replaces the older.
- <a id="project-changes-alfred-proposes"></a>**Project changes Alfred proposes**: the same card, for a project change
  (`wherdr alfred project add|template|guards|machine … --propose`, or `coordinator start …
  --propose`): *Change proposed · by Alfred*, the place (*Project WEB › Guards*) and the lines the
  change would make. *Show me* opens the project's sheet on that part, highlighted; *Apply* makes
  the change from your session, only if it would still make the same lines (else *This changed
  since: nothing was applied*); a check that fails then (a folder that is no longer a repository)
  shows under the buttons.
- <a id="what-a-card-tells-its-agent"></a>**What a card tells its agent**: once you click *Apply* or
  *Cancel* on one of these cards (a setting, a project change, a coordinator start, a task's
  button), or answer a workflow or automation change, wherdr tells the agent that proposed it in
  its conversation, so it goes on by itself (Alfred moves to the next project): *Applied:
  Project WEB › Guards*, *Cancelled: …*, or *Not applied: …* with why (changed since, a check
  that failed). It shows as a muted *From the card* row, not as a message you typed, and counts as
  your turn (the agent may propose the next card). A second click on a closed card tells nothing.
  While that agent does not run, nothing is typed: its next start's first message lists what you
  applied or cancelled since.
- **Files and screenshots beside the conversation**: an agent can show you a file of its own
  folder (`wherdr pm ui show file docs/plan.md`, a path relative to its folder: never `~`, `..`
  or a path outside it) or a task's screenshots (`wherdr pm ui show shots WHR-12`, once the task
  has some). On a wide computer they open in the side panel, in place of Settings: the file
  read-only as in Files, the screenshots by step, before and after side by side, with a button
  to open the task. On a phone a card shows above the message field, and a tap opens a sheet
  (before and after toggled). The card also stays in the reply (a ```wherdr block of
  `show file|shots …` lines), and a tap shows it again. Showing approves nothing: the agent adds
  the step's button (*Approve screenshots*) with `ui action step`. Only in a turn that follows
  your message, and a coordinator shows its own project's tasks only.
- **Wakes**: in a coordinator's conversation, a wake (Autopilot, Health check, Engine, Incident,
  Step check) is a compact muted row, not one of your bubbles, with the coordinator's answer under
  it; routine runs fold into one row. See
  [Who sends a wake](project-management.md#who-sends-a-wake).
- **Questions and permissions**: native questions, approvals and menus show their options; a tap
  answers. wherdr reads the screen again right before answering and refuses the answer if the
  question changed meanwhile. A free answer selects its option, waits for the field, then types
  the text. Unrecognized blocking screens offer the real terminal.
- **Composer**: send messages while the agent works (queued: the agent's own queue when it takes
  them, else held by wherdr and sent when the turn ends; never sent twice; a message sent while
  wherdr types a wake or another of its own messages into the agent waits for it, then goes;
  while Codex installs or updates itself, a message waits as **Queued · sent when Codex is ready**,
  and comes back into the field if Codex exits instead, see [Codex updates](quotas.md#codex-updates)), attach or paste
  photos and the files the agent can read (Claude Code: PDFs, notebooks, text and code of any
  extension; Codex: notebooks, text and code), up to **8 MB per file** (core's `terminal.put`).
  A sent file shows as a chip (icon and original name) in the message and its history, also in
  conversations from v2; a tap opens or downloads it. A photo stays a picture in the message,
  never its file path, also when the message was sent again (**Send now**, **Retry**) or waited
  in the agent's queue.
  Slash commands typed in the field (`/compact`, `/clear`…) are sent as text. **Stop** (or `Esc`
  in the empty field) interrupts the agent and says what core observed. When Claude Code
  suggests a reply (grayed-out in the empty field), `Tab` takes it on a computer and **Use**,
  inside the field on its right, on a phone. A long pasted text (log, output) becomes a
  "Pasted text · N lines" card, sent to the agent as it is and shown the same way in the
  conversation, where it opens in full with Copy; long typed messages fold with Show more. The
  draft (text, quotes, attachments) is kept per agent, across reloads.
- **omp context**: in the header, after the state, a small gauge with the percentage of omp's
  context window and the estimated tokens (`68% · 136K`); select it for the window, the exact
  percentage and omp's status line (on a phone, the percentage alone, under the title, in place of the agent kind). The
  estimate comes from omp's rounded percentage, not a token count. Unknown readings stay
  hidden; a reading taken while omp rests, or before its panel hid the gauge, is marked as
  the last one.
- **Composer and terminal together** on a computer: under an agent's terminal, the composer stays
  available; typing in it takes control of the terminal's size ([Terminal](terminal.md)).
- The model and effort pickers, the slash-command list and Codex update cards are v2 only.

**Settings › Conversation › Display › Reply style** chooses how an agent's reply offers to be quoted in
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

**Settings › Conversation › Display › Quoted replies** chooses how the field shows these lines: **Tokens,
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

A **decision table**, a Markdown table whose rows are numbered questions as an agent often writes
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

**Choice buttons.** An agent can offer 1 to 4 answers as buttons (a single one is a one-click
confirm, such as `choices "OK, fix the test"`) with a `wherdr` code block, one
element per line:

````md
Which one should lead the release notes?

```wherdr
choices "Rate limits" | "CSV export" | "Both"
```
````

A tap sends that option at once as your reply, quoted to the last question written before the
block (to the whole message when there is none), the same as typing it. Only the choices of the
agent's last message are live; once a sent message answers them, and in older messages, they are
greyed, the answer given marked. A `wherdr` block with a line wherdr does not understand (a
missing quote, no option or more than four, an unknown kind) shows as ordinary code.

Above the field, **N questions unanswered** counts the questions of the agent's last message
(and the rows of its decision tables) that your draft does not answer yet; tap it to scroll to
the first one. A question counts once it is quoted, a row once it is answered, quoted or covered
by **OK to all**; when the message asks one thing only, any words you type answer it. The line
goes when everything is answered and when you send, and it never shows for earlier messages,
while the agent is working, or while it waits on a prompt. It hangs from the top edge of the
field, so nothing moves when it comes or goes.

## Settings

**Settings › Conversation** has three tabs, each kept in the address so a link opens it:

- **Display** (`#/settings?section=conversation&tab=display`, the default): default pane view,
  typewriter, reply style and quoted replies.
- **Dictation** (`#/settings?section=conversation&tab=dictation`): off, on this device (its
  models), online, and the rewrite pass ([Dictation design](dictation.md)). A dictation error's
  **Settings** button opens this tab.
- **Read aloud** (`#/settings?section=conversation&tab=read-aloud`): off or a voice, the voice
  list and Test.

Each setting says whether it is saved on this device or follows you on every device.
