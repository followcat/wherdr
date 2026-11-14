# Install with an agent

[Documentation](README.md) · [Project](../README.md)

The easiest way to install, migrate or update wherdr v3 is to give one of the prompts below to
a coding agent (Claude Code, Codex…) **running on the machine where wherdr will run**, as your
user. The agent uses the installer script ([`scripts/install-v3-beside-v2.sh`](../scripts/install-v3-beside-v2.sh))
for the standard steps and handles what differs from one machine to another: where v2 lives, an
unusual service, a missing herdr-core build, the Node.js version, Tailscale rights, SSH keys of
your other machines. It never touches v2 and asks you before any `sudo`.

To do it yourself instead, follow [Installation](installation.md#installation) or
[Migrate from v2](migrate-from-v2.md#by-hand).

Copy the whole block of your case. In the prompts, `REPO` is this GitHub repository
(the page you copy the prompt from); replace it with its address.

## New install of v3

```text
Install wherdr v3 (the web app for herdr-core) on this machine, from the v3 branch of REPO, as a systemd user service reachable over Tailscale HTTPS.

Rules:
- Work as my user. Never run sudo without asking me first, with the exact command and why.
- Never install herdr-core (hc), Node.js or Tailscale silently: tell me what is missing, how to get it for this OS and architecture, and wait. If hc is missing, propose its official installer, `curl -fsSL https://releases.herdr.dev/core/install.sh | sh` (it installs into ~/.local/bin, without sudo); read it first.
- Never start hc from your own shell: the installer starts it as a systemd user service, so it does not inherit your agent environment.

Steps:
1. Look at the machine first: OS and architecture, node --version (22 or newer), git, npm, hc --version, systemctl --user status, tailscale status and tailscale serve status, ports in use (ss -ltn), and whether a wherdr already runs here. If a wherdr v2 runs here, stop and tell me: the "beside v2" prompt is the right one.
2. git clone -b v3 REPO "${TMPDIR:-/tmp}/wherdr-setup"
3. Dry run: sh "${TMPDIR:-/tmp}/wherdr-setup/scripts/install-v3-beside-v2.sh" --skip-import --json
   It checks everything at once: each problem is one line "ERROR <id>: ...". Read the plan: the commit it builds, and the HTTPS port it picked (the first one from 8104 that tailscale serve does not use yet; never assume 8104). Exit codes: 0 plan ready, 3 missing prerequisite, 4 conflict (pick another --port, --https-port, --dir or --name: the ERROR line names a free one), 5 a step failed, 6 installed but something is left for me. "NEXT: ..." lines are for me. On a small machine (a Raspberry Pi) the build needs about 1.5 GB of memory: the script raises Node's heap for it and says so in the plan.
4. Fix what the script cannot do itself (ask me first when it needs sudo or changes things outside the install folder), then dry-run again until the exit code is 0.
5. Show me the plan, then run the same command with --yes.
6. Check: curl -fsS http://127.0.0.1:<port>/api/health, the HTTPS address of the summary, systemctl --user status <name> <name>-hc.
7. End with a short summary: the URLs you checked and their answers, the services, what I must still do (the first passkey, with the token from journalctl --user -u <name> | grep 'First passkey' | tail -1; then a passkey, the app and notifications on each device; NEXT lines), and how to update (<dir>/update.sh) and uninstall (install-v3-beside-v2.sh --uninstall --yes, same --dir and --name).
```

## v3 beside an existing v2, with import

```text
Install wherdr v3 (the web app for herdr-core) on this machine NEXT TO the wherdr v2 that already runs here, from the v3 branch of REPO, and import what v3 can use from v2 (Herdr SSH machines, settings, recent folders; nothing of herdr-projects: Alfred sets up my v2 projects with me later). v2 must keep running untouched so I can compare and fall back.

Rules:
- Never stop, restart, change, move or delete anything of wherdr v2: its service, its folder (usually ~/wherdr), its data, its port, Herdr, the herdr-projects board, or its tailscale serve entry. Read them only.
- Work as my user. Never run sudo without asking me first, with the exact command and why.
- Never install herdr-core (hc), Node.js or Tailscale silently: tell me what is missing, how to get it for this OS and architecture, and wait. If hc is missing, propose its official installer, `curl -fsSL https://releases.herdr.dev/core/install.sh | sh` (it installs into ~/.local/bin, without sudo); read it first.
- Never start hc from your own shell: the installer starts it as a systemd user service, so it does not inherit your agent environment.

Steps:
1. Look at the machine first: OS and architecture, node --version (22 or newer), git, npm, hc --version, systemctl --user status, tailscale status and tailscale serve status, ports in use (ss -ltn). Find v2: systemctl --user cat wherdr (or another unit running wherdr), ~/wherdr/wherdr.env, its DATA_DIR and port, curl -fsS http://127.0.0.1:<v2 port>/api/health, herdr machine list.
2. git clone -b v3 REPO "${TMPDIR:-/tmp}/wherdr-setup"
3. Dry run: sh "${TMPDIR:-/tmp}/wherdr-setup/scripts/install-v3-beside-v2.sh" --json
   If v2 is not where the script looks, pass --v2-dir, --v2-unit or --herdr-bin. It checks everything at once: each problem is one line "ERROR <id>: ...". Read the plan: the v2 it found, the machines it will import, the commit it builds, and the HTTPS port it picked (the first one from 8104 that tailscale serve does not use yet; never assume 8104). Exit codes: 0 plan ready, 3 missing prerequisite, 4 conflict (pick another --port, --https-port, --dir or --name: the ERROR line names a free one), 5 a step failed, 6 installed but something is left for me. "NEXT: ..." lines are for me. On a small machine (a Raspberry Pi) the build needs about 1.5 GB of memory: the script raises Node's heap for it and says so in the plan.
4. Fix what the script cannot do itself: a missing hc build, an old Node, Tailscale operator rights, SSH key login to each machine (ssh <target> true must answer without a password, with hc installed there; do not change the PATH there when the import found hc). Ask me first when it needs sudo or changes anything outside the new install folder. Dry-run again until the exit code is 0.
5. Show me the plan, then run the same command with --yes.
6. Check: curl -fsS http://127.0.0.1:<v3 port>/api/health, the HTTPS address of the summary, systemctl --user status <name> <name>-hc, and that v2 still answers on its port and its HTTPS address. Read <dir>/data/migration-report.md.
7. End with a short summary: the URLs you checked (v2 and v3) and their answers; projects, tasks and settings imported; machines added, and those missing with what to do for each; what I must still do by hand (the first passkey, with the token from journalctl --user -u <name> | grep 'First passkey' | tail -1; then a passkey, the app and notifications on each device; the report's To do lines); how to update (<dir>/update.sh), fall back (keep using v2's address) and uninstall (install-v3-beside-v2.sh --uninstall --yes, same --dir and --name).
```

## Update v3

The home banner's **Update with Alfred** does this with Alfred, following
[Update with an agent](update-with-an-agent.md), which also reads the release's *Upgrade notes*.

```text
Update the wherdr v3 that runs on this machine to the latest v3 branch, keeping its data.

Rules:
- Work as my user. Never run sudo without asking me first. Never touch a wherdr v2 that may run here.
- Never start or restart hc (herdr-core) yourself: its terminals and agents keep running across a wherdr update.

Steps:
1. Find how v3 runs: systemctl --user cat wherdr-v3 (or the unit whose ExecStart runs .output/server/index.mjs with HC_SOCKET), its WorkingDirectory, DATA_DIR and PORT. Note the version: curl -fsS http://127.0.0.1:<port>/api/health.
2. Back up the data folder: cp -a <DATA_DIR> <DATA_DIR>.bak-$(date +%F).
3. If the install folder has update.sh (made by install-v3-beside-v2.sh), run it. Otherwise, in the checkout: git pull, npm ci, npm run build, then systemctl --user restart <unit>. The build needs about 1.5 GB of Node heap: if node -p 'require("v8").getHeapStatistics().heap_size_limit' is smaller, build with NODE_OPTIONS=--max-old-space-size=1536 (update.sh does it itself).
4. Check: the health URL answers, the HTTPS address answers, systemctl --user status <unit> is active, and journalctl --user -u <unit> -n 50 shows no error.
5. End with a short summary: old and new version (git commit), URLs checked, the backup's path, and anything I must do.
```
