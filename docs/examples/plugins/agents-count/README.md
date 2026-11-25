# agents-count

Example plugin for the wherdr plugin API ([docs/plugins.md](../../../plugins.md)): shows
the live agent count and one terminal label in `header-actions` using `wherdr.agents()`,
`wherdr.onAgents()`, and `wherdr.mountHeaderAction()`.

- `manifest.json`, `index.js`: what you install (`index.js` is prebuilt).
- `src/index.ts`: the source. Rebuild with `npm run build:example-plugin` from the repo root.

Install: copy `manifest.json` and `index.js` to `<DATA_DIR>/plugins/agents-count/`, reload the page.
Remove: delete that folder.
