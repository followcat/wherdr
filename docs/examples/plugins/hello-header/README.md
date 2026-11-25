# hello-header

Test plugin for the wherdr plugin API ([docs/plugins.md](../../../plugins.md)): a
button in `header-actions` that inserts a sample template into the open draft and
focuses the composer without sending.

- `manifest.json`, `index.js`: what you install (`index.js` is prebuilt).
- `src/index.ts`: the source. Rebuild with `npm run build:example-plugin` from the repo root.

Install: copy `manifest.json` and `index.js` to `<DATA_DIR>/plugins/hello-header/`, reload the page.
Remove: delete that folder.
