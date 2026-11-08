# Security

[Documentation](README.md) · [Project](../README.md)

## Security

wherdr drives herdr-core, so **it can run anything as your user**, on this machine and on every
machine hc reaches. The browser never chooses the hc socket and cannot send arbitrary RPC calls:
only the routes listed in `shared/coreRoutes.ts` answer.

- It listens on `127.0.0.1` only. Reach it from other devices **only through a private
  network** (Tailscale or [equivalent](networks.md#other-private-networks)). Never add a public route
  (port forwarding, public reverse proxy, ngrok…); the only exception is a Cloudflare Tunnel
  behind Cloudflare Access, with its risks (it needs `WHERDR_TRUSTED_NETWORKS=any`).
- It answers only this computer and your own tailnet devices: see [Network access](security.md#network-access).
- Requests are accepted only for `localhost`, loopback addresses, the runtime's hostname, the
  hostname in `APP_URL`, the tailnet name `tailscale serve` publishes for wherdr's own port
  (read from Tailscale on the machine, never from a request, and only while it is published),
  and the runtime's network interface addresses. Add other private names or IP addresses to `HERDR_WEB_ALLOWED_HOSTS`
  (comma-separated) before using them. An unlisted name returns HTTP 403 (`host` / "Host not
  allowed"); add it to `HERDR_WEB_ALLOWED_HOSTS`, then restart wherdr. This host check also
  applies to WebSockets.
- **Passkey lock** (Settings → Security, optional): once a passkey is registered, the API,
  images, photos and WebSockets require an unlocked session (signed HttpOnly cookie). One rule
  applies: the duration set in Settings → Security for every device, counted from the last
  passkey unlock, used or not in between: 1 day, 7 days (default), 30 days, 90 days or 1 year.
  There is no idle lock. Past it, the device asks for the passkey again at the next opening of
  the app (launch, reload, or back in the foreground), never in the middle of use; the app warns
  in the last hours. A client that never reopens is cut 12 hours after the deadline. A changed
  duration applies to the sessions already open.

  A network error or a server restart never locks the app. **Lock all devices** (Settings →
  Security, for a lost or stolen device) ends every session, this one included, and keeps the
  passkeys: each device unlocks again with its own. It draws a new signing secret and a new random
  session generation, so even a cookie forged by someone who once read `data/auth.json` stops
  working; open WebSockets close at once, and every push subscription is removed (a device
  subscribes again by itself once unlocked; its own quiet setting is reset). Turning the lock off
  does the same and removes the passkeys; every open app then posts its push subscription again
  at once, and an app that was closed or asleep does so when it opens or reconnects. The first start after upgrading to this version ends the open
  sessions once (the old numeric generation is replaced); the passkeys stay. Lost passkey: delete
  `data/auth.json` on the server; the app is open again to whoever can reach it.
- **Before the unlock**, a locked device only learns that the app is locked: no passkey names or
  dates, no machine name, no server clock. Unlocking lists no key: the device offers its own
  passkey for the site (passkeys are registered as discoverable credentials). Unlock attempts
  are limited to 10 per minute per client, and at most 100 unlock challenges wait at once.
- **Protected files**: the file browser and the file paths shown in conversations never preview,
  download or stream wherdr's data folder (`DATA_DIR`, with `auth.json`, the push keys and
  subscriptions, the OpenRouter key), its settings (`wherdr.env`, which can hold
  `OPENROUTER_API_KEY`, and `wherdr.json`, in `WHERDR_DIR` and in `~/wherdr`), `~/.ssh` or
  `~/.config/herdr`, on any machine, even through a symlink or inside
  a browsed project. Agents themselves can still read them: the lock protects the app, not the
  machine.
- <a id="new-device"></a>**New device**: it can only get in with an existing passkey. Unlock it
  with a passkey synced by your password manager (iCloud Keychain, Google Password Manager,
  1Password…), or with the passkey of another device through the browser's "use a phone or
  tablet" QR code, then Settings → Security → **Add this device** to give it its own passkey.
- By default, with no passkey, wherdr answers **this computer and your own tailnet devices**:
  devices of other people on your tailnet are always filtered out (no setting turns this off).
  Whoever uses this computer or one of your devices can control your agents, other OS users of
  this computer included (see [Shared computers](security.md#shared-computers)). The passkey is
  optional: it adds an automatic lock on each device if you want one, and then lets other
  people's tailnet devices reach that lock.
- Writes require `Content-Type: application/json` (or `image/*` for photos, `application/octet-stream` for attached files, `audio/wav` for dictation) and an `Origin`
  matching the host, WebSockets included. Every method other than GET and HEAD (POST, DELETE…)
  needs that `Origin`. Request bodies are read with a size limit (256 KB for
  JSON, 20 MB for photos, 30 MB for attached files, 8 MB for a dictation take), chunked bodies included: past it the server
  stops reading, answers `too_large` and closes the connection. API reads sent from another site (links, images,
  `no-cors` fetches, reported by the browser's `Sec-Fetch-Site`) are refused too.
- A WebSocket message is limited to 256 KB, decompressed: a larger one closes the socket (1009)
  before it is inflated further.
- A push subscription is accepted only when its endpoint is an HTTPS address of a browser push
  service (Apple `*.push.apple.com`, `fcm.googleapis.com`, Mozilla
  `*.push.services.mozilla.com`, Windows `*.notify.windows.com`), on the default port: the server
  never posts notifications to another host, private addresses included.
- Only the API routes listed in `shared/coreRoutes.ts`, each one exactly, are answered; any other
  path under `/api/` gets 503 (`Unavailable with herdr-core`).
- A strict Content Security Policy limits scripts to the app's own origin and hashed inline
  scripts, and connections to that origin and its WebSockets. It also blocks embedded objects
  and framing. The page cannot compile WebAssembly: only the on-device dictation workers
  (`/workers/dictation-worker.js` and `/workers/dictation-webgpu-worker.js`) get
  `'wasm-unsafe-eval'`, each in its own response policy. `eval()` of
  JavaScript is never allowed.
- Images in agent replies load from the app's own origin (`data:` and `blob:` included) and,
  over HTTPS only, from any machine and port of the tailnet wherdr is reached on
  (`https://*.<tailnet>.ts.net:*`). That tailnet is read from Tailscale on the machine, from
  `APP_URL`, from `HERDR_WEB_ALLOWED_HOSTS` and from what `tailscale serve` publishes, never from
  a request; a name outside `*.ts.net` adds nothing. Any other image (public sites, another
  tailnet, plain HTTP, Tailscale IP addresses) is refused by the browser and shown as a note with
  a link to open it in a new tab.
- wherdr never changes your agents' global settings.
- <a id="dictation"></a>**Dictation, online** (Settings › Conversation › Dictation, off by
  default): each take leaves your network. The browser sends it as a WAV to the wherdr server,
  which sends it to OpenRouter (`/api/v1/audio/transcriptions`), which passes it to the model's
  provider. OpenRouter keeps no prompts unless logging is turned on in your OpenRouter account.
  With **ZDR** (on by default), only providers with zero data retention are used; if none
  serves the model, the take fails (Test shows it). Pane terms (agent, machine and folder names,
  words of the draft) are sent only if **Send pane terms** is on. The OpenRouter key stays on
  the server: `OPENROUTER_API_KEY`, or `DATA_DIR/openrouter.json` (mode 600) saved from
  Settings. It is never sent back to a browser (Settings shows its last 4 characters), never
  logged, and scrubbed from OpenRouter's error messages. The server relays at most 2 takes at
  once and 10 per client per minute (`rate_limited` beyond). Dictation on the device sends nothing.

See [SECURITY.md](../SECURITY.md) to report a vulnerability.

### Network access

wherdr answers **this computer and your own tailnet devices only**. A device on any other network (a coffee shop
Wi-Fi, an office LAN, the Internet) gets HTTP 403 (`network`), with a page that says why, even
when it knows the address and the port. The passkey lock is never required for this computer
and your own devices: it is an extra lock on top, and it needs HTTPS (or `localhost`). Other
people's tailnet devices get in only once a passkey is set up (see below).

**Good practices**

- Prefer **Tailscale** (`tailscale serve`): a private HTTPS address, only for your devices.
- A network you add **without HTTPS** gets no passkey, no installed app and no notifications, and
  any device on that network can control your agents.
- **Passkey** (optional, over HTTPS): an automatic lock on each device, if you want one. Your
  own devices get in without it.

How a request is judged, before anything else (WebSockets included):

- **Its TCP peer** (the address the connection comes from, not a header). A client cannot pick
  it: a connection only opens once the client has received wherdr's reply at that address.
  - *Loopback* (`127.0.0.0/8`, `::1`): this computer. The kernel drops packets that arrive from a
    network with a loopback source.
  - *Tailnet*: an address of `100.64.0.0/10` or `fd7a:115c:a1e0::/48` counts only when
    Tailscale, running on this machine, lists it as one of its peers (or its own address). wherdr
    reads that from Tailscale every 10 seconds (the CLI or Tailscale's socket); an
    interface address in that range proves nothing, since a LAN may use it too. When Tailscale is
    stopped, missing or unreadable for 30 seconds, no direct connection counts as tailnet.
  - <a id="own-devices"></a>*Your own devices only*: a peer counts when Tailscale lists it under
    the same user as this machine (`UserID`), is not tagged, and is not a node of someone you
    shared this machine with (`ShareeNode`). Every other peer is refused with HTTP 403 (`network`, `why: foreign`) while
    no passkey is set up: another user's device in a team tailnet, a machine someone
    [shared](https://tailscale.com/kb/1084/sharing) with you (it belongs to another user), a
    device of someone you shared this machine with, a tagged node (tagged devices
    belong to no user, your own tagged servers included). When the machine running wherdr is
    itself tagged, its owner is unknown: no peer counts as yours, so only this computer gets in
    until a passkey is set up. The same rule applies to the client `tailscale serve` names in
    `X-Forwarded-For`: without a passkey, it must be one of your devices in the latest reading
    (a device that joined in the last seconds, or any device while Tailscale cannot be read, is
    refused). The other peers are remembered from the last valid reading, so a failed reading
    does not let them in. Once a passkey is set up, they are let through to the lock screen and
    need that passkey like any device.
- **Proxy headers**, only when the peer is this computer (a proxy on the machine, such as
  `tailscale serve`): every address in `X-Forwarded-For`, `Forwarded`, `X-Real-IP`,
  `CF-Connecting-IP` must be loopback, the tailnet or a trusted range too. They can only refuse
  more: a client that writes its own headers directly only gets itself refused. A proxy that
  adds the client's address (Caddy, nginx with `proxy_add_x_forwarded_for`, Cloudflare Tunnel)
  therefore has its outside clients refused.
- **Tailscale Funnel**: wherdr reads Tailscale's serve configuration every 10 seconds, at most
  2 seconds before an HTTP request, and again for every WebSocket it opens. Connections from this
  computer stay local only while the latest reading **proves** that Funnel does not expose
  wherdr's port, in any form (HTTPS, TCP, or TCP with TLS termination, which carry no client
  address). A Funnel route counts unless its target clearly leads to another port: the host is
  never compared (`0.0.0.0:7683`, `127.1:7683` or a LAN address reach wherdr too), and a target
  wherdr cannot parse counts. Funnel routes to other ports do not count (Funnel for another
  service is fine). While Funnel exposes wherdr, **every connection from this computer is
  refused**, with a page that says how to turn it off: Funnel puts wherdr on the Internet. Once
  seen, the exposure stays until a valid reading shows it gone: a failed, garbled or late reading
  does not reopen wherdr. Open WebSockets are judged again after every reading and closed when no
  longer allowed; between two readings (10 seconds at most), a connection opened before Funnel was
  turned on can last that long. When Funnel was never seen, a failed or garbled reading proves
  nothing: connections are served and the server log says that Funnel cannot be checked. A Funnel request with Tailscale's
  `Tailscale-Funnel-Request` header is always refused.
- **The listening address**: wherdr refuses to start on anything else than
  loopback or this machine's tailnet address as Tailscale reports it, with Tailscale running
  (`HOST=0.0.0.0`, a LAN address), and says how to fix it.

> [!IMPORTANT]
> <a id="shared-computers"></a>**Every user of this computer counts as this computer.** Loopback
> connections are not tied to an OS user: on a machine where other people have an account (a
> shared server, a lab machine), any of them can open `http://127.0.0.1:7683/` and control
> your agents. wherdr keeps loopback open so you can always reach it on your own machine. On a
> machine others log in to, the optional passkey locks loopback too.

> [!IMPORTANT]
> **A relay on this computer counts as this computer.** A reverse proxy or TCP forward you run
> on the machine (nginx without forwarded headers, `socat`, an SSH tunnel, a tunnel client) opens
> its connections from loopback, like your own browser, and may pass on headers its clients
> wrote. wherdr cannot tell them apart. If you run one, make sure it only listens on a private
> address, serve it over HTTPS and **create a passkey**.

`tailscale serve` forwards to `127.0.0.1` with the
tailnet client's address in `X-Forwarded-For`: accepted, nothing to set up.

**Another private network** (ZeroTier, WireGuard, NetBird outside `100.64.0.0/10`): name its
range, `WHERDR_TRUSTED_NETWORKS=10.147.17.0/24` (comma-separated CIDR ranges or addresses), then
restart wherdr. Such devices get the whole app, Settings › Phone included, like the tailnet. `WHERDR_TRUSTED_NETWORKS=any` accepts every network: wherdr then
warns at startup and shows a warning that cannot be hidden in the app. Use it only when
something else protects the network (Cloudflare Access), and set up a passkey there too.
