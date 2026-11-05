# Development and tests

[Documentation](README.md) · [Project](../README.md)

### From source

For development, or to run a checkout of your own. With an hc session running, Git and Node.js 22
on the same machine:

```sh
git clone -b v3 https://github.com/afloury/wherdr.git
cd wherdr
npm ci
npm run build
HC_SOCKET=/path/to/hc.sock npm start   # listens on 127.0.0.1:7683
```

For hot reload, `HC_SOCKET=/path/to/hc.sock npm run dev` (`http://localhost:3000`).

Open `http://localhost:7683` in a browser on that computer: the desktop layout, passkeys and the
installable app work there, since browsers treat `localhost` as secure. There is no phone access
and no push notification in this setup; for that, use the [recommended setup](networks.md#recommended-always-on-server--tailscale) (or publish this
instance with `tailscale serve` as described there and start it with
`APP_URL=https://server.example.ts.net:7683/`).

Run it as the user who runs hc. `DATA_DIR` holds passkeys, push data and recent folders (default
`./data`). `npm start` listens on `127.0.0.1` (`HOST`) and port `7683` (`PORT`). The
first-passkey bootstrap token is printed in its output.

With `APP_URL` empty or `http://localhost:7683/`, wherdr starts normally but disables Web Push
and logs a warning.

**Never point a development instance at the hc session that runs your real agents**: use a
separate hc session and its own socket, and a separate `DATA_DIR`.

### Tests of the core build

The core routes are listed in `shared/coreRoutes.ts` (one file per lot in `shared/coreRoutes/`);
the server guard and the client use the same list. Unit and component tests run as usual
(`npx vitest run`). The core smoke test starts its own server and a fake core socket, with no
real hc session:

```sh
npm run build
npx playwright test -c playwright.core.config.ts
```

CI runs the same build and smoke test on every push.

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md), including the [agent test rule](../CONTRIBUTING.md#agent-test-rule)
and `npm run test:affected -- --base origin/v3 --dry-run` (pull requests for v3 target the `v3` branch). Changes are listed in [CHANGELOG.md](../CHANGELOG.md).

Every commit is public: a leak check (gitleaks plus your own forbidden patterns) covers the files
and the commits about to be pushed; see [Leak check](../CONTRIBUTING.md#leak-check).
