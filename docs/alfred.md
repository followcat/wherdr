# Alfred's command: `wherdr alfred`

[Alfred](home.md#alfred), wherdr's assistant, acts on wherdr with `wherdr alfred <command>`, a small command written
in its home folder (`alfred/bin/wherdr` in wherdr's data folder). It talks to the wherdr server
on this machine only, with a token wherdr writes to `alfred/.alfred-token` (mode 600) at each
Alfred start; a call relayed from the tailnet or anywhere else is refused, whatever its token.
Each answer is JSON.

Reading:

| Command | Answers |
| --- | --- |
| `wherdr alfred projects` | whether projects are on, and each project (key, name, machine, folder, template) |
| `wherdr alfred project <KEY>` | one project, its coordinator and its tasks by state |
| `wherdr alfred templates` | the saved templates, and the examples (`example:<id>`) a project's template can start from |
| `wherdr alfred machines` | the machines herdr-core knows (key, label, status); `""` is this machine |
| `wherdr alfred coordinators` | each coordinator, its agent and whether it runs (`stopped`: its terminal ended, see `--resume`) |
| `wherdr alfred coordinator open <KEY>` | the link that opens a running project coordinator |
| `wherdr alfred last <KEY>` | what the project's coordinator last said (its last message, else the bottom of its screen), and whether it is still working |
| `wherdr alfred v2` | when you come from wherdr v2: its projects, read then from the herdr-projects board of this machine, their open tasks, the v3 project made from each, and the migration report ([set up your v2 projects](migrate-from-v2.md#set-up-your-v2-projects-with-alfred)) |
| `wherdr alfred settings` | the synced settings, their values, and the values each setting Alfred may change accepts (`1` on, `0` off) |
| `wherdr alfred help` | this list |

Changing (show, then do):

| Command | Does |
| --- | --- |
| `wherdr alfred project add <KEY> --machine <key> --path <folder> [--name <name>] [--template <id>]` | adds a project: a git folder inside the home folder of a machine, not already a project (on this machine, checked before the yes too) |
| `wherdr alfred project template <KEY> <id\|none>` | gives the project a template (a saved one or `example:<id>`), or none |
| `wherdr alfred v2 import [--only <KEY,KEY>] [--start no]` | brings every v2 project not made yet over in one change: each added on this machine with its v2 folder, then its coordinator started (no workflow needed); with `--propose`, one card with a checkbox per project and one for *Start their coordinators*; the outcome lists each project ([set up your v2 projects](migrate-from-v2.md#set-up-your-v2-projects-with-alfred)) |
| `wherdr alfred project memory <KEY> < note.md` | adds the lines it is given (at most 30) to the end of the project coordinator's `memory.md`, created when missing: a v2 handover note and goal, for instance ([set up your v2 projects](migrate-from-v2.md#set-up-your-v2-projects-with-alfred)) |
| `wherdr alfred project guards <KEY> [--protect <branch,branch\|none>] [--merge-protected user\|engine] [--merge-others user\|engine] [--contributor-prs off\|others\|all]` | the project's [guards](project-management.md#guards): protected branches, who merges into them and into the others (`user`: you, `engine`: wherdr), and whether its coordinator may merge an outside contributor's PR after your yes; without an option, only shown |
| `wherdr alfred project machine add <KEY> <machine> --clone <folder>` | lets the project's tasks run on another machine (its key or label), in its clone of the repository there; once applied, the machine's [readiness check](project-management.md#board) runs and its result is in the answer |
| `wherdr alfred project machine remove <KEY> <machine>` | the project's tasks no longer start on that machine (tasks already there stay) |
| `wherdr alfred coordinator start <KEY> [--program claude\|codex] [--resume]` | starts the project's coordinator; without `--program`, its default agent and model (as chosen in the setup window), else the user's first offered agent that can run it (Settings › Agents) (a new conversation replaces a running one); `--resume` takes up its last conversation again, with the agent that ran it |
| `wherdr alfred setting set <key> <value> [--propose]` | proposes a setting change, to one of the values `settings` lists for it (a theme id from the theme list, for instance): without `--propose` it is only shown; with it, Alfred's reply carries a [card you apply](conversation.md) (before → after, *Show me*, *Cancel*, *Apply*). Alfred never applies a setting itself, and only proposes one in a turn that follows your message; lists such as machine groups or hidden agents stay in Settings |

A change without `--apply` (all but `setting set`, which is only proposed) changes nothing: it prints what it would do (`dryRun`, `change`) and
the command that makes it. Alfred shows you those lines and runs that command, with `--apply`,
only after your yes in the chat. With `--propose` instead (only in a turn that follows your
message), nothing changes yet: Alfred's reply carries a [card you apply](conversation.md#project-changes-alfred-proposes)
with the change's lines, *Show me*, *Cancel* and *Apply*. Your click is [told to Alfred](conversation.md#what-a-card-tells-its-agent)
(*Applied: …*), so it goes on to the next step (the next v2 project) without you typing "ok, next". When the answer names a `remote` machine (a project on another
machine, its coordinator), Alfred makes the change only when you asked for it. A
coordinator needs no workflow to start: a project without one has the minimal default, and its
coordinator's first conversation proposes one. No `wherdr alfred`
command deletes anything but its own [notes](#notes) (removing a project's machine leaves its clone and tasks there): removing a project, a template or a setting stays yours, in Settings.
The one removal a coordinator has is `wherdr pm task remove`, for a task never started.

Proposing and delegating (no `--apply`):

| Command | Does |
| --- | --- |
| `wherdr alfred project workflow edit <KEY> < workflow.json` | proposes a new workflow for the project (the whole JSON, guards unchanged). Nothing changes yet: you accept or refuse it in the project's [Workflow tab](project-management.md#workflow), in the same review as a coordinator's proposal. Only on your request in Alfred's chat, never in a wake |
| `wherdr alfred tell <KEY> "<text>"` | sends a message to the project's coordinator, starting it when it does not run, and writes it to the project's log as from Alfred. When Alfred relays your message, the coordinator's turn counts as yours; otherwise as a wake |

So you can ask Alfred "propose a workflow for WEB": it tells WEB's coordinator, reads its reply
with `last`, and reports back; the proposal itself waits for your answer in wherdr.

```text
$ wherdr alfred project template WEB company
{ "dryRun": true, "change": ["project WEB template: none → company"],
  "next": "Show this to the user; only after their yes, run: wherdr alfred project template WEB company --apply" }
```

## Notes

Notes are your whiteboard: short reminders and plans that Alfred and the
coordinators write, and you read. An agent offers a line in its reply ("Add a
reminder: …?"), writes it after your yes, and removes it once its subject is
decided or done. They live in wherdr's data folder (`notes/`), so every device
sees the same ones: one Markdown file per note (a title, a few lines, a scope,
its created and updated dates), plus the longer files they link to, such as
`notes/plans/x.md`. Alfred and every coordinator may list, edit, move and remove any note;
a coordinator adds to its project's home tab unless it names another scope. Every change is
written to `notes/.log.jsonl` with who made it.

| Command | Does |
| --- | --- |
| `wherdr alfred notes list [--scope all\|<tab>]` | the notes (id, title, scope, dates) and the linked files |
| `wherdr alfred notes show <id\|path>` | one note, or one linked file |
| `wherdr alfred notes add "<title>" [--scope all\|<tab>] < lines.md` | adds a note: at most 12 short lines, checkboxes (`- [ ]`) and links allowed; scope `all` (every tab, the default) or one home tab (a tab group or a machine shown as its own tab), by name |
| `wherdr alfred notes edit <id> [--title "<title>"] [--scope all\|<tab>] < lines.md` | changes a note; new lines on stdin replace its own, empty stdin keeps them |
| `wherdr alfred notes remove <id>` | removes a note |
| `wherdr alfred notes file put <folder/name.md> < file.md` | writes a linked file under a folder of the notes, for anything too long for a note |
| `wherdr alfred notes file remove <folder/name.md>` | removes a linked file |

A line may carry badges: `[[WD]]` or `[[WD-12]]` shows a project's key badge (a task id
opens its sheet), and `[[label|icon|colour|link]]` a badge of the agent's own, such as
`[[Waiting|clock|amber]]` or `[[Plan|file||plans/x.md]]`: an icon from a short list (flag,
clock, calendar, alert, info, check, x, pause, star, bug, lightbulb, rocket, eye, lock, link,
file, branch, pr, server, bell), a project palette colour (violet, blue, teal, green, amber,
orange, red, pink), an optional link; an empty field is skipped. Anywhere else the text stays
as written. You read them in the [Notes panel](home.md#notes).

A note links to another note (`[Plan](other-note.md)`), a linked file
(`[Plan](plans/x.md)`) or a place in wherdr (`[WD-12](#/board?task=WD-12)`).
A link that would leave the notes folder (`..`, an absolute path) is refused, and
the answer lists the links that lead nowhere yet. Coordinators have the same
commands as `wherdr pm notes …`, on every note whatever its scope; left out, `--scope`
of `notes add` is the home tab their project shows in (`all` when it shows in every
tab or there is none).

## Suggestions

When Alfred notices a setting you may like, or you have a problem a setting
solves, it suggests it once, highlighted with `wherdr alfred ui open --target`,
and does not bring it up again if you let it pass. Project coordinators do the
same.

When you need something wherdr cannot do, and the need fits wherdr, Alfred or a
coordinator may suggest opening an issue on wherdr's repository, or a pull
request when the fit is clear. It shows you the draft first, with no private
data (no paths, machine names, e-mail addresses, tokens or conversations), and
posts it only on your yes.

## Updating wherdr

The home banner's **Update with Alfred** opens Alfred's conversation and sends, as you,
`Update wherdr to <version>: <release URL>`. For this, or any update request, Alfred reads
[Update with an agent](update-with-an-agent.md) from the installed checkout and the release's
notes (with their *Upgrade notes*), never from memory, shows you the plan and waits for your yes.
It lives in herdr-core, so it outlives wherdr's restart and checks the new version answers.

## After an update

When wherdr starts (after an update too), it rewrites the instructions (`AGENTS.md` and the files
beside it) of Alfred and of every running project coordinator. It sends them no message and wakes
none of them. Each one learns of the update on its next `wherdr alfred` or `wherdr pm` command,
once: the answer starts with the line
`wherdr was updated to <version> since your session started: re-read AGENTS.md and check docs/llms.txt before relying on what you knew`.
The version includes the commit wherdr was built from (`3.0.0+1a2b3c4`), so a rebuild from a
new commit counts as an update too.

Alfred and the coordinators never explain wherdr from memory: they read `docs/llms.txt` (the
docs index) first, then only the sections that answer. These are the docs of the build that runs, wherever
wherdr was started from (see `WHERDR_ROOT` in [Configuration](configuration.md#configuration)).

Alfred answers with this server's own address and port (and its published address, if any),
not the defaults the docs quote. Other commands meant for the server itself (a restart, a
`git pull` of its install) come as text to copy, never with *Run*, which would run them in
Alfred's own folder. `wherdr alfred help` and `wherdr pm help`
list the commands of the wherdr that runs now.
