# hello-mic

Test plugin for the wherdr plugin API ([docs/plugins.md](../../../plugins.md)): a
microphone button next to Send that inserts a fixed sample text into the draft. No audio.

- `manifest.json`, `index.js`: what you install (`index.js` is prebuilt).
- `src/index.ts`: the source. Rebuild with `npm run build:example-plugin` from the repo root.

Install: copy `manifest.json` and `index.js` to `<DATA_DIR>/plugins/hello-mic/`, reload the page.
Remove: delete that folder.
