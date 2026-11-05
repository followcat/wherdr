# wherdr v3

wherdr is an unofficial, self-hosted web client for coding agents. **v3 runs on
[herdr-core](https://github.com/herdrdev/herdr-core)** (`hc`): start Claude Code, Codex or a plain
terminal on your machines, follow their work and reply from your phone or browser. Nothing is
copied and nothing runs in the cloud: wherdr talks to the hc session on your computer.

> [!NOTE]
> This is the `v3` branch. For wherdr v2, which runs on [Herdr](https://herdr.dev), see the
> [v2 README](https://github.com/afloury/wherdr/blob/main/README.md) on `main`, and
> [Migrate from a 1.x Docker install](docs/migrate-from-1.x-docker.md) for old v1 containers.

<p align="center">
  <img src="assets/wherdr-readme.webp" width="720" alt="Animated demonstration of wherdr v2 on Herdr: launch an agent on desktop, continue on a phone, approve its request and view v2-only screens. Real app, fictional demo data. v3 keeps the same home, conversation and phone screens.">
</p>
<p align="center"><sub>The demo shows wherdr v2 on Herdr.</sub></p>

## What v3 does

- **Agents on herdr-core**: every hc terminal, on this machine and on the machines hc reaches,
  grouped into spaces and tabs the way herdr-app shows them, with their state (Your turn,
  Working, Ready; agents without a status count as Ready).
- **Conversation** for Claude Code, Codex and Devin: the real transcript, one-tap answers, queued
  messages, quoted replies, attachments.
- **Terminal**: the real terminal, shared with other viewers (phone, computer, herdr-app).
- **Search** across agents and conversations.
- **Claude and Codex quotas** for every machine.
- **Machines as tabs** in the home screen; add, reconnect, rename or forget machines in Settings.
- **Files**: browse, read and download the files of an agent's folder.
- **Notifications**: Web Push when an agent needs you or finishes.
- **Settings**: theme, home list, conversation, terminal, agents, notifications, phone and an
  optional passkey lock.

## Quick start

On the Linux or macOS computer running an **hc session**, with **Node.js 22**:

```sh
git clone -b v3 https://github.com/afloury/wherdr.git
cd wherdr
npm ci
npm run build
HC_SOCKET=/path/to/hc.sock npm start
```

`HC_SOCKET` is the socket of your hc session (from your hc configuration); wherdr never starts
or installs hc. Open **http://localhost:7683**. See [First launch](docs/quick-start.md).

**wherdr is a remote shell as your user.** Keep it on localhost or a private network such as
Tailscale; never expose it to the public Internet. Read [Security](docs/security.md) before
remote access.

## Documentation

- **[herdr-core](docs/core.md)** — How v3 uses hc: inventory, terminals, conversations, machines. The reference for what v3 supports.
- **[Overview and architecture](docs/overview.md)** — What wherdr does and how it connects to herdr-core.
- **[First launch](docs/quick-start.md)** — Build, start and open wherdr v3.
- **[Installation and updates](docs/installation.md)** — Requirements, running as a service, updating.
- **[Home and agent list](docs/home.md)** — Machine tabs, spaces, states, new agents and search.
- **[Conversation and replies](docs/conversation.md)** — Read transcripts, answer questions, attach files and quote replies.
- **[Terminal](docs/terminal.md)** — The real terminal, shared viewers and taking control.
- **[Files](docs/files.md)** — Browse and download the files of an agent's folder.
- **[Computer, phone and iPad](docs/devices.md)** — Layouts, keyboard shortcuts and touch controls.
- **[Machines](docs/machines.md)** — Machines reached by herdr-core over SSH.
- **[Claude and Codex quotas](docs/quotas.md)** — Remaining usage on every machine.
- **[Notifications](docs/notifications.md)** — Web Push, Do not disturb, default and exceptions.
- **[Settings and configuration](docs/configuration.md)** — Environment variables and in-app settings.
- **[Phone access and private networks](docs/networks.md)** — Tailscale or another private network with HTTPS.
- **[Install as an app](docs/phone.md)** — Add wherdr to your home screen or desktop.
- **[Security](docs/security.md)** — Remote-shell access, passkeys and network restrictions.
- **[Development and tests](docs/development.md)** — Run from source, test the core build.
- **[Troubleshooting](docs/troubleshooting.md)** — herdr-core connection, conversations, machines, network.

[All documentation](docs/README.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)

Unofficial project; not affiliated with or endorsed by Herdr, Anthropic or OpenAI.
