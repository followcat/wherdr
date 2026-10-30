# Installation and updates

**Upgrading to 2.0.0?** Read the [release notes](release-notes-2.0.0.md) for breaking changes and the 1.x migration checklist.

[Documentation](README.md) · [Project](../README.md)

## Requirements

- **Herdr ≥ 0.9.1** running on the server (`herdr` or `herdr server`), with its Claude Code /
  Codex / omp integrations installed if you use them (`herdr integration install claude|codex|omp`).
  omp's conversation is only found through its integration, which reports the session file.
- **Linux or macOS** server with **Node.js 22** or newer (the installer offers to install it).
  wherdr runs natively, as the user who runs Herdr.
- **HTTPS** to use passkeys, push notifications and the installable app from another device.
  Browsers only allow them on `https://` or `http://localhost`. The easiest way is
  [`tailscale serve`](https://tailscale.com/kb/1312/serve); a reverse proxy **reachable only
  from your private network** with a valid certificate also works (see
  [Other private networks](networks.md#other-private-networks)).

## Installation

### Ask your AI agent

**Recommended.** Paste this into Claude Code, Codex or any coding agent: it installs and sets up wherdr for you.

```text
Read https://wherdr.dev/agent.md and help me set up wherdr. Check what is already installed first, and ask me before installing anything.
```

It follows [our setup guide for agents](https://wherdr.dev/agent.md): checks what you already have,
asks before installing anything, sets up your phone over Tailscale, never exposes wherdr to the Internet.

<a id="the-one-command"></a>

### Or run the installer yourself

On the computer that runs Herdr, as your user, on macOS or Linux:

```sh
curl -fsSL https://wherdr.dev/install | sh
```

The script ([read it first](https://wherdr.dev/install), source in
[`website/public/install`](../website/public/install)) never uses sudo. It:

1. checks **Herdr ≥ 0.9.1**; without it, it stops with the link to [herdr.dev](https://herdr.dev);
2. leaves alone a wherdr that **already answers** on the port: a Herdr plugin install is offered
   its update, anything else is left as it is;
3. checks **Node.js 22** or newer (or Bun), in your `PATH` and in the folders of n, nvm, fnm,
   Volta, asdf and Homebrew. Without it, it asks before installing it: `brew install node` on a
   Mac with Homebrew, otherwise the official Node.js 22 build from nodejs.org, its checksum
   checked, unpacked in `~/wherdr/node` (used by wherdr only: your `PATH` is not changed). With
   musl libc (Alpine) it gives the install links instead;
4. runs `herdr plugin install afloury/wherdr --yes`: the [Herdr plugin](plugins.md#install-as-a-herdr-plugin)
   downloads the GitHub release package of its version (checksum checked, no wait for npm),
   installs it in `~/wherdr/app`, starts it on `http://localhost:7683`, opens the setup guide in
   your browser (first install) and binds **prefix+i** to its panel;
5. configures automatic startup with `wherdr service install`: **at login on macOS** with a
   LaunchAgent; **at boot on Linux when lingering is enabled**, otherwise **at login**, with a
   `systemd --user` unit. It tries to enable lingering (`loginctl enable-linger`, allowed for
   your own user without sudo on most systems), which also keeps wherdr running after logout.
   Without lingering, wherdr stops after logout. The installer checks lingering after installation
   and reports which case applies, or says when it cannot verify it. The service gets
   your login shell's `PATH`, so the agents you installed in `~/.local/bin`, `~/.bun/bin`,
   `~/.cargo/bin`, `~/.npm-global/bin` or Homebrew are found (see [Agent PATH](installation.md#agent-path)). Each
   run installs it again, with the `PATH` of now. If this step fails (no systemd), nothing of it
   is left, wherdr is started again and keeps starting with Herdr, and the script says how to
   retry;
6. on a computer **without a screen** (no `DISPLAY` on Linux, or an SSH session): opens nothing,
   prints the local address, an `ssh -L` tunnel to reach it from your computer, and the phone
   steps (`wherdr phone`: Tailscale state, the address, the QR code once it answers). Run the
   command again at any time to check the phone address.

Settings, as environment variables (`curl -fsSL https://wherdr.dev/install | WHERDR_PORT=7684 sh`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `WHERDR_DIR` | `~/wherdr` | Install folder (plugin settings, data, log). |
| `WHERDR_PORT` | `7683` | Local port. |
| `WHERDR_SERVICE` | — | `off`: no login service; wherdr then starts with Herdr only (the plugin's startup hook). |
| `WHERDR_YES` | — | `1` answers yes to every question (non-interactive use), installing Node.js included. |
| `WHERDR_NO_BROWSER` | — | `1` never opens a browser. |
| `WHERDR_REF` | main | Git tag or branch of the plugin. |
| `WHERDR_PLUGIN` | `afloury/wherdr` | A local checkout to link and build instead (development, tests). |

Update: run the command again (it offers the update), **U** in the wherdr panel, or **Update** in
the app: all three fetch the GitHub release package directly.

#### Agent PATH

systemd and launchd start services with a short system `PATH`, and herdr-projects, run by
wherdr for the Board, then reports `claude is not installed here` for an agent installed in a
user folder. wherdr gives it the `PATH` an interactive login shell would have, on the host and
over SSH, in this order: the `PATH` your login shell gives (asked once by `wherdr service
install`), the one herdr-projects records in `~/.herdr-projects/data/env.json`
(`$HERDR_PROJECTS_DATA_DIR`, or `$HERDR_PROJECTS_HOME/data`), then `~/.local/bin`, `~/.bun/bin`,
`~/.cargo/bin`, `~/.npm-global/bin`, `~/.deno/bin`, `~/.volta/bin`, `~/bin`, Homebrew's folders and
`/usr/local/bin` when they exist, then the `PATH` it was started with and the system folders. Your
own folders come before the system ones, as in your shell: an old system-wide copy of an agent
never wins over yours. After installing
an agent somewhere else, run `wherdr service install` again (or the one command).

### Which setup?

| | **Always-on server + Tailscale** (recommended) | **One computer** |
| --- | --- | --- |
| Runs on | A machine that never sleeps: Raspberry Pi, mini-PC, home server, private VPS (Linux) | The computer you work on (macOS or Linux) |
| Reach it from | Your phone and every computer on your tailnet | That computer only (`http://localhost:7683`) |
| Installable app, push notifications, passkeys | Yes (private HTTPS from `tailscale serve`) | Desktop browser only; no phone access |
| Other machines (a Mac, a laptop…) | Added in Herdr over SSH, shown in wherdr | Also possible, but they are only reachable while this computer is awake |

Both use [the one command](installation.md#the-one-command) and the same app. You can start with the second one
and move to the first later.

### Moving from Docker to the native service

wherdr 2.0 runs only natively as your user. Published 1.x images remain on GHCR for users
staying on 1.x. To keep your port, passkeys and settings when moving, follow the
[Docker migration guide](migrate-from-1.x-docker.md): verifiable steps, with a way back,
that you can also hand to an AI agent ("read this file and migrate me").

## Updating

wherdr checks the latest GitHub release at most once a day (an anonymous request to
`api.github.com`, nothing is sent) and shows a small **“wherdr X.Y.Z is available”** banner on the
home screen and in Settings › About, with the release notes and the exact command for your setup.
Hide it until the next version with ×. Set `WHERDR_UPDATE_CHECK=off` to disable the check. The
installed version is shown in Settings › About. The installer marks its service
with `WHERDR_INSTALL` (`native`, `npm`, `npm-global`, `brew`, `plugin`) so the
banner offers the right one-tap command; a source build without it stays native
and only shows the rebuild instructions.

GitHub release packages (including the bundled agent skill) and Homebrew
updates are published without waiting for npm moderation. Native plugin installs and updates
use the GitHub `.tgz` and verify its SHA-256 checksum before extraction. A failed one-tap
download or checksum check leaves the running version in place. Plugin installation tries
GitHub first, then the prebuilt npm package of the exact same version (with its registry integrity hash), and only builds from source when neither works.
This also keeps older 1.3.x releases without GitHub archives installable with Node.js or Bun.
Packages predating the bundled skill retain the plugin checkout's commands and skill, so
skill refresh, installation and uninstallation remain available.
The installer fetches `main` explicitly unless you set `WHERDR_REF`.

The SHA-256 checksum detects damaged downloads. It is served beside the archive, so someone
who can replace both files can make them match; it does not prove the publisher’s identity
or protect against replacement of the archive and checksum together.

`npm install -g`, `npx`, `bunx` and `pnpm dlx` still need npm to serve the wherdr package.
Their banner waits for registry availability; Homebrew's banner waits for its formula.
Versions through 1.3.2 use GitHub's `latest` marker and an npm-based updater. That marker only
advances once npm **and** Homebrew are ready, so their existing Update button continues to work.
To update an older native plugin earlier, rerun the installer or press **U** in its Herdr panel.
See [Releasing](RELEASING.md) for the publication order and recovery steps.

**Update in one tap.** When wherdr runs from the Herdr plugin (Node.js mode), a global npm install
or Homebrew, the banner has an **Update** button instead of the command, on every device that can
open wherdr (this computer and your tailnet; unlocked, when a passkey is set). wherdr installs the new version in a
process of its own, restarts, and checks that `/api/health` reports the new version within 60
seconds; the app shows the progress and reloads on the new version. If the new version does not
answer, wherdr goes back to the previous one by itself (the plugin keeps the previous copy in
`~/wherdr/app.prev`, npm reinstalls the previous version, Homebrew points back to the previous keg)
and the app says so. Every step is logged in `~/wherdr/update.log`.

| Setup | What Update does |
| --- | --- |
| The one command / Herdr plugin, Node.js | Verifies and unpacks the GitHub release package of the new version into `~/wherdr/app`, keeps the old copy, restarts (the login service included) |
| `npm install -g wherdr` | `npm install -g wherdr@X.Y.Z`, then restarts (login service included) |
| Homebrew | `brew upgrade wherdr`, then `brew services restart wherdr` |

`npx wherdr` runs from a temporary folder: run `npx wherdr@latest` again.

| Setup | Update command (in the wherdr folder) |
| --- | --- |
| The one command | Run `curl -fsSL https://wherdr.dev/install \| sh` again: it offers the update (GitHub release package) |
| Herdr plugin, Node.js | **U** in the **wherdr** panel, or `herdr plugin install afloury/wherdr --yes` (wherdr restarts on the new version) |
| `wherdr` command (npm) | `npm install -g wherdr@latest && wherdr restart` (npx: stop it, then `npx wherdr@latest`) |
| `wherdr` command (Homebrew) | `brew upgrade wherdr`, then `brew services restart wherdr` |
| From source | `git pull && npm ci && npm run build`, then restart wherdr |
