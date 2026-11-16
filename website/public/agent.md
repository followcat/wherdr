# Setting up wherdr 3 — a guide for coding agents

> If your fetch tool summarizes, read the raw file with `curl -fsSL https://wherdr.dev/agent.md`.

You are helping your user install **wherdr 3**: a self-hosted web app and phone PWA for the coding
agents running in [herdr-core](https://github.com/herdrdev/herdr-core) (hc), with built-in project
management. It installs from the `v3` branch of https://github.com/afloury/wherdr as a systemd user
service, reachable over Tailscale HTTPS, **beside** a wherdr 2 that may already run there.

## Rules

1. **Security first.** wherdr is a remote shell on that machine. Never expose it: no port
   forwarding, no public proxy, no ngrok, no `tailscale funnel`, no plain HTTP on the local
   network. Other devices use `tailscale serve` only (private HTTPS inside the user's tailnet).
2. **Never touch wherdr 2**: its service, folder, data, port, Herdr or its `tailscale serve` entry.
   Read them only.
3. **Ask before** installing anything (hc, Node.js, Tailscale) and before any `sudo`. Never start
   hc from your own shell: the installer runs it as a user service.
4. Run every command on the machine where wherdr will run, as the user.

## 1. Pick the prompt

The step-by-step instructions are the prompts of
https://github.com/afloury/wherdr/blob/v3/docs/install-with-an-agent.md: **New install of v3**, or
**v3 beside an existing v2, with import** when a wherdr 2 runs here. Follow the one that fits; the
steps below are their summary.

## 2. Detect

```sh
node --version           # 22 or newer
git --version
hc --version             # missing: tell the user, propose hc's official installer, wait
systemctl --user status  # the install script needs systemd --user (Linux)
tailscale status
tailscale serve status
```

On macOS there is no install script: follow
https://github.com/afloury/wherdr/blob/v3/docs/installation.md#on-macos.

## 3. Install

```sh
git clone -b v3 https://github.com/afloury/wherdr.git "${TMPDIR:-/tmp}/wherdr-setup"
sh "${TMPDIR:-/tmp}/wherdr-setup/scripts/install-v3-beside-v2.sh" --json
```

Without `--yes` it changes nothing and prints its plan; each problem is one `ERROR <id>: ...` line,
and `NEXT: ...` lines are for the user. Fix what it cannot do itself (ask first), dry-run again
until it exits 0, show the plan to the user, then run the same command with `--yes`.

## 4. Check and finish

Check the health URL, the HTTPS address and the services the summary names. Then tell the user, in a
few lines: the address, how to update (`<dir>/update.sh`, or **Update with Alfred** in the app's
banner) and what is left for them:

- **Passkey lock** (optional, only if the user asks): on the HTTPS address, with the token of the
  last `First passkey` line of the service's journal.
- **On the phone**: open the address in Safari (Share › Add to Home Screen) or Chrome on Android
  (menu › Install app), then Settings › **Enable notifications**.

## More

- Updating: https://github.com/afloury/wherdr/blob/v3/docs/update-with-an-agent.md
- Moving from wherdr 2: https://github.com/afloury/wherdr/blob/v3/docs/migrate-from-v2.md
- Something fails: https://github.com/afloury/wherdr/blob/v3/docs/troubleshooting.md
- All the docs: https://github.com/afloury/wherdr/blob/v3/docs/README.md
