# Installation and updates

[Documentation](README.md) · [Project](../README.md)

This page covers **wherdr v3** on herdr-core. The one-command installer, the Herdr plugin, the
npm and Homebrew packages, the one-tap update and Docker belong to wherdr v2: see the
[v2 installation guide](https://github.com/afloury/wherdr/blob/main/docs/installation.md).

## Requirements

- **An hc session** (herdr-core) running on the server, with protocol generation 1 and the
  methods listed in [herdr-core › Setup](core.md#setup). Know its socket path: wherdr needs it in
  `HC_SOCKET`.
- **Linux or macOS** with **Node.js 22** or newer and Git. wherdr runs as the user who runs hc.
- The agents you use (Claude Code, Codex) installed on each machine, in a folder of the usual
  user `PATH` (`~/.local/bin`, `~/.bun/bin`, `~/.cargo/bin`, `~/.npm-global/bin`, Homebrew…):
  agents are started through the machine's shell with those folders added.
- **HTTPS** to use passkeys, push notifications and the installable app from another device.
  Browsers only allow them on `https://` or `http://localhost`. The easiest way is
  [`tailscale serve`](https://tailscale.com/kb/1312/serve); a reverse proxy **reachable only
  from your private network** with a valid certificate also works (see
  [Other private networks](networks.md#other-private-networks)).

## Installation

Build and start from source, as in [First launch](quick-start.md#quick-start):

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
files that are not in the repository, the build or the app's offline cache. Download them once
into `DATA_DIR/models`, in the checkout, with the same `DATA_DIR` as wherdr:

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

Name sets to choose (`… fetch-dictation-files.mjs runtime ort`), or `all`. Every file has a fixed
URL and a sha256: a file that does not match is never kept. Run it again after an interruption:
it resumes, and keeps what is already in place. wherdr serves the folder at `/models/` (behind
the passkey lock when one is set up), where the phone's browser downloads what it needs. The folder
survives updates; delete it to free the space. Dictation through a cloud service needs none of this.

## Updating

v3 has no update check, banner or one-tap update (Settings › About shows `v3 · herdr-core`). To
update, in the checkout:

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
[Docker migration guide](migrate-from-1.x-docker.md). None of this applies to v3.
