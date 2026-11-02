# Security

[Documentation](README.md) · [Project](../README.md)

## Security

wherdr drives Herdr, so **it can run anything as your user**.

- It listens on `127.0.0.1` only. Reach it from other devices **only through a private
  network** (Tailscale or [equivalent](networks.md#other-private-networks)). Never add a public route
  (port forwarding, public reverse proxy, ngrok…); the only exception is a Cloudflare Tunnel
  behind Cloudflare Access, with its risks (it needs `WHERDR_TRUSTED_NETWORKS=any`).
- It answers only this computer and the tailnet: see [Network access](security.md#network-access).
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
  passkeys: each device unlocks again with its own. Turning the lock off removes the passkeys and
  invalidates every session. Lost passkey: delete `data/auth.json` on the server; the app is open
  again to whoever can reach it.
- <a id="new-device"></a>**New device**: it can only get in with an existing passkey. Unlock it
  with a passkey synced by your password manager (iCloud Keychain, Google Password Manager,
  1Password…), or with the passkey of another device through the browser's "use a phone or
  tablet" QR code, then Settings → Security → **Add this device** to give it its own passkey.
- Without a passkey, **anyone who can reach the address can control your agents**: every device
  on your tailnet, and every user of your tailnet if you share it.
- Writes require `Content-Type: application/json` (or `image/*` for photos, `application/octet-stream` for attached files) and an `Origin`
  matching the host, WebSockets included. API reads sent from another site (links, images,
  `no-cors` fetches, reported by the browser's `Sec-Fetch-Site`) are refused too.
- A strict Content Security Policy limits scripts to the app's own origin and hashed inline
  scripts, and connections to that origin and its WebSockets. It also blocks embedded objects
  and framing.
- Images in agent replies load from the app's own origin (`data:` and `blob:` included) and,
  over HTTPS only, from any machine and port of the tailnet wherdr is reached on
  (`https://*.<tailnet>.ts.net:*`). That tailnet is read from Tailscale on the machine, from
  `APP_URL`, from `HERDR_WEB_ALLOWED_HOSTS` and from what `tailscale serve` publishes, never from
  a request; a name outside `*.ts.net` adds nothing. Any other image (public sites, another
  tailnet, plain HTTP, Tailscale IP addresses) is refused by the browser and shown as a note with
  a link to open it in a new tab.
- wherdr never changes your agents' global settings: model and effort changes are for the
  current session only.

See [SECURITY.md](../SECURITY.md) to report a vulnerability.

### Network access

wherdr answers **this computer and your tailnet only**. A device on any other network (a coffee shop
Wi-Fi, an office LAN, the Internet) gets HTTP 403 (`network`), with a page that says why, even
when it knows the address and the port. The passkey lock is never required, on any network: it
is an extra lock on top, and it needs HTTPS (or `localhost`).

**Good practices**

- Prefer **Tailscale** (`tailscale serve`): a private HTTPS address, only for your devices.
- A network you add **without HTTPS** gets no passkey, no installed app and no notifications, and
  any device on that network can control your agents.
- **Create a passkey** as soon as wherdr is reached over HTTPS.

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
> **A relay on this computer counts as this computer.** A reverse proxy or TCP forward you run
> on the machine (nginx without forwarded headers, `socat`, an SSH tunnel, a tunnel client) opens
> its connections from loopback, like your own browser, and may pass on headers its clients
> wrote. wherdr cannot tell them apart. If you run one, make sure it only listens on a private
> address, serve it over HTTPS and **create a passkey**.

`tailscale serve` (npm, Homebrew, the Herdr plugin) forwards to `127.0.0.1` with the
tailnet client's address in `X-Forwarded-For`: accepted, nothing to set up.

**Another private network** (ZeroTier, WireGuard, NetBird outside `100.64.0.0/10`): name its
range, `WHERDR_TRUSTED_NETWORKS=10.147.17.0/24` (comma-separated CIDR ranges or addresses), then
restart wherdr. Such devices get the whole app, Settings › Phone and the one-tap update
included, like the tailnet. `WHERDR_TRUSTED_NETWORKS=any` accepts every network: wherdr then
warns at startup and shows a warning that cannot be hidden in the app. Use it only when
something else protects the network (Cloudflare Access), and set up a passkey there too.
