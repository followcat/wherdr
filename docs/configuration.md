# Settings and configuration

[Documentation](README.md) · [Project](../README.md)

- **Themes**: wherdr Titanium (default), herdr.dev and Herdr's built-in themes, or follow your Herdr theme.
  English interface.

## Configuration

All settings are environment variables: `KEY=VALUE` lines in `~/wherdr/wherdr.env` for the
native service (read at each start: `wherdr restart`, or **R** in the panel).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `7683` | Listening port. |
| `HOST` | `127.0.0.1` (`npm start`) | Listening address: loopback, or this machine's tailnet address (`tailscale ip`, with Tailscale running). Any other address (`0.0.0.0`, a LAN address) stops wherdr at startup unless `WHERDR_TRUSTED_NETWORKS` covers it. |
| `WHERDR_TRUSTED_NETWORKS` | *(empty)* | Other private networks wherdr accepts besides this computer and the tailnet, as comma-separated CIDR ranges or addresses (e.g. `10.147.17.0/24` for ZeroTier). `any` accepts every network, with a warning at startup and in the app: not recommended. See [Network access](security.md#network-access). |
| `HOST_LABEL` | server hostname | Name of this machine in the app (can be renamed in the app). |
| `APP_URL` | *(empty)* | App address and allowed host; a valid HTTPS URL enables Web Push. HTTP, empty or invalid values disable Web Push with a warning. With Tailscale, leave it empty: wherdr adopts the address `tailscale serve` publishes. |
| `TAILNET_REFRESH_MS` | `30000` | How often wherdr reads again what `tailscale serve` publishes for its port. |
| `HERDR_WEB_ALLOWED_HOSTS` | *(empty)* | Additional hostnames or IP addresses allowed to open the app, comma-separated. |
| `PASSKEY_USER` | `wherdr` | User name stored with the passkeys. |
| `DATA_DIR` | `./data` | VAPID keys, push subscriptions, passkeys, recent folders, and `settings.json`: the display settings that follow you across devices (theme, machine bar and groups, home list, Board and file browser preferences). Screen-dependent ones (content width, sidebar width, terminal size and rendering), the last tab or filter and drafts stay in each browser. |
| `HERDR_BIN` | `~/.local/bin/herdr`, else `herdr` in `PATH` | Herdr binary. |
| `HERDR_WEB_SESSION` | *(default session)* | Named Herdr session to drive. Not `HERDR_SESSION`, which Herdr reads itself. |
| `HERDR_PROJECTS_DATA_DIR` | `~/.herdr-projects/data` | herdr-projects' data folder, where wherdr reads the `PATH` it recorded ([Agent PATH](installation.md#agent-path)). |
| `AGENT_KINDS` | all known agents | Agents offered in **New** (only installed ones are shown). |
| `HERDR_WEB_MACHINES` | `on` | `off` to ignore the SSH machines registered in Herdr. |
| `HERDR_WEB_SELF_HOSTS` | | Other names / IPs of this machine, comma-separated (profiles pointing to it are ignored). |
| `HERDR_WEB_REMOTE_SESSION` | | Herdr session to use on every remote machine instead of the profile's. |
| `HERDR_WEB_HERDR_NOTIFICATIONS` | `on` | `off` to stop relaying `herdr notification show` as push. |
| `UPLOAD_DIR` | `~/.cache/herdr-web/uploads` | Where photos sent to agents are stored (deleted after 7 days). |
| `ATTACH_DIR` | `~/.cache/herdr-web/files` | Where other files attached to messages are stored, on the agent's machine (mode 600, deleted after 7 days). |
| `TZ` | `UTC` | Time zone. |

In the app, **Settings** holds display preferences such as theme, typing effect and what the
home screen shows; these follow you across devices through `settings.json`. Notifications, terminal text size and renderer remain device-specific. The passkey lock is
managed under Settings › Security.

## Paste diagnostics

Enable **Settings → Advanced → Paste journal** on the device used for dictation.
Paste into an agent's message field, then return to Advanced to inspect the last
50 events: event kind, clipboard types, text length, default prevention, focus
and whether the field or its attachments changed. Text content is never recorded.
The journal stays in memory until reload; disabling the switch clears it.
The switch is off by default and stays local to this browser.
