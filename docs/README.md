# Documentation

This is the documentation of **wherdr v3**, which runs on herdr-core (`hc`). Pages and sections marked **v2 only** apply to wherdr 2.x on Herdr.

Read only the page relevant to your task. Start with [herdr-core](core.md) for what v3 supports,
[Installation and updates](installation.md) for setup, [Security](security.md) for remote access,
or [Development and tests](development.md) for repository changes.

## Community

Questions and feedback: [Discord](https://discord.gg/ky36WYmtVE); bugs: [GitHub issues](https://github.com/afloury/wherdr/issues).

## v3

- [herdr-core](core.md) — How v3 uses hc: inventory, terminals, conversations, creating agents, machines. The reference for what v3 supports.
- [Overview and architecture](overview.md) — What wherdr does and how it connects to herdr-core.
- [First launch](quick-start.md) — Build, start and open wherdr v3.
- [Installation and updates](installation.md) — Requirements, running as a service, updating.
- [Install with an agent](install-with-an-agent.md) — Ready-to-paste agent prompts: new install, v3 beside v2 with import, update.
- [Update with an agent](update-with-an-agent.md) — The steps Alfred (or any agent) follows to update v3: plan and your yes, backup, update, health check, rollback; the release's Upgrade notes.
- [Release notes 3.0.0](release-notes-3.0.0.md) — What v3 brings to a v2 user, what changed, what is gone, how to move.
- [Migrate from v2](migrate-from-v2.md) — Install v3 next to a running v2, import machines and settings, set up v2 projects with Alfred, auto-deploy from a build machine, fall back, uninstall.
- [Project management](project-management.md) — Getting started, project settings (workflow, guards, automations), autopilot, the board, the task sheet and reporting a problem on a task.
- [Workspaces](workspaces.md) — A project that runs several linked repositories: member projects, shared settings and overrides, features.
- [Home and agent list](home.md) — Machine tabs, spaces and tabs, states, new agents and search.
- [Alfred's command](alfred.md) — `wherdr alfred`: what Alfred reads and changes, shown before it is done.
- [Conversation and replies](conversation.md) — Read transcripts, answer questions, attach files and quote replies.
- [Terminal](terminal.md) — The real terminal, shared viewers and taking control.
- [Files](files.md) — Browse, read and download the files of an agent's folder.
- [Computer, phone and iPad](devices.md) — Layouts, keyboard shortcuts and touch controls.
- [Machines](machines.md) — Add, reconnect, rename and forget machines reached by herdr-core over SSH.
- [Claude and Codex quotas](quotas.md) — Remaining usage on every machine.
- [Notifications](notifications.md) — Web Push, Do not disturb, default and exceptions.
- [Settings and configuration](configuration.md) — Environment variables and in-app settings.
- [Phone access and private networks](networks.md) — Set up Tailscale or another private network with HTTPS.
- [Install as an app](phone.md) — Add wherdr to your home screen on a phone or install it in a desktop browser.
- [Plugins](plugins.md) — [wherdr plugins](plugins.md#wherdr-plugins): optional page plugins and `data-wherdr` markers.
- [Security](security.md) — Remote-shell access, passkeys and network restrictions. Read this before enabling remote access.
- [Read aloud: the voice of wherdr](read-aloud.md) — The on-device neural voices, their licences and attributions, the espeak-ng note, and their measured (for now estimated) phone figures.
- [Dictation design](dictation.md) — For contributors: the engine interface, capture pipeline, OpenRouter relay, on-device models and how to add one.
- [Design rules](design.md) — The single reference for interface styling, state indicators, controls and responsive checks.
- [Development and tests](development.md) — Run from source and test the core build.
- [Troubleshooting](troubleshooting.md) — herdr-core connection, conversations, machines and network problems.

Also see the [keyboard shortcut specification](product/keyboard-shortcuts.md) and
[Contributing](../CONTRIBUTING.md).

## v2 only

These pages describe wherdr 2.x on Herdr. They do not apply to v3.

- [Migrate from a 1.x Docker install](migrate-from-1.x-docker.md) — Docker container to the native 2.0 service.
- [The wherdr command](command.md) — npm and Homebrew packages and the native service.
- [Releasing](RELEASING.md) — Release process of the 2.x line.

Release notes of the 2.x line: [2.5.0](release-notes-2.5.0.md) · [2.4.0](release-notes-2.4.0.md) ·
[2.3.0](release-notes-2.3.0.md) · [2.2.0](release-notes-2.2.0.md) · [2.1.0](release-notes-2.1.0.md) ·
[2.0.0](release-notes-2.0.0.md).

## Section reference

- [Quick start](quick-start.md#quick-start)
- [Why wherdr](overview.md#why-wherdr)
- [Features](home.md#features)
- [How it works](overview.md#how-it-works)
- [Requirements](installation.md#requirements)
- [Installation](installation.md#installation) ·
  [always-on server + Tailscale](networks.md#recommended-always-on-server--tailscale) ·
  [other private networks](networks.md#other-private-networks) ·
  [from source](development.md#from-source)
- [Updating](installation.md#updating)
- [Install it as an app](phone.md#install-it-as-an-app)
- [Configuration](configuration.md#configuration)
- [Several machines (SSH)](machines.md#several-machines-ssh)
- [Claude and Codex quotas](quotas.md#claude-and-codex-quotas)
- [Notifications](notifications.md#notifications)
- [Security](security.md#security)
- [Troubleshooting](troubleshooting.md#troubleshooting)
- [Contributing](development.md#contributing) · [License](overview.md#license)
- v2 only: [the `wherdr` command](command.md#the-wherdr-command)
