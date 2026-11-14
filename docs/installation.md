# Installation and updates

[Documentation](README.md) · [Project](../README.md)

This page covers **wherdr v3** on herdr-core. The one-command installer, the Herdr plugin, the
npm and Homebrew packages, the one-tap update and Docker belong to wherdr v2: see the
[v2 installation guide](https://github.com/afloury/wherdr/blob/main/docs/installation.md).

## Requirements

- **An hc session** (herdr-core) running on the server, with protocol generation 1 and the
  methods listed in [herdr-core › Setup](core.md#setup). Know its socket path: wherdr needs it in
  `HC_SOCKET`. To install hc: `curl -fsSL https://releases.herdr.dev/core/install.sh | sh` (into `~/.local/bin`).
- **Linux or macOS** with **Node.js 22** or newer and Git. wherdr runs as the user who runs hc.
  The build needs about 1.5 GB of memory: on a small machine (a Raspberry Pi), build with
  `NODE_OPTIONS=--max-old-space-size=1536`.
- The agents you use (Claude Code, Codex) installed on each machine, in a folder of the usual
  user `PATH` (`~/.local/bin`, `~/.bun/bin`, `~/.cargo/bin`, `~/.npm-global/bin`, Homebrew…):
  agents are started through the machine's shell with those folders added.
- **HTTPS** to use passkeys, push notifications and the installable app from another device.
  Browsers only allow them on `https://` or `http://localhost`. The easiest way is
  [`tailscale serve`](https://tailscale.com/kb/1312/serve); a reverse proxy **reachable only
  from your private network** with a valid certificate also works (see
  [Other private networks](networks.md#other-private-networks)).

## Installation

**With an agent (recommended).** Give the prompt of [Install with an agent](install-with-an-agent.md)
to a coding agent running on the server: a new install, v3 beside an existing v2 (with import of
its projects, machines and settings), or an update. The agent looks at the machine first, runs the
installer script for the standard steps, handles what differs on your machine, never touches v2,
asks before any `sudo`, and ends with a summary of what it checked and what is left for you.

**With the script.** On Linux with `systemd --user`,
[`scripts/install-v3-beside-v2.sh`](../scripts/install-v3-beside-v2.sh) starts hc and v3 as user
services, adds a `tailscale serve` address and writes an update script; `--skip-import` when there
is no v2 to import from. Without `--yes` it only prints its plan. See
[Migrate from v2](migrate-from-v2.md#by-hand).

**By hand.** Build and start from source, as in [First launch](quick-start.md#quick-start):

```sh
git clone -b v3 https://github.com/afloury/wherdr.git
cd wherdr
npm ci
npm run build
HC_SOCKET=/path/to/hc.sock npm start
```

`npm start` runs `.output/server/index.mjs` on `127.0.0.1:7683` (`HOST`, `PORT`). Other settings
are environment variables ([Configuration](configuration.md#configuration)); `DATA_DIR` defaults
to `./data`, in the checkout.

### The hc socket

`HC_SOCKET` is the socket of the hc session wherdr drives. An hc session named `<session>`
(`default` unless you name one with `HC_SESSION`) listens by default on:

- Linux: `$XDG_RUNTIME_DIR/herdr-core/<session>.sock`, usually
  `/run/user/<uid>/herdr-core/default.sock`;
- macOS (no `XDG_RUNTIME_DIR`): `~/.local/state/herdr-core/<session>/<session>.sock`, so
  `~/.local/state/herdr-core/default/default.sock`.

A `socket` set in hc's `config.toml` replaces it. Give wherdr the full path (a service does not
expand `~`).

### v2 and v3 on one computer

wherdr v2 and a v3 started by hand both listen on `127.0.0.1:7683`: the second one to start
fails, or you open the other one without noticing. Start v3 on another port (`PORT=7684 npm
start`, or `Environment=PORT=7684` in its unit). The [install script](migrate-from-v2.md#by-hand)
does it for you (`7684`).

### On macOS

The script needs `systemd --user`, so on macOS install by hand: the steps above, with the macOS
socket path. To keep wherdr running, use a LaunchAgent (below). Machines added to hc over SSH
work the same; a Mac that sleeps stops its agents, which
[Keep awake](machines.md#manage-machines) prevents while you need them.

### Keep it running

Run it with your usual service manager. On Linux, a `systemd --user` unit such as
`~/.config/systemd/user/wherdr.service`:

```ini
[Unit]
Description=wherdr v3 (herdr-core)

[Service]
WorkingDirectory=%h/wherdr
Environment=HC_SOCKET=/path/to/hc.sock
Environment=DATA_DIR=%h/wherdr/data
ExecStart=/usr/bin/env node .output/server/index.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

Then `systemctl --user daemon-reload && systemctl --user enable --now wherdr`. Adjust the
checkout folder, the socket and the `node` path (systemd does not see your shell's `PATH`). To
keep it running after logout, enable lingering once: `loginctl enable-linger`. On macOS, use a
LaunchAgent with the same command and variables.

### Which setup?

| | **Always-on server + Tailscale** (recommended) | **One computer** |
| --- | --- | --- |
| Runs on | A machine that never sleeps: Raspberry Pi, mini-PC, home server, private VPS (Linux) | The computer you work on (macOS or Linux) |
| Reach it from | Your phone and every computer on your tailnet | That computer only (`http://localhost:7683`) |
| Installable app, push notifications, passkeys | Yes (private HTTPS from `tailscale serve`) | Desktop browser only; no phone access |
| Other machines (a Mac, a laptop…) | Added to hc over SSH, shown in wherdr | Also possible, but they are only reachable while this computer is awake |

You can start with the second one and move to the first later
([Phone access and private networks](networks.md)).

### On-device dictation files

Dictation that runs on the phone itself needs a speech model and a WebAssembly runtime: large
files that are not in the repository, the build or the app's offline cache. The server fetches
the missing ones into `DATA_DIR/models` by itself when you press Install. To fetch them ahead,
run, with the same `DATA_DIR` as wherdr:

```sh
DATA_DIR=/path/to/data node scripts/fetch-dictation-files.mjs
```

| Set | Size | Content |
| --- | --- | --- |
| `runtime` (default) | 13 MB | sherpa-onnx WASM runtime, in `models/runtime/` |
| `parakeet` (default) | 670 MB | Parakeet v3: French, English and 23 more European languages, detected. Too large for an iPhone |
| `canary` | 207 MB | Canary 180M, the iPhone's default: French, English, German, Spanish (the device's language, not detected) |
| `sensevoice` | 237 MB | SenseVoice, lighter, no French (Chinese, English, Japanese, Korean, Cantonese) |
| `ort` | 59 MB | onnxruntime-web 1.23.2, in `models/runtime/`, for WebGPU models only |
| `tts-siwis-medium` | 64 MB | Siwis, the French neural read-aloud voice (preparation for an on-device voice) |
| `tts-cori-medium` | 64 MB | Cori, the English (UK) neural read-aloud voice |
| `tts-mls-medium` | 78 MB | MLS, a fallback French voice |

Name sets to choose (`… fetch-dictation-files.mjs runtime ort`), or `all`. Every file has a fixed
URL and a sha256: a file that does not match is never kept. Run it again after an interruption:
it resumes, and keeps what is already in place. wherdr serves the folder at `/models/` (behind
the passkey lock when one is set up), where the phone's browser downloads what it needs. The folder
survives updates; delete it to free the space. Dictation through a cloud service needs none of this.

## Updating

Settings › About shows the version that runs, with the commit it was built from
(`wherdr 3.0.0+1a2b3c4 · herdr-core`). Once a day wherdr checks GitHub for a newer 3.x release and
the home screen shows a banner when there is one: never a 2.x release (v2 keeps its own updates),
nor the next major version. `WHERDR_UPDATE_CHECK=off` turns the check off. The banner's
**What's new** shows the release notes, rendered from GitHub, and **Update with Alfred** asks
Alfred to update, following [Update with an agent](update-with-an-agent.md): it shows you the
plan, backs up `DATA_DIR`, runs `update.sh` (or the commands below), checks the new version and
rolls back on failure. To update by hand, in the checkout:

```sh
git pull
npm ci
npm run build
```

then restart wherdr. Data in `DATA_DIR` (passkeys, push subscriptions, settings) is kept.

## v2 only

wherdr v2 needs Herdr ≥ 0.9.1 running on the server (`herdr status server` checks it), with the
integrations of the agents you use (`herdr integration install claude|codex|omp`). It installs
with `curl -fsSL https://wherdr.dev/install | sh`, the Herdr plugin, npm or Homebrew: see the
[v2 installation guide](https://github.com/afloury/wherdr/blob/main/docs/installation.md). A
wherdr 1.x Docker container moves to the native v2 service with the
[Docker migration guide](migrate-from-1.x-docker.md). None of this applies to v3. To move from v2 to v3, see [Migrate from v2](migrate-from-v2.md).
