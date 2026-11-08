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
| `wherdr alfred templates` | the saved templates |
| `wherdr alfred machines` | the machines herdr-core knows (key, label, status); `""` is this machine |
| `wherdr alfred coordinators` | each coordinator, its agent and whether it runs |
| `wherdr alfred coordinator open <KEY>` | the link that opens a running project coordinator |
| `wherdr alfred settings` | the synced settings, their values, and the values each setting Alfred may change accepts (`1` on, `0` off) |
| `wherdr alfred help` | this list |

Changing (show, then do):

| Command | Does |
| --- | --- |
| `wherdr alfred project add <KEY> --machine <key> --path <folder> [--name <name>] [--template <id>]` | adds a project: a git folder inside the home folder of a machine, not already a project (on this machine, checked before the yes too) |
| `wherdr alfred project template <KEY> <id\|none>` | gives the project a template, or none |
| `wherdr alfred coordinator start <KEY> [--program claude\|codex]` | starts the project's coordinator with its harness's default model; without `--program`, the user's first offered agent that can run it (Settings › Agents) (a new conversation replaces a running one) |
| `wherdr alfred setting set <key> <value>` | changes a setting to one of the values `settings` lists for it (a theme id from the theme list, for instance); lists such as machine groups or hidden agents stay in Settings |

A change without `--apply` changes nothing: it prints what it would do (`dryRun`, `change`) and
the command that makes it. Alfred shows you those lines and runs that command, with `--apply`,
only after your yes in the chat. When the answer names a `remote` machine (a project on another
machine, its coordinator), Alfred makes the change only when you asked for it. No `wherdr alfred`
command deletes anything: removing a project, a template or a setting stays yours, in Settings.
The one removal a coordinator has is `wherdr pm task remove`, for a task never started.

```text
$ wherdr alfred project template WEB company
{ "dryRun": true, "change": ["project WEB template: none → company"],
  "next": "Show this to the user; only after their yes, run: wherdr alfred project template WEB company --apply" }
```
