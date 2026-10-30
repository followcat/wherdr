# Contributing to wherdr

Thanks for your interest! Issues and pull requests are welcome.

## Development setup

Requirements: Node.js 22 and a Herdr ≥ 0.9.1 server on the same machine.

```sh
npm ci
npm run dev          # http://localhost:3000, hot reload
npx vitest run       # unit and component tests
npx nuxt typecheck   # type check (TypeScript stays on 5.x: TS 7 breaks vue-tsc)
npm run build        # production build in .output/
npm run build:demo   # browser demo (wherdr.dev/demo/) in .output-demo/public/
```

Before opening a pull request, run the [affected tests](#agent-test-rule) and `npx nuxt typecheck`, and add
tests for new logic (see [Tests](#tests) below; fixtures in `tests/fixtures/`, **never real
conversations or personal paths**: use neutral names such as `host-a`, `laptop`, `alice`,
`/home/user`).

### The browser demo

`npm run build:demo` builds the same app with `VITE_WHERDR_DEMO=1`: static files for the `/demo/`
path, with no `server/` code and no service worker. `app/demo/plugin.client.ts` (added only to
that build) replaces `fetch` and `WebSocket` before the app starts: `app/demo/server.ts` answers
`/api/*` and the live state from the invented session of `app/demo/scenario.ts`, scripted turns
included; files under `/demo/` load normally; every other request is refused. Serve the folder
under `/demo/` to try it (for example `.output-demo/public` copied to `<root>/demo`). The site
workflow (`.github/workflows/site.yml`) builds it and deploys it with the site. Demo content stays
invented and in English, like the test fixtures.

The README screenshots (`docs/screenshots/`) are taken from that build: `npm run build:demo`, then
`npm run shots:readme` (computer at 1440×900, phone as an iPhone 13). The launch film in `assets/`
is made from it too: see `tools/launch-video/README.md`.

## Tests

**A fixed bug comes with a test that fails before the fix and passes after it.** Write the test
first, watch it fail on the buggy code, then fix. Test what the user sees (a rendered element, a
sent request, a stored value), not the wiring.

| Kind | Where | Run | What it covers |
| --- | --- | --- | --- |
| Unit | `tests/*.test.ts` | `npx vitest run --project unit` | Pure modules of `server/`, `shared/`, `app/utils/`, in Node. |
| Component | `tests/components/*.test.ts` | `npx vitest run --project components` | Vue components mounted in a Nuxt environment (auto-imports, Nuxt UI) on happy-dom, with `mountSuspended` and `registerEndpoint` from `@nuxt/test-utils/runtime`. |
| End to end | `tests/e2e/*.spec.ts` | `npm run build && npm run test:e2e -- tests/e2e/<name>.spec.ts --project chromium-phone` | The built app in Chromium and WebKit (Safari's engine, for iOS bugs), at iPhone and desktop sizes, against a fake Herdr server with neutral data. |

`npx vitest run` runs the unit and component projects together. For the end-to-end tests,
install the browsers once with `npx playwright install --with-deps chromium webkit`; a single
project and spec run with `npm run test:e2e -- tests/e2e/<name>.spec.ts --project=webkit-phone`
(names in `playwright.config.ts`),
and `npx playwright show-report` opens the last report. They never touch a real Herdr session.

For a focused check of browser-test stability, build once, then run
`npm run test:e2e:stability`. It covers Codex startup, held MCP navigation, legacy quote
preferences, UTC midnight, and setup deep links on all four profiles, with retries disabled.
Use this small set for a quick regression check; `npm run test:e2e` still runs the full suite.
Repeated runs of entire files can take tens of minutes on a small machine.

GitHub Actions (`.github/workflows/ci.yml`) runs all of them, the type check and the leak check
(gitleaks only: your `.leak-patterns` stays local). Pull requests and pushes run a light
end-to-end set: every test on `chromium-phone` (two shards) and, on the other three projects,
only the tests tagged with that project's name: `{ tag: '@webkit-phone' }` for a Safari/iOS
journey, `'@chromium-desktop'` for a keyboard or split-view case, `'@webkit-desktop'` for iPad
and desktop Safari. A test skipped on phones must carry one of these tags, or the run fails
(`tests/e2e/scope.ts`). The whole suite on all four projects runs only on a manual run of the
workflow and on release tags `vX.Y.Z`.
`E2E_SCOPE=light npm run test:e2e -- --project=webkit-phone` reproduces the light selection
locally; without `E2E_SCOPE`, a local run is the whole suite. CI retries a failed test once (it
then shows as flaky); local runs never retry.

## Agent test rule

Read the relevant [documentation page](docs/README.md), rather than the entire documentation.
For setup use [Installation and updates](docs/installation.md); for UI changes read the
[device guide](docs/devices.md) and the iOS notes in [Conventions](#conventions).
Check documentation links with `npm run check:docs`.

Test each change at the lowest level that can detect the regression. Use Node for parsers,
state transitions and server contracts; `mountSuspended` on happy-dom for component state
and emitted actions. Use a real browser for focus, keyboard, selection, layout and overlays
(the repository currently uses Playwright, with no Vitest Browser Mode project). Add an
end-to-end test when the regression crosses the built app, routing, transport or Herdr
boundaries. Reuse an existing journey when it proves the same contract.

Start with `npm run test:affected -- --base <target-branch> --dry-run`, review its selection,
then run `npm run test:affected -- --base <target-branch>`. Use `origin/develop` when targeting develop (the integration branch; main only receives releases).
The selector combines `vitest related --run` with the reviewed domain table in
[`scripts/test-affected.mjs`](scripts/test-affected.mjs). The dry run prints changed paths
(including both sides of renames), domain reasons, explicit tests and sources passed to
Vitest related; the import graph is resolved by Vitest during execution. Deleted files use
their former domains. Changed tests run explicitly. Documentation alone runs no browser.
Unknown paths, missing merge-bases and global infrastructure select all unit/component
tests plus a startup e2e smoke, and recommend CI's complete reduced suite; review additional
journeys for these broad changes. A missing base must be fetched before relying on the diff.

Run typecheck and the configured lint checks for code changes. There is currently no lint
script: do not invent a successful lint command. Do not run the full Playwright suite locally.
Run only relevant specs on one project, `chromium-phone` by default; pass `--safari` to the
selector for Safari-specific behavior (`webkit-phone`). The selector serializes heavy
commands with `flock /tmp/wherdr-heavy.lock`, builds once only if e2e tests are selected,
and finds a free port in 7690–7699. Its e2e tests use the existing isolated fake-data launcher.
For manual commands, use the same lock, port range, isolated data and sessions.
Never connect tests to a user's live agents.

For a new regression, demonstrate that the test fails with the broken behavior and passes
with the fix. Assert observable output or effects, not only internal wiring. Do not use
happy-dom to prove geometry, touch behavior or focus. Do not add arbitrary sleeps or retries
to hide races. Report selected tests, results and any untested boundary. CI runs the complete
reduced suite and required Safari selection; this local selector does not change CI.

## Testing without touching your real agents

wherdr can start, stop and type into agents. Work against an **isolated Herdr session** and a
separate data folder, never your everyday session:

```sh
# Start an isolated Herdr session (from a plain terminal: when launched from inside a Herdr
# pane, unset the inherited HERDR_* and CLAUDE_* variables first).
herdr --session wherdr-dev server &

# Point a dev instance at it, with its own data folder (no passkeys, no push subscriptions).
mkdir -p dev-data && echo '{ "subs": [] }' > dev-data/push.json
HERDR_WEB_SESSION=wherdr-dev HERDR_WEB_MACHINES=off DATA_DIR=dev-data npm run dev

# Clean up afterwards.
herdr --session wherdr-dev server stop
rm -rf ~/.config/herdr/sessions/wherdr-dev dev-data
```

Do not test model changes with `/model <name>` or Enter in the `/model` menu of a real agent:
both change the account's default model. wherdr itself only uses "this session" choices.

## Language

- **English everywhere developers look**: code, identifiers, comments, test names, server
  logs, commit messages, pull requests, issues and docs (README, CHANGELOG, CONTRIBUTING).
- **The interface is bilingual (English / French)**: keys are written in English and the
  French text lives in the `FR` dictionary of `app/utils/i18n.ts` (see Conventions below).
- French only appears as data: translations, regular expressions matching French screens,
  and test fixtures reproducing real French text.

## Conventions

- **Interface text** goes through `t()` / `tl()` (`app/utils/i18n.ts`). Write the English
  text as the key, `t('Rename pane')`, and add its French translation to the `FR` dictionary
  in the same file: it is required, `tests/i18n.test.ts` fails on a `t()` key without a French
  entry and on an entry nothing uses. Text with variable parts uses `tl(en, fr)`, both written
  in full: ``tl(`${n} agents`, `${n} agents`)``. A missing translation shows English, never
  another language. Error messages the server sends to the UI are English keys too.
- **Design**: square corners, 1 px lines, Archivo / Inter / JetBrains Mono, uppercase mono
  labels; colors come from the theme variables (`app/assets/css/main.css`,
  `app/utils/themes.ts`). Check the phone layout (iPhone size) and the desktop layout.
- **iOS**: keep `apple-mobile-web-app-status-bar-style` on `black` (with `black-translucent`,
  iOS 26 shortens the installed app from the bottom), and mind the keyboard and safe areas.
- **Terminal input and IME**: xterm's `onData` does not distinguish a keystroke from
  committed composition text, even a single ASCII character. Preserve the composition
  lifecycle and the guard for the first data event after `compositionend`; a keydown with
  `isComposing` or `keyCode === 229` must not clear it. Handle ordinary keydown in capture
  on the terminal element before xterm emits data, so cancelling composition does not
  swallow the next shortcut. Composition output and paste clear virtual modifiers and
  stay text; ordinary keys still consume one-shot modifiers and preserve real Shift.
  Keybar layout changes must preserve input focus and these contracts. The browser
  regressions are in `tests/e2e/terminal-ime.spec.ts` and `terminal-modifiers.spec.ts`.
- Server code lives in `server/` (Nitro), shared types and pure helpers in `shared/`, the
  client in `app/`.

## Leak check

The repository is public, and so is every commit in its history: a private value committed and
then removed is still published. `scripts/check-leaks.mjs` combines two checks:

- **gitleaks** for tokens and keys: the `gitleaks` binary when installed
  ([install it](https://github.com/gitleaks/gitleaks#installing)); otherwise it is skipped with a
  message.
- **Your forbidden patterns** for what no generic tool knows: your user name, host names,
  e-mail addresses, tailnet, private IPs, project and client names. They live in `.leak-patterns`,
  which git ignores (format in `.leak-patterns.example`: one case-insensitive regex per line,
  `regex !! glob, glob` to allow it in some files, `! glob` to never scan a file). In a linked
  worktree, the main checkout's file is used when the worktree has none.

```sh
cp .leak-patterns.example .leak-patterns          # then list your own private values
npm run check:leaks                               # every file of the git index
npm run check:leaks -- --staged                   # staged files only
npm run check:leaks -- --range origin/main..HEAD  # every commit you are about to push
npm run hooks:install                             # run --staged before each commit
```

What each mode covers:

| Mode | Patterns scan | gitleaks scans |
| --- | --- | --- |
| default | the content of every file in the git index | the same files |
| `--staged` | the content of staged files | the same files |
| `--range <revs>` | for each commit of the range, the lines it adds (per-file exceptions apply) and its message (every pattern applies) | the same commits (`gitleaks git --log-opts`) |

In `--range` mode, merge commits only contribute the lines that differ from all their parents
(conflict resolutions); the merged commits are scanned on their own when they are in the range.
Run it before every push: the pre-commit hook only sees the final state of the files, so a
value added in one commit and removed in the next would pass it.

Matches are printed as commit (in `--range` mode), `file:line` or `message:line`, and the pattern;
the value itself is truncated, never shown in full. Any match makes the command exit with a
non-zero code. `--no-gitleaks` runs the patterns only.

Test fixtures are often captured from real terminals: replace project, folder, branch and host
names, session titles, addresses and IDs with neutral ones (`acme-shop`, `demo`, `feature/x`,
`host-a`) before committing them.

## Reporting security issues

Please do not open public issues for vulnerabilities: see [SECURITY.md](SECURITY.md).
