# Settings and configuration

[Documentation](README.md) · [Project](../README.md)

- **Themes**: wherdr Titanium (default), herdr.dev and Herdr's built-in themes. English interface.

## Configuration

All settings are environment variables of the wherdr server (`npm start`, or your service
unit: see [Installation](installation.md#keep-it-running)), read at each start.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HC_SOCKET` | *(none)* | Socket of the hc session to drive. Required: wherdr never guesses it, and the server stops at startup with a log line naming `HC_SOCKET` without it. `wherdr --hc-socket <path>` sets it. |
| `PORT` | `7683` | Listening port. |
| `HOST` | `127.0.0.1` (`npm start`) | Listening address: loopback, or this machine's tailnet address (`tailscale ip`, with Tailscale running). Any other address (`0.0.0.0`, a LAN address) stops wherdr at startup unless `WHERDR_TRUSTED_NETWORKS` covers it. |
| `WHERDR_TRUSTED_NETWORKS` | *(empty)* | Other private networks wherdr accepts besides this computer and the tailnet, as comma-separated CIDR ranges or addresses (e.g. `10.147.17.0/24` for ZeroTier). `any` accepts every network, with a warning at startup and in the app: not recommended. See [Network access](security.md#network-access). |
| `HOST_LABEL` | server hostname | Name of this machine in the app. |
| `APP_URL` | *(empty)* | App address and allowed host; a valid HTTPS URL enables Web Push. HTTP, empty or invalid values disable Web Push with a warning. With Tailscale, leave it empty: wherdr adopts the address `tailscale serve` publishes. |
| `HERDR_WEB_ALLOWED_HOSTS` | *(empty)* | Other private hostnames or IP addresses wherdr answers under, comma-separated, besides `APP_URL`, this machine's addresses and what `tailscale serve` publishes. Restart wherdr after a change. See [Security](security.md#security). |
| `TAILNET_REFRESH_MS` | `30000` | How often wherdr reads again what `tailscale serve` publishes for its port. |
| `PASSKEY_USER` | `wherdr` | User name stored with the passkeys. |
| `DATA_DIR` | `./data` | VAPID keys, push subscriptions, passkeys, recent folders, and `settings.json`: the display settings that follow you across devices (theme, machine bar and groups, home list, file browser preferences). Screen-dependent ones (content width, sidebar width, terminal size and rendering), the last tab or filter and drafts stay in each browser. |
| `AGENT_KINDS` | all known agents | Agents offered in **New** (only installed ones are shown). |
| `UPLOAD_DIR` | `~/.cache/herdr-web/uploads` | Where photos sent to agents are stored (deleted after 7 days). |
| `ATTACH_DIR` | `~/.cache/herdr-web/files` | Where other files attached to messages are stored, on the agent's machine (mode 600, deleted after 7 days). |
| `OPENROUTER_API_KEY` | *(empty)* | OpenRouter key for online dictation (Settings › Conversation › Dictation › Online). Wins over the key saved from Settings in `DATA_DIR/openrouter.json`; see [Dictation](security.md#dictation). |
| `TZ` | `UTC` | Time zone. |

**v2 only.** These variables configure wherdr v2 on Herdr and are ignored in core mode:

| Variable | Meaning (v2) |
| --- | --- |
| `HERDR_BIN` | Herdr binary. |
| `HERDR_WEB_SESSION` | Named Herdr session to drive. |
| `HERDR_WEB_MACHINES` | `off` to ignore the SSH machines registered in Herdr. |
| `HERDR_WEB_SELF_HOSTS` | Other names / IPs of this machine (Herdr machine profiles pointing to it are ignored). |
| `HERDR_WEB_REMOTE_SESSION` | Herdr session to use on every remote machine. |
| `HERDR_WEB_HERDR_NOTIFICATIONS` | `off` to stop relaying `herdr notification show` as push. |

In the app, **Settings** has these sections: Appearance, Conversation, Terminal, Agents
(Machines, Claude quotas), Notifications, Plugins (only once a plugin is installed), Phone, Security, Shortcuts (computer)
and About. **Settings** holds display preferences such as theme, typing effect and what the
home screen shows; these follow you across devices through `settings.json`. Notifications, terminal text size and renderer remain device-specific. The passkey lock is
managed under Settings › Security.

