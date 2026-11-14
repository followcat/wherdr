# Install as an app

[Documentation](README.md) · [Project](../README.md)

## Install it as an app

For phone access, first configure [private HTTPS](networks.md). For UI development, see the
[iOS conventions](../CONTRIBUTING.md#conventions), including the iOS 26 status-bar pitfall.

The app must be served over HTTPS (see [Requirements](installation.md#requirements)). Installed, wherdr opens
in its own window, without the browser's bars.

- **iPhone / iPad** (iOS 16.4 or later): open the address in **Safari** → Share →
  **Add to Home Screen**. Open wherdr from the home screen, then Settings → **Enable
  notifications**. On iOS, push notifications only work in the installed app.
- **Android**: open the address in **Chrome** → menu → **Install app** (or Add to Home
  screen), then Settings → **Enable notifications**.
- **Mac, Safari** (macOS 14 Sonoma or later): File → **Add to Dock**.
- **Chrome, Edge, Brave** (macOS, Windows, Linux): the install icon at the right of the address
  bar, or menu → **Cast, save and share** → **Install page as app** (Edge: Apps → **Install
  this site as an app**).
- **Arc** cannot install web apps
  ([Arc Help Center](https://resources.arc.net/hc/en-us/articles/25678978728983-Does-Arc-for-Desktop-Support-Progressive-Web-Apps)):
  open the address in Safari or Chrome for that, or keep wherdr as an Arc favorite.

Then Settings → Security → **Enable passkey lock** on each device.

## App start

Settings › Phone › **App start** sets how this device opens the app:

- **Up to date** (default): the server's current version, or the saved copy when the server
  has not answered within 3 seconds.
- **Instant**: the saved copy at once, for a weak network. When the server has a newer version,
  a **Reload** banner offers it.

After an update the server keeps serving the files of the two previous versions (in
`<data dir>/builds/`), so a page opened before the update keeps working.
While the server restarts for an update, an open page keeps showing what it showed; only
a **Reload** banner appears, and the app never reloads by itself.
