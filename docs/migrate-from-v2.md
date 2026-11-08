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
`--skip-import`, and `--v2-dir`, `--v2-unit`, `--herdr-projects`, `--herdr-bin` when v2 is not
where the installer looks.

What it does:

1. **Finds v2** and prints it: the `wherdr.service` user unit (or the unit running v2's launcher),
   `~/wherdr` and `wherdr.env`, its `DATA_DIR` and port, its `tailscale serve` entry, the
   herdr-projects board (`~/.herdr-projects`) and Herdr's SSH machines (`herdr machine list`).
   All of it is only read.
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
| herdr-projects repos | Projects (Settings › Projects): name, folder, key, and `workspace.from` as the base branch. Each needs a template before its tasks can start; the report lists the board settings to redo in it (reviewer, merge, worker…). Folders that no longer exist are skipped. |
| Open board tasks (to do, under way, waiting) | Tasks to do in their project, with title, description and creation date. A task keeps its v2 number (WHR-37 stays WHR-37) when that number is free in v3; otherwise it takes the next free one and its description starts with "From v2 WHR-37.". Done and archived tasks are not imported. |
| Herdr SSH machines | herdr-core machines (`hc machine add` with the same target) when SSH logs in there without a password; otherwise the report says what is missing. The name is made valid for hc (1-32 of a-z 0-9 - _ ., unique), and the report shows a change (`Beast → beast`). hc is looked for on the PATH, in `~/.local/bin` and in `/opt/homebrew/bin`; when it is not seen there, `hc machine add` is still tried and its own error is reported. |
| Synced settings (appearance, home, conversation, files, notification rules), Do not disturb, this machine's name, recent folders | The same settings in v3. A setting already set in v3 is never replaced. The machine bar's order, hidden items and groups name each v2 machine by its v2 id: the import turns each into the v3 machine made from it (same SSH target) and drops those with none; the report lists both. |

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
