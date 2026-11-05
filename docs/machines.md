# Machines

[Documentation](README.md) · [Project](../README.md)

## Several machines (SSH)

Other machines are **core machines**: herdr-core (hc) reaches them over SSH and runs their
terminals there, as `hc machine add` does. wherdr shows what `machine.list` returns; it opens no
SSH connection of its own.

- **On the home screen**, each machine is a tab of the machine bar, online or offline, with its
  count of rows ([Machines as tabs](home.md#machines-as-tabs)). When a machine goes offline, its
  last terminals stay visible, marked offline, until core reaches it again.
- **New** starts a terminal or an agent on any online machine (`terminal.run` with `on`). Home,
  folders, Git detection and installed agents of that machine come from `machine.exec`; folders
  must stay under the machine's home.
- **Conversations, files and quotas** of a core machine are read through `machine.exec` on that
  machine ([herdr-core](core.md#conversations), [Files](files.md), [quotas](quotas.md)).

## Before adding a machine

On the machine to add:

- herdr-core is installed and on the `PATH` of a non-interactive SSH shell
  (`ssh laptop 'command -v hc'`). wherdr never installs it.
- This host logs in with an SSH key, without a password prompt (`ssh laptop true` answers at once
  and the host key is already accepted). wherdr never asks for a password.

## Manage machines

**Settings › Agents › Machines** shows the core's version and uptime, this machine, and each core
machine with its state (connected, connecting…, offline) and last error:

- **Add machine** (`machine.add`): an **SSH target** (`user@host`, a `~/.ssh/config` host, or
  `user@host:port` when the core takes a port, as herdr-core 0.1.17 does; wherdr reads this from
  the core's `rpc.discover`, and on an older core the form says so before sending) and an optional
  **Name** (a-z, 0-9, `-`, `_`, `.`, 32 at most). wherdr never accepts a `via` command. Adding can
  fail with: the name is taken, the machine is already added, it cannot be reached over SSH,
  herdr-core is not installed there, or its herdr-core version is incompatible.
- **Reconnect** an offline machine (`machine.connect`).
- **Rename** (`machine.rename`): the new name follows the same rules. Only this core's name
  changes; links that use the old name stop working.
- **Forget** (`machine.rm`): this core drops the machine, but its terminals keep running there,
  and the machine can be added again later.
