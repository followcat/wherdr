# Plugins

[Documentation](README.md) · [Project](../README.md)

wherdr plugins run in the wherdr page. The wherdr Herdr plugin and Herdr plugin actions belonged
to v2 and need Herdr; they are not part of v3.

## wherdr plugins

wherdr plugins are small JavaScript bundles that run in the wherdr page, Obsidian style. They are
**optional and none is installed by default**: with an empty (or missing) plugins folder, wherdr
behaves exactly as without the feature. You [install one from GitHub](#install-from-github) or copy
its folder yourself. A plugin has full access to the page, so only install code you trust.

### Community plugins switch

No plugin loads until **Settings › Plugins › Community plugins** is on. It is **off by default**
and is stored once for the wherdr server (`settings.json` in the data directory), so every device
agrees. Turning it on first shows this warning, with *Turn on* and *Cancel*:

> Plugins run inside wherdr with full access: they can read your conversations, write to your
> agents and run commands on your machines. Only turn this on for plugins you trust.

Full access means there is no sandbox and no permission: a plugin runs as wherdr's own page code
and can call wherdr's API as you do, so it can read every conversation, type into and send to your
agents, and run `!` commands, on every connected machine. While the switch is off, each plugin keeps
its own switch, greyed; turning Community plugins off stops the running plugins at once on every open
device. While `settings.json` cannot be read (damaged, or a read error), plugins stay off and the
saved choice is left as it is.

An install from before the switch that already had plugins in its folder keeps loading them: the
first time the server reads the switch and finds it unset, it stores *on* when the plugins folder
holds a plugin and *off* otherwise. A plugin copied in later therefore waits for the switch.

### Install from GitHub

**Settings › Plugins › Install from GitHub** takes `owner/repo`, optionally followed by `@tag`,
`@branch` or `@commit` (default: the latest release's tag, else the default branch). *Look up* shows
what will be installed: the name, version and description from the manifest, the repository and the
**exact commit**, with the full-access warning. Nothing is written before *Install*, which also turns
[Community plugins](#community-plugins-switch) on. The repository must be public; no git is needed.

The server downloads that commit through the GitHub API and keeps only `manifest.json` and the
plain files of the plugin's folder (sub-folders, such as `src/`, and dot files are left out). It
refuses a link, a file name that is not plain, more than 50 files or 5 MB, a manifest without its
`main` file, and an id already installed from somewhere else (remove that one first). The files go
to a temp folder first, then are renamed into `plugins/<id>/`: a private repository or a lost
network gives an error and changes nothing.

The source (repository, ref asked, commit) is kept next to the plugin, in `plugins/<id>/.source.json`.
Settings shows it as a link to the repository at that commit, with:

- **Check for update**: looks up the ref again (the latest release when none was given) and shows the
  new commit and version. Nothing is installed until you press *Update*; wherdr never updates on its
  own. *Update* leaves [Community plugins](#community-plugins-switch) as it is: while it is off, the
  new commit is written but nothing loads.
- **Remove** (also for a plugin copied by hand): deletes the plugin's folder after a confirmation.

### Publish a plugin on GitHub

1. Commit the **prebuilt** files (`index.js`, not only the sources): wherdr runs no build step.
2. Put `manifest.json` at the root of the repository. The plain files next to it are the plugin. To
   keep the built files apart, name their folder: `"folder": "dist"` takes the files of `dist/`
   (the manifest stays at the root).
3. The plugin id is the manifest's `id` (`a-z`, `0-9`, `.`, `_`, `-`), else the repository's name in
   lowercase.
4. Tag a release (`v1.0.0`): users get the latest release by default, and *Check for update* finds
   the next one. Raise `version` in the manifest with each release.

```json
{ "id": "hello-mic", "name": "Hello mic", "version": "1.0.0", "description": "What it does.", "main": "index.js", "folder": "dist" }
```

Users then type `you/your-repo` in Install from GitHub.

### Install by hand

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
is kept per device. They load only while [Community plugins](#community-plugins-switch) is on.

### Build and install a plugin (step by step)

A plugin is two files in one folder: `manifest.json` and a prebuilt ES module. The complete
working example is [`docs/examples/plugins/hello-mic/`](examples/plugins/hello-mic/): a microphone
button next to Send that inserts a fixed sample text (no audio). To follow the steps without
writing code, install it as is.

1. **Write** `src/index.ts` (or plain `index.js`). Export an object `{ activate(wherdr), deactivate() }`
   (or a function) as described in [The module](#the-module). Find your zone with its
   `data-wherdr` marker, and attach to it again when it reappears (use a `MutationObserver` and/or
   `wherdr.onNavigate`). Undo everything in `deactivate()`. Do nothing at the top level of the module:
   it runs as soon as the file loads, even when the plugin is turned off before it activates.
2. **Build** one ES module with no external imports (the example uses esbuild, installed with the repo's
   dependencies; any bundler works): `npx esbuild src/index.ts --bundle --format=esm --target=es2020 --outfile=index.js`.
   For the example: `npm run build:example-plugin` from the repo root.
3. **Install**: copy `manifest.json` and `index.js` (not the sources) to
   `<DATA_DIR>/plugins/<id>/`, e.g. `mkdir -p data/plugins/hello-mic && cp docs/examples/plugins/hello-mic/{manifest.json,index.js} data/plugins/hello-mic/`.
   Reload the page: no restart needed. Turn on Community plugins if it is off.
4. **Check**: Settings › Plugins lists it as "On". If it says "Disabled after an error", the message is
   the exception; fix it and flip the switch.
5. **Remove**: press *Remove* in Settings › Plugins (or delete the folder and reload); wherdr is back
   to exactly how it was.

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

A server part for plugins, and signing or permissions. A plugin's CSS is its
own business: use wherdr's theme variables (`var(--line)`, `var(--dim)`…) to blend in.
