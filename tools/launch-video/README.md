# wherdr launch film

A silent 36-second animation of wherdr v3: big Archivo headlines, Titanium grid,
real app screens. On a computer: Home, Alfred listing what waits, a project
coordinator planning two tasks, Tasks to review approving WEB-7 from its
screenshots, the Board moving it to Done; then the same session on a phone,
answering an agent's question with one tap; a wherdr.dev end card. The square cut
is 1080×1080; the wide cut reflows the composition to 1920×1080. Both are H.264
at 30 fps. `wherdr-launch.webp` is a looping 720×720 animated WebP at 15 fps.

Every app screen is an **unaltered Playwright screenshot of the v3 demo build**
(`npm run build:demo`, fictional data from `app/demo/`), taken after a real click
in one live page and session; only the demo strip at the top is hidden. The
desktop and phone screens are the same page, resized without reloading. The
blue outlines around the control used next and the slow zooms are part of the
marketing stage. No actual agent command runs.

## Rebuild

Use Node 22, FFmpeg/ffprobe and Playwright Chromium. Install the root dependencies
and this directory's pinned animation dependencies (`npm ci --prefix tools/launch-video`).
On a shared host, hold the heavy-job lock and use low priority:

```sh
flock /tmp/wherdr-heavy.lock nice -n 15 node tools/launch-video/render.mjs
```

The script checks that `app/` and `nuxt.config.ts` match `origin/v3` (another
branch with `WHERDR_FILM_BASE`, e.g. `WHERDR_FILM_BASE=HEAD`), builds
`npm run build:demo`, captures the shots (`capture.mjs`), verifies each PNG's
SHA-256, then renders the HTML/GSAP stage with HyperFrames 0.8.169 (one worker,
low-memory mode, no GPU). FFmpeg adds source metadata and makes the WebP.
Use `--skip-build` after building the demo, or `--reuse-captures` to recompose
verified screenshots already in `.generated/`. `--stills --reuse-captures` previews
both layouts without encoding the videos. Rendering closes its browser on exit.

`capture.json` records the source commit, app tree, and for each shot the action
that led to it, its route, viewport and hash. `timeline.js` sets when each shot
shows; the stage's length is `data-duration` in `index.html`, which the verifier
and the README animation read. Only loopback requests are allowed during capture.

```sh
node tools/launch-video/verify.mjs
flock /tmp/wherdr-heavy.lock nice -n 15 node tools/launch-video/review.mjs
```

The verifier checks provenance, silent H.264, dimensions, duration, frame count,
fast-start metadata, file-size budgets (8 MiB per MP4, 5 MiB for the WebP) and
WebP loop/duration. The review script extracts every third output frame of both
cuts in numbered contact sheets, plus four full-resolution key images, under
`.shots/v3-review/`. Review them before publishing.

Outputs replace `assets/wherdr-launch{,-wide}.mp4` and `assets/wherdr-launch.webp`.
Sources use local fonts and assets; telemetry and update checks are disabled.

## Refresh only the README animation

The README has its own `assets/wherdr-readme.webp`. It uses the same stage and
captures, sampled at 15 fps directly in Chromium and encoded as a looping 720×720
WebP (under 5 MiB). After installing the dependencies above and running
`npm run build:demo`:

```sh
flock /tmp/wherdr-heavy.lock nice -n 15 node tools/readme-shots/animate.mjs
```

`assets/wherdr-readme.json` records the source revision, the shots and the measured
output properties. Temporary rendered PNGs go under `$TMPDIR` and are removed after
encoding; use `--reuse-captures` to re-encode already captured demo screens.
