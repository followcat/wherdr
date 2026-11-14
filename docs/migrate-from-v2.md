# Migrate from v2

[Documentation](README.md) · [Project](../README.md)

wherdr v3 installs **next to** a running wherdr v2: v2 keeps its service, folder, data, port and
address, and stays usable the whole time, so you can compare both and fall back at any moment.
The installer then imports from v2 what v3 can use, and writes a report of what it imported and
what you must redo by hand.

## With an agent (recommended)

Give the [**v3 beside an existing v2** prompt](install-with-an-agent.md#v3-beside-an-existing-v2-with-import)
to a coding agent running on the machine where v2 runs. It looks at the machine, runs the installer
below as a dry run, deals with what is specific to your setup, shows you the plan, installs, checks
both addresses and ends with a summary.

## By hand

On the machine that runs v2, as the same user (Linux with `systemd --user`), with the
[requirements](installation.md#requirements) of v3 met (Node.js 22+, git, herdr-core `hc`):

```sh
git clone -b v3 <the wherdr repository> /tmp/wherdr-setup
sh /tmp/wherdr-setup/scripts/install-v3-beside-v2.sh          # prints what it found and the plan
sh /tmp/wherdr-setup/scripts/install-v3-beside-v2.sh --yes    # does it
```

Without `--yes` (or with `--dry-run`) nothing changes, and every missing prerequisite and conflict
is listed at once. Running it again is safe: what is already done is kept, and the clone it made
moves to the latest `v3` (the plan always shows the commit it builds). `--help` lists the options: `--dir` (default `~/wherdr-v3`), `--name` (`wherdr-v3`),
`--port` (`7684`), `--https-port` (the first port from `8104` that `tailscale serve` does not use), `--hc-session` (`default`), `--no-tailscale`,
`--skip-import`, and `--v2-dir`, `--v2-unit`, `--herdr-bin` when v2 is not
where the installer looks (`--herdr-projects` is ignored: the install reads nothing of herdr-projects).

What it does:

1. **Finds v2** and prints it: the `wherdr.service` user unit (or the unit running v2's launcher),
   `~/wherdr` and `wherdr.env`, its `DATA_DIR` and port, its `tailscale serve` entry and
   Herdr's SSH machines (`herdr machine list`). All of it is only read. The herdr-projects
   board (`~/.herdr-projects`) is not read: [Alfred](#set-up-your-v2-projects-with-alfred) reads it later.
2. **Checks** Node.js 22+, git, npm, `systemctl --user`, `hc` (it never installs it: its official
   installer is `curl -fsSL https://releases.herdr.dev/core/install.sh | sh`, into `~/.local/bin`), and that the port, folder,
   service names and HTTPS port are free.
3. **Starts herdr-core** as the `wherdr-v3-hc` user service (`hc server start` with `HC_SESSION`),
   unless that session already runs. Started by systemd, it never inherits an agent's environment.
4. **Clones and builds** v3 in `~/wherdr-v3/src` (log: `~/wherdr-v3/build.log`), with its own
   data folder `~/wherdr-v3/data`. The build needs about 1.5 GB of memory: on a small machine
   (a Raspberry Pi), where Node's heap is smaller, it builds with
   `NODE_OPTIONS=--max-old-space-size=1536` under `nice -n 19 ionice -c3`.
5. **Imports from v2** (below), then starts the `wherdr-v3` user service on `127.0.0.1:7684`, with its HTTPS
   address as `APP_URL` and the `OOMScoreAdjust`, `MemoryLow` and `CPUWeight` of v2's unit (or
   `-900`, `256M` and `200`). A user service cannot lower its own OOM score: a negative
   `OOMScoreAdjust` is ignored unless a tool run as root sets it (a guard script, for example).
6. **Adds** `tailscale serve --bg --https=<port> http://127.0.0.1:7684` to the existing serve
   configuration (v2's entry stays). When Tailscale refuses, it prints the command to run once
   (`sudo tailscale set --operator=$USER`) instead of using `sudo`.
7. Writes `~/wherdr-v3/update.sh`: fetch v3, rebuild (with the same memory rule), restart.

The last `NEXT` lines say how to add the first passkey: its token is in the service's log,
`journalctl --user -u wherdr-v3 | grep 'First passkey' | tail -1`.

Each step prints one line (`OK`, `SKIP`, `PLAN`); a problem is one `ERROR <id>: …` line, and
what is left for you is a `NEXT: …` line. `--json` prints one summary object. Exit codes: `0`
done or plan printed, `2` bad option, `3` missing prerequisite, `4` conflict, `5` a step failed,
`6` installed but something is left for you.

## What is imported

| From v2 | In v3 |
| --- | --- |
| herdr-projects repos, with their open tasks (to do, under way, waiting) | Nothing: the import does not read `~/.herdr-projects`. [Alfred](#set-up-your-v2-projects-with-alfred) reads the board when you set up your projects with it. |
| Herdr SSH machines | herdr-core machines (`hc machine add` with the same target) when SSH logs in there without a password; otherwise the report says what is missing. The name is made valid for hc (1-32 of a-z 0-9 - _ ., unique), and the report shows a change (`Beast → beast`). hc is looked for on the PATH, in `~/.local/bin` and in `/opt/homebrew/bin`; when it is not seen there, `hc machine add` is still tried and its own error is reported. A Herdr machine aimed at this machine itself (its host name, tailnet name, `HOST_LABEL` or `HERDR_WEB_SELF_HOSTS`, as v2 knew them) is not added: it is v3's local machine. |
| Synced settings (appearance, home, conversation, files, notification rules), Do not disturb, this machine's name, recent folders | The same settings in v3. A setting already set in v3 is never replaced. Recent folders leave out herdr-projects' own folders (under `~/.herdr-projects`, or `HERDR_PROJECTS_HOME`) and the app folders of wherdr v2, v3 and herdr-web; **New agent** never offers a herdr-projects folder an earlier import copied. The machine tabs' order, hidden items and groups name each v2 machine by its v2 id: the import turns each into the v3 machine made from it (same SSH target), v2's own machine into v3's local one, and drops those with none; the report lists them. |

Not moved, to do again in v3: **passkeys** (add one in v3 on each device), **devices and push
notifications** (install the app from v3's address and turn notifications on), per-device settings
kept in each browser, the board's own settings, and what only v2 has (Herdr sessions, plugins,
worktrees, one-tap update).

The report is `~/wherdr-v3/data/migration-report.md`: what was imported, skipped, and the to-do
list. It is also the list of what v3 lacks compared with your v2.

To import again later (for instance after adding SSH keys), without reinstalling:

```sh
node ~/wherdr-v3/src/scripts/v2-import.mjs import --data-dir ~/wherdr-v3/data --dry-run
node ~/wherdr-v3/src/scripts/v2-import.mjs import --data-dir ~/wherdr-v3/data
```

It skips what is already imported. `detect` instead of `import` only prints what it finds of v2.

## Set up your v2 projects with Alfred

The import brings none of your v2 projects: you choose which ones come over, and how. In its first
message, [Alfred](home.md#alfred) sees that this machine has a herdr-projects board with projects and offers
to bring them all over in one go. It reads the board then (`wherdr alfred v2`, read
only): each project's suggested key, folder (and whether it is on this machine), `workspace.from`
as the base branch, its open tasks with their stage, branch and PR (done and archived ones are left out), and the board settings
to redo in its workflow (reviewer, merge, worker…). Alfred asks you to switch Projects on first when they are off.

Its reply carries **one card for all the projects** (`wherdr alfred v2 import --propose`): one line
each, with its key, name, machine and folder, and a checkbox, on by default; a project whose folder
cannot be added (not found, not a git repository) says why and has none. Below them, **Start their
coordinators**, on by default. *Apply* adds every checked project on this machine, with its v2 base
branch, then starts their coordinators; one that fails does not stop the others, and the card then
lists each project: added, coordinator started, or the error.

No workflow is needed first: each project starts with the minimal default workflow, and its new
coordinator's first message looks at the repository and proposes a workflow, saying why, which
you accept or refuse (its v2 settings to redo in mind). Then, per project, by its
coordinator or by Alfred (for all projects at once, if you like):

- its folder on another machine, when the repository is not on the machine v2 ran on (`project add` there);
- what its v2 coordinator knew. v2 coordinators keep no memory file, so when the project's v2
  coordinator exists, Alfred offers once a handover: a prompt to paste to it in v2 ("Write a handover
  note, at most 25 lines: decisions and preferences, conventions, open work and where it stands, what
  to avoid."). Paste its answer back to Alfred: it shows the lines it will add to the end of the new
  coordinator's `memory.md` and adds them after your yes. Declined, nothing happens. The v2
  coordinator's autopilot goal, when it has one, comes as one line of that `memory.md` too
  (`wherdr alfred project memory`). v2's conversations are never read;
- which of its open v2 tasks to add again (each description starts with "From v2 WHR-37.");
  each comes back as a task to do, whatever its v2 stage;
- for an under-way or waiting task, its branch and PR are kept: its description starts with
  "From v2 WHR-37. Continue from branch `feat/x` / PR #12.", and its worker starts from that
  branch, so it pushes to the same PR, when the remote still has the branch. When the remote
  no longer has it, the worker starts from the base branch, and the task's history and its
  instructions say so. When the remote cannot be reached, the task waits and starts again later;
- its guards and the other machines its tasks may run on, when its v2 settings call for them.

Alfred shows each other change before making it, and makes it only after your yes. You can also ask it
later; `wherdr alfred v2` lists the v2 projects, as the board has them now, and the v3 project made from each. A user who
does not come from v2 sees none of this.

## Auto-deploy from a build machine

A small machine (a Raspberry Pi) does not have to build v3. Another machine of the tailnet
builds each new commit of `v3` once and serves it; the Pi pulls it within a few minutes.
Nothing is published anywhere: the builds stay on the tailnet.

**On the build machine** (any Linux machine with Node.js 22+, git, `systemd --user` and
Tailscale; it never runs on the Pi), `scripts/v3-builder.sh` keeps its own clone in
`~/wherdr-v3-builder/src`, builds `origin/v3` when it moves (under `flock /tmp/wherdr-heavy.lock`),
packs it with `scripts/pi-v3-package.sh` (the archive holds no native code, so a build made on
x86 runs on arm64), keeps the last 5 builds and serves `~/wherdr-v3-builder/www` read-only
with `tailscale serve`:

```sh
sh scripts/v3-builder.sh setup          # prints the plan
bash scripts/v3-builder.sh setup --yes  # timer every 3 min + tailscale serve on https port 8110
```

It prints the Pi's source URL, `https://<machine>.<tailnet>.ts.net:8110/`. Log:
`~/wherdr-v3-builder/builds.log` (output of the last build: `last-build.log`); state:
`bash ~/wherdr-v3-builder/v3-builder.sh status`. Off: `systemctl --user disable --now
wherdr-v3-builder.timer` (`enable --now` turns it back on); `bash ~/wherdr-v3-builder/v3-builder.sh remove --yes`
also removes the serve entry. A build that fails is not retried; the next commit is.

**On the Pi**, install (or re-run the installer) with the source URL:

```sh
sh /tmp/wherdr-setup/scripts/install-v3-beside-v2.sh --auto-deploy https://<build machine>.<tailnet>.ts.net:8110/ --yes
```

The installer then never builds: it installs the latest build from that URL, and the
`wherdr-v3-deploy.timer` runs `~/wherdr-v3/pi-deploy-v3.sh` every 3 minutes. When the source's
`COMMIT` is not the installed one, it downloads the archive, checks its checksum, swaps
`~/wherdr-v3/src/.output` (the running build is kept in `~/wherdr-v3/deploy/previous`),
restarts `wherdr-v3` and checks that `/api/health` answers the new commit. If not, it puts the
previous build back and does not try that commit again. It waits for `/tmp/wherdr-heavy.lock`
and touches only `~/wherdr-v3/src/.output`, `~/wherdr-v3/deploy` and the `wherdr-v3` service:
v2 is never touched. Once on, re-runs of the installer keep it.

- Log: `~/wherdr-v3/deploy/deploy.log` (one line per deploy, rollback or error), and
  `journalctl --user -u wherdr-v3-deploy`.
- State: `bash ~/wherdr-v3/pi-deploy-v3.sh status` (installed, source, skipped commit).
- Deploy now: `~/wherdr-v3/update.sh`.
- Roll back: `bash ~/wherdr-v3/pi-deploy-v3.sh rollback` puts the previous build back; the
  timer skips the rolled-back commit until a newer one is built.
- Off: `systemctl --user disable --now wherdr-v3-deploy.timer`; `enable --now` turns it back on.

## Fall back to v2

Nothing changes for v2: keep using its address (for example `https://<machine>.<tailnet>.ts.net:8103`).
To stop v3 for a while: `systemctl --user stop wherdr-v3`; `start` brings it back.

v3 is not a Herdr plugin and never replaces the v2 plugin. On a v3 commit, `herdr plugin install`
and `herdr plugin update` of wherdr fail at the build, before changing anything: Herdr keeps the
v2 plugin it had, and the build output says how to install v3. `herdr plugin install` with
`--ref 2.x` installs v2 from its branch. The `curl … | sh` installer of the v3 tree installs
nothing either: it prints the commands of [By hand](#by-hand).

## Uninstall v3

```sh
sh ~/wherdr-v3/src/scripts/install-v3-beside-v2.sh --uninstall          # prints what it would remove
sh ~/wherdr-v3/src/scripts/install-v3-beside-v2.sh --uninstall --yes    # removes it
```

It removes only what the installer created, as listed in `~/wherdr-v3/install-manifest.json`:
its `tailscale serve` entry, the `wherdr-v3` and `wherdr-v3-hc` services (stopping the hc session
it started, and its state when the installer created it), the machines it added to an hc session
it did not start, and the `~/wherdr-v3` folder. `--keep-data` keeps `~/wherdr-v3/data`. Pass the
same `--dir` and `--name` as for the install. v2 is not touched.
