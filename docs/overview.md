# Overview and architecture

[Documentation](README.md) · [Project](../README.md)

<p align="center">
  <img src="../server/assets/branding/icons/icon-512.png" alt="wherdr logo" width="120">
</p>

<h1 align="center">wherdr</h1>

<p align="center"><b>Start coding agents on <a href="https://github.com/herdrdev/herdr-core">herdr-core</a>.
Follow their work and answer from your phone.</b></p>

<p align="center">Add it to your home screen like an app — no App Store needed.</p>

<p align="center"><a href="https://github.com/afloury/wherdr/actions/workflows/ci.yml"><img src="https://github.com/afloury/wherdr/actions/workflows/ci.yml/badge.svg?branch=v3" alt="CI"></a></p>

This page describes **wherdr v3**, which runs on herdr-core (`hc`). The launch film, the website
and the [browser demo](https://wherdr.dev/demo/) show wherdr v2 on Herdr.

## Why wherdr

- **Your hc terminals, anywhere.** Every terminal of your hc session and of the machines it
  reaches, grouped into spaces and tabs as herdr-app shows them, with a live state: Your turn,
  Working or Ready (no status reported counts as Ready).
- **Conversations, not just screens.** Claude Code, Codex and Devin open on their transcript: one-tap
  answers to questions, queued messages, quoted replies, photos and files.
- **The real terminal, shared.** Several viewers (phone, computer, herdr-app) watch the same
  terminal; the one you type in takes control of its size.
- **Private by default, passkey lock optional.** wherdr answers only its own computer and your
  tailnet. Add a passkey if you like: Face ID, Touch ID, Windows Hello or Android unlock the app.
- **Projects run by agents.** Tasks on a board go through each project's workflow (work, review,
  PR, merge); a coordinator agent per project, with an autopilot for when you are away, and
  **Alfred**, wherdr's assistant, who sets up projects with you. Off until you turn it on.
- **Search, quotas, files, push.** One shortcut searches every agent and conversation; Claude and
  Codex quotas per machine; the files of an agent's folder; a push when an agent needs you.

Details in [Features](home.md#features), [Project management](project-management.md),
[herdr-core](core.md) and [Security](security.md#security).

## How it works

```
phone / laptop ──private network──> HTTPS (tailscale serve, private proxy)
                                        │
                                        ▼
                             wherdr (Nitro server, 127.0.0.1:7683)
                               ├─ hc socket (HC_SOCKET)    JSON-RPC: inventory, events,
                               │                           run, send, keys, attach, put…
                               │    └─ core machines       reached by hc over SSH (machine.exec)
                               └─ transcripts              ~/.claude, ~/.codex (read only)
```

wherdr runs on the same machine as the hc session (the "server" in these guides). It talks to hc
through the socket named by `HC_SOCKET`: one short connection per request, plus a framed
connection per open terminal and an event subscription. It reads the agents' transcript files
(on core machines through `machine.exec`) and serves a client-only Nuxt app. Data it keeps
(VAPID keys, push subscriptions, passkeys, settings, recent folders) lives in `data/`. So do the
long texts pasted into the message field, which the server keeps to show them as cards on every
device: `data/pastes.json`, in clear, readable by the server's user only (mode 600), at most the
last 100 texts and 2 MB, each one deleted 30 days after it was last sent.

Built with Nuxt 4, Nuxt UI 4, Tailwind 4 and TypeScript; the herdr-core gateway (API,
WebSockets, Web Push, lock) runs in Nitro.

## License

[MIT](../LICENSE). The embedded font subsets keep their own licenses (`app/assets/fonts/`).
