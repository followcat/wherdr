# wherdr in one minute

Series introduction, in English. Matilda says “where-der”. Desktop 1920×1080,
constant 60 fps, with a desktop/phone comparison. Never publish without approval.

Use the shared pipeline in `../tutorial-board/README.md`; no second renderer,
voice client, aligner or verification implementation is needed. Build the normal
app first, not the static demo build. With `TUTORIAL_OUT` in a private temporary
directory and `TUTORIAL_BUILD` set to the checkout:

```sh
cp tools/tutorial-intro/storyboard.json "$TUTORIAL_OUT/storyboard.json"
TUTORIAL_CAPTURE="$PWD/tools/tutorial-intro/capture.mjs" \
  flock /tmp/wherdr-heavy.lock python3 tools/tutorial-board/session.py
# Load the key only into narrate.py's environment at invocation; never log it.
python3 tools/tutorial-board/narrate.py
python3 tools/tutorial-board/align.py
flock /tmp/wherdr-heavy.lock python3 tools/tutorial-board/render.py
python3 tools/tutorial-board/test_timing.py
python3 tools/tutorial-board/verify.py
```

The shared launcher checks and removes its own named `hwtest-video-*` session.
Capture uses the real app with the existing `app/demo/` in-browser transport,
bundled by esbuild. All conversations, paths and terminal output are fictional.
Two neutral machine labels are added for the overview. Browser API requests,
backend writes and external requests are blocked. Sending a reply changes only
the in-browser demo. The actual isolated server state is checked before capture.
For the film only, the bundle drops the demo terminal's "demo — nothing runs"
footer and records the last drawn screen, so capture waits for the conversation
to reach the terminal. The terminal uses the app's HTML renderer: headless WebGL
draws its cells at twice their size.

Each segment can name a `screen`, switching at its beginning; cursor actions
still switch at the measured click. The phone comparison embeds a real 390×664
CSS viewport capture (iPhone 13 Playwright viewport) beside the desktop capture.
It remains a 16:9 film. Review `phone-native.png` as well as the final composition.

The film is written to `wherdr-in-one-minute.mp4` (`output` in the storyboard). Preserve the source
WAVs, alignment, capture manifest and timeline alongside each review version.
Share a private review link, then wait for explicit approval in the same task.
