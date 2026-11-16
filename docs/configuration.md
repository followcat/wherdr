# Settings and configuration

[Documentation](README.md) · [Project](../README.md)

- <a id="appearance"></a>**Appearance** (Settings › Appearance › Theme): the theme, from wherdr's own
  (Titanium, the default, Neon, Graphite), the coding agents' (Claude Code, Codex, omp) and three
  classics (Vesper, Gruvbox, Kanagawa), and its mode: **Dark** (default), **Light**, or **System**,
  which follows the device's light or dark setting live. Every theme has a dark and a light palette,
  both checked for WCAG AA text contrast; the terminal follows them too. Theme and mode follow you
  across devices; a removed theme falls back to Titanium, and a former light theme (Catppuccin
  Latte, omp Light) opens as its theme in Light mode. English interface.
- <a id="custom-themes"></a>**Custom themes** (Settings › Appearance › Theme › **Create theme**): start
  from any theme and change its colors (background, sidebar, surface, borders, text, muted text,
  accent, success, warning, danger, and the 16 terminal colors) for Dark and Light, with a live
  preview and the WCAG AA contrast check. Custom themes form a **Custom** group (up to 10), follow
  you across devices, and are edited, duplicated, exported or deleted from their pencil button.
  **Export** downloads a JSON file or copies it; **Import theme** takes a pasted or picked file
  (8 KB at most), refused with the reason if invalid. There is no sharing service: share the file.
  The format, every color `#rrggbb`:
  ```json
  { "wherdr": "theme", "version": 1, "name": "My theme", "author": "optional",
    "dark": { "bg": "#12151b", "bg2": "…", "surface": "…", "line": "…", "text": "…", "muted": "…",
      "dim": "…", "accent": "…", "green": "…", "coral": "…", "ochre": "…", "rose": "…",
      "blue": "…", "teal": "…", "ansi": ["16 terminal colors"] },
    "light": { "same keys as dark, without ansi": "…" } }
  ```
  Optional keys: `lav`, `onAccent`, `surface2`, `inputLine`, `selection`, `ring`, `working`,
  `blocked`, `done`. The light terminal palette is derived from the light colors.

## Configuration

All settings are environment variables of the wherdr server (`npm start`, or your service
unit: see [Installation](installation.md#keep-it-running)), read at each start.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HC_SOCKET` | *(none)* | Socket of the hc session to drive. Required: wherdr never guesses it, and the server stops at startup with a log line naming `HC_SOCKET` without it. `wherdr --hc-socket <path>` sets it. |
| `PORT` | `7683` | Listening port (`wherdr` and `npm start` set it; `.output/server/index.mjs` started directly listens on `3000` without it). |
| `HOST` | `127.0.0.1` (`npm start`) | Listening address: loopback, or this machine's tailnet address (`tailscale ip`, with Tailscale running). Any other address (`0.0.0.0`, a LAN address) stops wherdr at startup unless `WHERDR_TRUSTED_NETWORKS` covers it. |
| `WHERDR_TRUSTED_NETWORKS` | *(empty)* | Other private networks wherdr accepts besides this computer and the tailnet, as comma-separated CIDR ranges or addresses (e.g. `10.147.17.0/24` for ZeroTier). `any` accepts every network, with a warning at startup and in the app: not recommended. See [Network access](security.md#network-access). |
| `HOST_LABEL` | server hostname | Name of this machine in the app. |
| `APP_URL` | *(empty)* | App address and allowed host; a valid HTTPS URL enables Web Push. HTTP, empty or invalid values disable Web Push with a warning. With Tailscale, leave it empty: wherdr adopts the address `tailscale serve` publishes. |
| `HERDR_WEB_ALLOWED_HOSTS` | *(empty)* | Other private hostnames or IP addresses wherdr answers under, comma-separated, besides `APP_URL`, this machine's addresses and what `tailscale serve` publishes. Restart wherdr after a change. See [Security](security.md#security). |
| `TAILNET_REFRESH_MS` | `30000` | How often wherdr reads again what `tailscale serve` publishes for its port. |
| `PASSKEY_USER` | `wherdr` | User name stored with the passkeys. |
| `DATA_DIR` | `./data` | VAPID keys, push subscriptions, passkeys, recent folders, and `settings.json`: the display settings that follow you across devices (theme, machine tabs and groups, home list, file browser preferences). Screen-dependent ones (content width, sidebar width, terminal size and rendering), the last tab or filter and drafts stay in each browser. |
| `AGENT_KINDS` | all known agents | Agents offered in **New** (only installed ones are shown). |
| `UPLOAD_DIR` | `~/.cache/herdr-web/uploads` | Where photos sent to agents are stored (deleted after 7 days). |
| `ATTACH_DIR` | `~/.cache/herdr-web/files` | Where other files attached to messages are stored, on the agent's machine (mode 600, deleted after 7 days). |
| `OPENROUTER_API_KEY` | *(empty)* | OpenRouter key for online dictation (Settings › Conversation › Dictation › Online). Wins over the key saved from Settings in `DATA_DIR/openrouter.json`; see [Dictation](security.md#dictation). |
| `TZ` | `UTC` | Time zone. |
| `WHERDR_ROOT` | *(set by `wherdr`)* | Folder of the wherdr install (the one holding `.output`). The `wherdr` command sets it; set it yourself only when you start `.output/server/index.mjs` another way. Alfred reads the docs of the running build: `.output/docs` when the build ships them (auto-deploy packages do), else `WHERDR_ROOT/docs`, else the `docs/` next to `.output`, else the working folder's `docs/`. |

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

<a id="settings-beside-the-conversation"></a>On a computer window at least 1280 px wide, **Settings** opened from a conversation (the
gear, ⌘ , or a `#/settings?section=…` link) open as a panel on the right of the
conversation, on the linked section; the conversation stays readable and you can keep
typing. Escape or the close button shuts the panel, **Open full page** shows today's full
page. Narrower windows and phones keep the full page.

Drag the panel's left edge to make it wider or narrower: it stays at least 400 px wide, and the
conversation keeps at least 480 px. With the edge focused, the left and right arrows resize it
(Shift for bigger steps); a double-click, Home or Enter goes back to the default width. The width
is kept on this device and comes back the next time the panel opens; places an agent opens beside
its conversation use the same panel and width.

The section menu follows the panel's own width: at least 560 px wide, it shows each section's
icon and name; narrower, icons only, each naming its section on hover. The button under the icons
shows the names anyway (a second click hides them), a choice kept on this device. The current
section stays highlighted either way.

A Settings link can also point at one setting with `&target=<id>` (for example
`#/settings?section=conversation&tab=display&target=conversation.typewriter`): Settings
opens the section and tab, scrolls to that setting and outlines it. The outline pulses twice
and fades within 4 s, or goes at once on a click or a key press; with reduced motion it stays
still and fades. A setting that is not shown (a feature off) gets a highlighted line saying so
instead. The ids are internal for now (`shared/uiTargets.ts`) and may change.

