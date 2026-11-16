# Plugins

[Documentation](README.md) · [Project](../README.md)

wherdr plugins run in the wherdr page. The wherdr Herdr plugin and Herdr plugin actions belonged
to v2 and need Herdr; they are not part of v3.

## wherdr plugins

wherdr plugins are small JavaScript bundles that run in the wherdr page, Obsidian style. They are
**optional and none is installed by default**: with an empty (or missing) plugins folder, wherdr
behaves exactly as without the feature. There is no install from GitHub yet; you copy the plugin
yourself. A plugin has full access to the page, so only install code you trust.

### Install

Put one folder per plugin in `plugins/` of wherdr's data directory (`DATA_DIR`, `./data` by
default), then reload the page:

```
data/plugins/my-plugin/manifest.json
data/plugins/my-plugin/index.js
```

```json
{ "name": "My plugin", "version": "1.0.0", "description": "What it does.", "main": "index.js" }
```

The folder name is the plugin id (`a-z`, `0-9`, `.`, `_`, `-`). `main` is optional (default
`index.js`): a plain file name of a prebuilt ES module in the same folder (no build step in wherdr,
no sub-folders). **Settings › Plugins** lists the installed plugins with a switch each; the choice
is kept per device.

### Build and install a plugin (step by step)

A plugin is two files in one folder: `manifest.json` and a prebuilt ES module. The complete
working example is [`docs/examples/plugins/hello-mic/`](examples/plugins/hello-mic/): a microphone
button next to Send that inserts a fixed sample text (no audio). To follow the steps without
writing code, install it as is.

1. **Write** `src/index.ts` (or plain `index.js`). Export an object `{ activate(wherdr), deactivate() }`
   (or a function) as described in [The module](#the-module). Find your zone with its
   `data-wherdr` marker, and attach to it again when it reappears (use a `MutationObserver` and/or
   `wherdr.onNavigate`). Undo everything in `deactivate()`.
2. **Build** one ES module with no external imports (the example uses esbuild, installed with the repo's
   dependencies; any bundler works): `npx esbuild src/index.ts --bundle --format=esm --target=es2020 --outfile=index.js`.
   For the example: `npm run build:example-plugin` from the repo root.
3. **Install**: copy `manifest.json` and `index.js` (not the sources) to
   `<DATA_DIR>/plugins/<id>/`, e.g. `mkdir -p data/plugins/hello-mic && cp docs/examples/plugins/hello-mic/{manifest.json,index.js} data/plugins/hello-mic/`.
   Reload the page: no restart needed.
4. **Check**: Settings › Plugins lists it as "On". If it says "Disabled after an error", the message is
   the exception; fix it and flip the switch.
5. **Remove**: delete the folder and reload; wherdr is back to exactly how it was.

### The module

The default export is a function, or an object with `activate` (and optionally `deactivate`),
called once with the `wherdr` object:

```js
export default function (wherdr) {
  const off = wherdr.onNavigate((path) => console.log('now at', path))
  const button = document.createElement('button')
  button.textContent = 'Fix'
  button.onclick = () => wherdr.draft.insert('Please fix the failing test.')
  document.querySelector('[data-wherdr="composer-actions"]')?.append(button)
}
```

| API | Meaning |
|---|---|
| `wherdr.apiVersion` | `1`. Additions keep the number; a breaking change raises it. |
| `wherdr.draft.insert(text)` | Appends `text` to the draft of the open conversation (nothing is sent). No-op when no conversation is open. |
| `wherdr.currentAgent()` | `{ id, agent, name, machine }` of the open conversation, or `null` (`agent` is `claude`, `codex`, `omp`… or `null` for a terminal). |
| `wherdr.onNavigate(cb)` | `cb(path)` after each page change (`/`, `/settings?section=plugins`…). Returns the function that unsubscribes. |

### Failures are isolated

A plugin that throws while loading or activating, does not answer within 8 seconds, has no valid
default export, or whose `onNavigate` callback throws, is **disabled**: its listeners are removed
and Settings › Plugins shows it as "Disabled after an error" with the message. The other plugins
and the app keep working. The switch tries it again. Errors thrown by your own DOM listeners
(like the button above) are yours to catch.

### Markers: `data-wherdr`

Key zones carry a stable `data-wherdr` attribute. **These values are a public contract**: they are
not renamed or removed within a major version; the markup inside a zone is not part of it.

| Marker | Zone |
|---|---|
| `composer` | The whole message box of a conversation. |
| `composer-field` | The text field. |
| `composer-actions` | An empty slot in the field's footer, just before Send: append your buttons to it. |
| `conversation` | The conversation view (the messages). |
| `home-list` | The home screen with the list of agents. |
| `settings` | The Settings page. |
| `settings-plugins` | The wherdr plugins block of Settings › Plugins. |

Plugins run before or after a zone is created (zones come and go with navigation): look up the
marker on each `onNavigate`, or observe the document, rather than once at load.

### Not yet

Install from GitHub, a server part for plugins, and signing or permissions. A plugin's CSS is its
own business: use wherdr's theme variables (`var(--line)`, `var(--dim)`…) to blend in.
