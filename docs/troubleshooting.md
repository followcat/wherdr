# Troubleshooting

[Documentation](README.md) · [Project](../README.md)

## Troubleshooting

- **"herdr-core is not responding"** on the home screen: wherdr cannot reach the hc session of
  `HC_SOCKET`. Start it (`hc server start` for that session) and check that `HC_SOCKET` is the
  socket of that session. `curl -fsS http://127.0.0.1:7683/api/core` reports the exact problem:
  - `Set HC_SOCKET on the wherdr server…`: the variable is missing from the server's environment;
  - `Cannot connect to herdr-core. Check HC_SOCKET and start hc.`: nothing answers on that socket;
  - `Incompatible herdr-core. Protocol generation 1 is required.`, or `herdr-core is missing
    required capabilities` with the missing methods: update hc ([Setup](core.md#setup)).
- **"Unavailable with herdr-core"** (HTTP 503): that route is v2 only ([herdr-core › Setup](core.md#setup)).
- **No conversation, only the terminal**: the agent is not Claude Code or Codex, or its
  transcript was not found. A core started from inside a Claude Code session inherits
  `CLAUDE_CODE_CHILD_SESSION`, which turns transcript saving off: start hc from a plain shell,
  then start a new agent ([Conversations](core.md#conversations)).
- **"herdr-core did not confirm: check the list before creating it again"** after New: core did
  not answer in time and the new terminal was not found in the inventory. Nothing is relaunched
  blindly: check the home list, then try again.
- **"File too large for herdr-core (8 MB max)"**: attachments go through `terminal.put`, limited
  to 8 MB per file.
- **The first message was not sent**: the program opened on a dialog or was busy. Answer it in
  the terminal, then send the message again.
- **A core machine is offline**: Settings › Machines shows its last error; **Reconnect**
  tries again. Check that this host can log in with `ssh -o BatchMode=yes <target> true` and that
  herdr-core is installed there ([Machines](machines.md)).
- **wherdr stops when you log out** (Linux): lingering is off. Run `loginctl enable-linger` once
  (or `sudo loginctl enable-linger $USER`).
- **Passkeys or notifications unavailable**: the page must be served over HTTPS (or
  `localhost`). On iPhone, notifications need the app installed on the home screen.
- **HTTP 403 "wherdr only answers this computer and your tailnet"**: the device is on another
  network (Wi-Fi, LAN). Open wherdr through Tailscale, or name that private network in
  `WHERDR_TRUSTED_NETWORKS` ([Network access](security.md#network-access)).
- **HTTP 403 "This device is not one of the owner's"**: Tailscale lists the device under another
  user (a team tailnet), as shared in from another tailnet, or as a tagged node. Without a passkey,
  wherdr only answers your own devices: log that device in to Tailscale with your own account, or
  set up a passkey ([Your own devices only](security.md#own-devices)).
- **HTTP 403 "Tailscale Funnel opens wherdr to the Internet"**: turn Funnel off for wherdr’s port (`tailscale funnel status`).
- **wherdr stops at startup with "Refusing to listen on …"**: `HOST` is not loopback nor this
  machine's tailnet address. Set `HOST=127.0.0.1` and use `tailscale serve`, or see
  [Network access](security.md#network-access).
- **HTTP 403 "This address isn't enabled yet"**: for a tailnet address, run the command the
  page gives on the machine: it tells whether `tailscale serve` publishes wherdr's port there.
  For another private name, add the hostname or IP address to `HERDR_WEB_ALLOWED_HOSTS`, or use
  the hostname in `APP_URL`, then restart wherdr.
- **Quotas missing**: see [Claude and Codex quotas](quotas.md#claude-and-codex-quotas).
- **iPhone layout cut at the bottom** after changing the status bar style: reinstall the home
  screen icon (iOS reads this setting at install time).

v2 issues (Herdr, the `wherdr` command, Herdr SSH machines) are covered by the
[v2 troubleshooting page](https://github.com/afloury/wherdr/blob/main/docs/troubleshooting.md).
