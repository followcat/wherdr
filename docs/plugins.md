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

A plugin is two files in one folder: `manifest.json` and a prebuilt ES module. Three working examples ship in the repository:

- [`docs/examples/plugins/agents-count/`](examples/plugins/agents-count/): shows the live agent count and one terminal label in `header-actions`, updating reactively through `wherdr.agents()` and `wherdr.onAgents()`.
- [`docs/examples/plugins/hello-header/`](examples/plugins/hello-header/): mounts a button in `header-actions` using only `wherdr.mountHeaderAction` and `wherdr.draft`.
- [`docs/examples/plugins/hello-mic/`](examples/plugins/hello-mic/): a microphone button in `composer-actions` that inserts a fixed sample text (no audio).

To follow the steps without writing code, install either example as is.

1. **Write** `src/index.ts` (or plain `index.js`). Export an object `{ activate(wherdr), deactivate() }`
   (or a function) as described in [The module](#the-module). Use host helpers such as
   `wherdr.mountHeaderAction` when available, or look up a `data-wherdr` marker and re-attach on
   `wherdr.onNavigate`. Undo your own DOM side effects (such as `<style>` elements) in
   `deactivate()`; host registrations are disposed automatically when the plugin stops. Do nothing
   at the top level of the module: it runs as soon as the file loads, even when the plugin is turned
   off before it activates.
2. **Build** one ES module with no external imports (the examples use esbuild, installed with the repo's
   dependencies; any bundler works): `npx esbuild src/index.ts --bundle --format=esm --target=es2020 --outfile=index.js`.
   For the examples: `npm run build:example-plugin` from the repo root.
3. **Install**: copy `manifest.json` and `index.js` (not the sources) to
   `<DATA_DIR>/plugins/<id>/`, e.g. `mkdir -p data/plugins/hello-header && cp docs/examples/plugins/hello-header/{manifest.json,index.js} data/plugins/hello-header/`.
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
  const offNav = wherdr.onNavigate((path) => console.log('now at', path))
  const offBtn = wherdr.mountHeaderAction((el) => {
    const button = document.createElement('button')
    button.textContent = 'Template'
    button.onclick = () => {
      if (wherdr.draft.get() === null) return
      wherdr.draft.set('Please fix the failing test.')
      wherdr.draft.focus()
    }
    el.append(button)
  })
}
```

| API | Meaning |
|---|---|
| `wherdr.apiVersion` | `1`. Additive changes keep the number; a breaking change raises it. |
| `wherdr.draft.get()` | Returns the open conversation's draft text, or `null` when no conversation is open. |
| `wherdr.draft.set(text)` | Replaces the open conversation's draft with `text`. Nothing is sent; no-op when no conversation is open. |
| `wherdr.draft.insert(text)` | Appends `text` to the draft of the open conversation (nothing is sent). No-op when no conversation is open. |
| `wherdr.draft.focus()` | Focuses the open conversation's composer. On iOS, raises the keyboard only inside a user gesture. |
| `wherdr.currentAgent()` | `{ id, agent, name, machine }` of the open conversation, or `null` (`agent` is `claude`, `codex`, `omp`… or `null` for a terminal). |
| `wherdr.agents()` | Returns copied `PublicAgent[]` snapshots from the client's live state (zero extra requests). |
| `wherdr.machines()` | Returns copied `PublicMachine[]` snapshots from the client's live state (zero extra requests). |
| `wherdr.onNavigate(cb)` | `cb(path)` after each page change (`/`, `/settings?section=plugins`…). Returns a tracked, idempotent disposer. |
| `wherdr.onAgents(cb)` | `cb(agents)` with copied `PublicAgent[]` snapshots whenever live state changes the projected agent list. Returns a tracked, idempotent disposer. |
| `wherdr.mountHeaderAction(render)` | Mounts a widget into `[data-wherdr="header-actions"]` across the Home and agent headers. Returns a tracked, idempotent disposer. |

### Drafts (`wherdr.draft`)

A plugin can prepare input in the open conversation's composer (`curPane`) without ever submitting it:

- **`wherdr.draft.get()`** returns the current draft string, or `null` when no conversation is open.
- **`wherdr.draft.set(text)`** replaces the draft text (pass `""` to clear it). Does nothing when no conversation is open.
- **`wherdr.draft.insert(text)`** appends `text` after a space when needed. Does nothing when no conversation is open.
- **`wherdr.draft.focus()`** focuses the composer textarea when a conversation is open and its composer is shown. **On iOS, `focus()` raises the keyboard only when called synchronously inside a user gesture** (such as a button `click` handler).

**Nothing is ever sent.** No plugin API submits a draft, sends a message, or answers an agent prompt: the human stays the sender.

### Header actions (`wherdr.mountHeaderAction`)

`wherdr.mountHeaderAction(render)` mounts small header widgets without querying the DOM or managing
`MutationObserver`s.

- **wherdr owns the container.** Whenever a `[data-wherdr="header-actions"]` slot exists (in the Home header and in the agent header, including headers mounted on later navigation), wherdr creates a child element and calls `render(el)`.
- **Cleanup.** `render(el)` may optionally return a cleanup function `() => void`, which wherdr calls when that header unmounts or when the widget is disposed. Removing the host-owned element removes everything you appended to it.
- **Disposer.** `mountHeaderAction` returns a tracked, idempotent disposer `() => void` that unmounts all copies immediately.

### Agents and machines (`wherdr.agents`)

`wherdr.agents()`, `wherdr.machines()`, and `wherdr.onAgents(cb)` expose read-only projections of the
state the client already holds over `/ws/events`, with zero extra network requests.

- **`PublicAgent`**:
  - `id`: public conversation id (`w1:p1` on the local host, `<machine>~w1:p1` on a remote host).
  - `machine`: remote machine key, or `null` on the local host (matching `currentAgent().machine`).
  - `name`: terminal display name (or label title), else `null`.
  - `title`: terminal title, else `null`.
  - `agent`: agent kind (`claude`, `codex`, `omp`…), or `null` for a shell.
  - `status`: `idle`, `working`, `blocked`, `unknown`, or `null`.
  - `labels`: `Record<string, string>` copy of the herdr-core terminal's labels (`{}` when empty).
- **`PublicMachine`**:
  - `id`: machine key (`""` for the local host).
  - `groupKey`: machine group key (`baseKey ?? key`).
  - `label`: machine display label.
  - `local`: `true` for the local host, `false` for remote machines.
  - `status`: `online`, `connecting`, or `offline`.
- **Never exposed.** Internal transport and host fields (`coreAddress`, socket paths, SSH targets, working directories `cwd`, transcript `agentSession` ids, connection errors, and any session name) are never projected because they are internal routing/host details plugins do not need and must not read or mutate.
- **Copied snapshots and zero idle cost.** Every call to `agents()`, `machines()`, and every `onAgents(cb)` delivery receives freshly copied objects and `labels` maps, so mutating them changes nothing in wherdr or other plugins. `onAgents(cb)` watches state only while subscribers exist and ignores pushes whose projected `PublicAgent[]` list did not change.

### Lifecycle and failure isolation

The host owns registration lifecycles:

- **Tracked, idempotent disposers.** Every registration call (`onNavigate`, `onAgents`, `mountHeaderAction`) returns a disposer `() => void` that can be called safely more than once.
- **Cleaned up on stop.** Stopping a plugin — by flipping its switch off, updating or removing it, turning [Community plugins](#community-plugins-switch) off, or after an error — automatically disposes all of its registrations, whether `deactivate()` is missing, throws synchronously, or returns a rejected promise.
- **Failures are isolated.** A plugin that throws while loading or activating, does not answer within 8 seconds, has no valid default export, or whose host-invoked callback (`onNavigate`, `onAgents`, `mountHeaderAction` renderer) throws or returns a rejected promise, is **disabled**: its registrations are disposed and Settings › Plugins shows it as "Disabled after an error" with the message. Other plugins and the app keep working, and flipping its switch tries it again. Errors thrown inside your own DOM event listeners (such as a button's `click` handler) are yours to catch.

### Markers: `data-wherdr`

Key zones carry a stable `data-wherdr` attribute. **These values are a public contract**: they are
not renamed or removed within a major version; the markup inside a zone is not part of it.

| Marker | Zone |
|---|---|
| `composer` | The whole message box of a conversation. |
| `composer-field` | The text field. |
| `composer-actions` | An empty slot in the field's footer, just before Send: append your buttons to it. |
| `header-actions` | An empty, zero-width slot in the Home header and agent header, before existing buttons (accounted for by header folding when populated). Prefer `wherdr.mountHeaderAction`. |
| `conversation` | The conversation view (the messages). |
| `home-list` | The home screen with the list of agents. |
| `settings` | The Settings page. |
| `settings-plugins` | The wherdr plugins block of Settings › Plugins. |

Plugins run before or after a zone is created (zones come and go with navigation): use host
helpers such as `wherdr.mountHeaderAction` where offered, or look up the marker on each
`onNavigate` / observe the document rather than querying once at load.

### Not yet

A server part for plugins, and signing or permissions. A plugin's CSS is its
own business: use wherdr's theme variables (`var(--line)`, `var(--dim)`…) to blend in.
