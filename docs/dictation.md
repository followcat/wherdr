# Dictation: design note for contributors

How dictation is built in wherdr v3, for anyone adding an engine or a speech model. User-facing
setup lives elsewhere: [On-device dictation files](installation.md#on-device-dictation-files),
`OPENROUTER_API_KEY` in [Configuration](configuration.md) and
[Security › Dictation](security.md#dictation).

Dictation is part of wherdr itself, not a plugin. Much of it is ported from followcat's work on
the `mobile` branch of [followcat/wherdr](https://github.com/followcat/wherdr) (capture, resampler,
pane terms, model route, fetch script), with credit in the code.

## Status

| Part | State on v3 |
| --- | --- |
| Engine interface, capture, contract tests | Merged |
| Composer mic and **Settings › Conversation › Dictation** | Merged |
| Online engine (OpenRouter, through the wherdr server) | Merged |
| `/models/**` route, fetch script with sha256, CSP, service worker | Merged |
| On-device engine (sherpa-onnx WASM worker, CPU) | Merged: Parakeet v3 (French + English, default), Canary 180M (default on iPhone) and SenseVoice |
| Model list in Settings (install, delete, progress, ratings) | Merged |
| WebGPU models (Qwen3-ASR q4f16) | **Open for an outside contributor** (see [Task split](#task-split)) |

## Overview

```
mic ──▶ useDictation (capture, 16 kHz mono take) ──▶ DictationEngine.transcribe(take) ──▶ text
            ▲                                              │
  composer mic (hold / tap)                    cloud:  WAV ─▶ /api/dictation/transcribe ─▶ OpenRouter
  useComposerDictation                         device: worker ─▶ /models/** (once) ─▶ Cache Storage
```

Every engine works **per take**: the user records, releases, and the whole text comes back at
once. No engine streams partial results today. Capture, the live wave, the clock and draft
insertion are shared; only the engine behind the interface changes.

| File | Role |
| --- | --- |
| `app/utils/dictation/engine.ts` | The `DictationEngine` interface, `Take`, `Readiness`, `abortError()` |
| `app/utils/dictation/registry.ts` | `ENGINES`: lazy engine loaders; one instance per engine for the app |
| `app/composables/useDictation.ts` | Capture: mic, resampling, one take at a time, cancel, timeouts |
| `app/composables/useComposerDictation.ts` | The composer's mic button, errors as toasts, insertion |
| `app/utils/dictation/audio.ts` | Streaming resampler to 16 kHz, RMS levels, PCM concat |
| `app/utils/dictation/compose.ts` | Per-device engine choice, insertion at the caret, wave and clock text |
| `app/utils/dictation/terms.ts` | `dictationTerms()`: pane words that bias recognition |
| `app/utils/dictation/cloud.ts`, `cloudOptions.ts`, `wav.ts` | The online engine and its options |
| `app/components/DictationCloudSettings.vue` | Settings › Dictation › Online (key, model, ZDR, terms, Test) |
| `app/utils/dictation/models.json`, `deviceModels.ts` | The on-device model catalog and its ratings |
| `app/utils/dictation/modelStore.ts` | Model files in Cache Storage: resumable install, delete, space used |
| `app/components/DictationDeviceSettings.vue` | Settings › Dictation › On this device (model list) |
| `server/utils/dictation.ts`, `server/api/dictation/*` | Key storage and the OpenRouter relay |
| `shared/dictationRewrite.ts`, `app/utils/dictation/rewrite.ts` | The optional rewrite: prompt, dictionary, the call with its raw-text fallback |
| `app/components/DictationRewriteSettings.vue` | Settings › Dictation › Rewrite (switch, model, prompt, dictionary) |
| `server/utils/modelFiles.ts`, `server/routes/models/[...path].ts` | Serving `DATA_DIR/models/**` |
| `scripts/dictation-files.mjs`, `scripts/fetch-dictation-files.mjs` | Pinned downloads into `DATA_DIR/models`, checked by sha256 (the code, and its CLI) |
| `server/utils/dictationServerFiles.ts`, `server/api/dictation/prepare.post.ts` | The server fetching a model's missing files when Install asks |
| `public/workers/dictation-worker.js` | The sherpa-onnx worker: WASM runtime, recognizer, decode |
| `public/workers/model-files.js` | Model-file access shared by the dictation workers (cached slices, Range-slice streaming) |

## The engine interface

`app/utils/dictation/engine.ts`:

```ts
export type DictationEngineId = 'device' | 'cloud'

export interface Take {
  pcm: Float32Array // 16 kHz mono, the whole take
  seconds: number
}

export interface TranscribeOptions {
  language?: string // ISO 639-1; absent = automatic detection
  terms: string[] // pane terms (dictationTerms), possibly empty
  signal: AbortSignal // the take was cancelled or its composer unmounted
  onPartial?: (text: string) => void // for a future streaming engine
}

export interface DictationEngine {
  id: DictationEngineId
  caps: { terms: boolean, languages: string[] | 'many', offline: boolean }
  readiness(): Promise<Readiness> // never rejects
  prepare(onProgress?: (p: PrepareProgress) => void): Promise<void>
  transcribe(take: Take, opts: TranscribeOptions): Promise<{ text: string, ms: number }>
  dispose(): void // safe to call twice
}
```

Rules an engine follows:

- **`readiness()` never rejects.** It answers `{ ready: false, reason }` with one of
  `not-installed`, `no-key`, `unsupported` (no WebGPU, no `shader-f16`…) or `offline`. The
  composer turns each reason into a toast with a link to Settings.
- **`prepare()` loads what is heavy** (worker, model) and reports progress
  (`{ phase, got, total }`); the composer shows it as a percentage. The cloud engine's is a no-op.
  It runs while the mic already records, so the user can talk during a model load.
- **`transcribe()` rejects with an `AbortError` (`abortError()`) as soon as `opts.signal`
  aborts**, and at once when it is already aborted. Cancel (×), a composer unmount and the 90 s
  decode timeout all abort it. An engine that cannot stop its work early must still reject at
  once and drop the late result.
- **`dispose()` frees the worker and memory** and can be called more than once. Settings calls
  it (`disposeEngines()`) when the engine or model changes.
- `caps.terms` says whether the engine can use pane terms; `caps.offline` whether it works
  without a network.

### Contract tests

`tests/dictationEngineContract.ts` is a shared suite every engine passes. An engine's own test
file calls it with a factory:

```ts
import { runDictationEngineContract } from './dictationEngineContract'
runDictationEngineContract('cloud', () => createCloudEngine())
```

It checks: the engine describes itself; `readiness()` resolves with `fetch` failing (no
network); `transcribe()` rejects with an `AbortError` when cancelled mid-way and when the signal
is already aborted; `dispose()` twice does not throw. `tests/fakeDictationEngine.ts` is a fake
engine (configurable text, delay, readiness, held `prepare()`) used by the capture and composer
tests; `tests/dictationEngine.test.ts` runs the contract on it.

## Capture pipeline

`app/composables/useDictation.ts`, shared by every engine:

1. **Press.** The `AudioContext` is created **before any `await`**: iOS only starts it inside
   the press's user activation. Engine loading (`loadEngine` → `readiness` → `prepare`) starts in
   parallel.
2. **Mic.** `getUserMedia` with `echoCancellation`, `noiseSuppression` and `autoGainControl`
   **off**: they gate quiet speech on Android badly enough to break recognition.
3. **Resampling.** The context runs at the device's native rate (Firefox refuses to connect a
   mic source to a context of another rate). `createResampler()` converts each buffer to 16 kHz
   mono, carrying its position across buffers so no sample is lost or doubled at the joins.
4. **Recording.** A `ScriptProcessorNode` (4096 samples) appends PCM chunks and pushes two RMS
   bars per buffer for the composer's wave. It is routed through a zero-gain node so the mic is
   never played back. A take stops on its own after **120 s** (`MAX_TAKE_MS`).
5. **Stop.** The mic is released, chunks are joined into one `Float32Array`, and the engine's
   `transcribe()` runs with a **90 s** timeout (`TRANSCRIBE_TIMEOUT_MS`).
6. **Text.** Trimmed text that is not empty goes to the composer, which inserts it at the caret
   when the field has the focus, else at the end, with one space on each side as needed
   (`insertDictated()`). Nothing is ever sent by itself.

**One take at a time for the whole app.** Each `useDictation()` call gets its own facade: split
panes mount several composers, the take belongs to the facade that started it, others read
`busy`. A generation counter makes a start that wakes up stale (after cancel or a newer start)
release what it grabbed instead of leaking a stream.

**Pane terms.** `dictationTerms()` collects words a speech model gets wrong: agent, machine,
pane name and title, the last two folders of the cwd, and name-like words of the
draft (inner capitals, digits, `-`, `.`, `/`, `_`), at most 400 characters. Each engine uses them
its own way: `keyterms` for OpenRouter, a prompt for a context-capable local model.

**Composer.** The mic sits before the plugins' buttons (`data-wherdr="composer-actions"`), right
of **+**, in every state: on a touch screen the row at rest is `+ · mic · field · Send`, and the
toolbar under the field while editing keeps it in the same place. A stray tap there is harmless,
unlike Send. It is hidden while dictation is **Off**. Hold it (≥ 0.6 s) and release to stop, or tap to start and tap
again. The take's line above the field shows the wave (`▁▂▃▄▅▆▇█`), the clock (or the load
percentage) and ×.

## Registering an engine

1. Implement `DictationEngine` in `app/utils/dictation/<engine>.ts` with a `create…Engine()`
   factory. Keep heavy code out of the main bundle: the registry imports the module lazily.
2. Add it to `ENGINES` in `app/utils/dictation/registry.ts`:

   ```ts
   export const ENGINES: Partial<Record<DictationEngineId, () => Promise<DictationEngine>>> = {
     cloud: () => import('./cloud').then(m => m.createCloudEngine()),
     device: () => import('./device').then(m => m.createDeviceEngine()),
   }
   ```

   A new engine family also extends `DictationEngineId`. The registry keeps one instance per
   engine for the whole app (a model load costs seconds) and retries a failed load on the next
   press.
3. Settings › Conversation › Dictation lists **Off** plus every engine in `ENGINES`
   (`app/components/SettingsView.vue`); give the new id a label and description there, in English
   and French with `tl()`. The choice is kept **per device** in `localStorage`
   (`dictationEngine`); a saved choice whose engine is gone reads as Off.
4. Run the contract suite on it, plus the engine's own unit tests.

## The online engine (OpenRouter)

- **Browser** (`cloud.ts`): the take is encoded as a 16 kHz 16-bit mono WAV (32 kB/s, 3.8 MB for
  120 s) and posted to `POST /api/dictation/transcribe?model=…&zdr=1&language=…&terms=…`. The
  browser never calls OpenRouter and never sees the key (the CSP's `connect-src 'self'` would
  forbid it anyway).
- **Server** (`server/utils/dictation.ts`): checks the WAV header and the 8 MB cap, encodes it in
  base64 and calls OpenRouter's `POST /api/v1/audio/transcriptions` with `input_audio`,
  `language`, `keyterms` (at most 1000 terms of 100 characters) and
  `provider: { zdr: true, data_collection: 'deny' }` unless ZDR was turned off. Timeout 60 s;
  a closed browser request aborts the upstream call too. Answers `{ text, seconds, cost }`.
- **Key**: `OPENROUTER_API_KEY` wins, else `DATA_DIR/openrouter.json` (mode 0600) written by
  `POST /api/dictation/key` and removed by `DELETE`. `GET /api/dictation/status` returns only
  `{ set, last4 }`. The key is never returned, never logged, and scrubbed from upstream errors.
- **Models**: once a key is saved, `GET /api/dictation/models` has the server fetch OpenRouter's
  `GET /api/v1/models?output_modalities=transcription` with the key and keep the models that take
  audio in, give a transcription out and are served at `/api/v1/audio/transcriptions`
  (`shared/dictationModels.ts`). It answers `{ models: [{ id, name, perMinute? }], live }`: the
  price per minute only for models billed by duration (`pricing.prompt` per second, no output
  price). Others (MAI quotes per hour, GPT-4o and Gemini transcribers bill tokens) show
  **Price: see OpenRouter**, a link to `https://openrouter.ai/<model id>`: the unit is never guessed. The list is kept 6 hours, served stale while OpenRouter fails (retried after a minute);
  without a key or any good fetch, a built-in list of three. Settings searches it locally by name
  or id (`USelectMenu`).
- **Options** (per device, `cloudOptions.ts`): model (Whisper large v3 turbo by default), ZDR (on
  by default), send pane terms (off by default).

## Rewrite

An optional pass after the transcript, for both engines (**Settings › Conversation › Dictation ›
Rewrite**, per device, off by default). The take's text goes to `POST /api/dictation/rewrite`;
the server sends it with its key to OpenRouter's `POST /api/v1/chat/completions` (ZDR as for
transcription, 30 s timeout, 2 at once and 10 per client per minute).

- **Messages** (`rewriteMessages()`): the prompt (editable; the default removes filler words and
  false starts, fixes punctuation, keeps the meaning and language, never answers or adds) plus the
  **personal dictionary** as the system message, the text between `<transcript>` tags as the user
  one. The dictionary is also sent as `keyterms` to the online engine, with or without the
  rewrite. A model that refuses keyterms (Whisper does; the model list does not say which) gets
  the take again without them. Quotes wrapped around the whole answer are dropped.
- **Model**: `GET /api/dictation/text-models` lists OpenRouter's text models, cached like the
  transcription list, priced per million tokens, with a default computed from the live list: the
  cheapest model that bills both input and output, never `:free` or `:batch`. An empty choice
  follows that default.
- **Composer**: the take's line says **Rewriting…** meanwhile; × drops the take. When the rewrite
  fails or times out, the raw transcript goes into the field and a toast says so.

## On-device models

### Where files are stored and served

- **Server side**: `DATA_DIR/models/`, filled by the server itself on Install (below) or by
  `scripts/fetch-dictation-files.mjs`. Runtimes go
  under `runtime/<name>-<version>/` (sherpa-onnx WASM, onnxruntime-web); each model gets its own
  folder. These files are never in the repository, the npm package or the service worker
  precache. The folder survives updates.
- **Route**: `GET|HEAD /models/**` (`server/utils/modelFiles.ts`) serves them with single `Range`
  requests (206 / 416), exact MIME types (`application/wasm`, `text/javascript`) and
  `cache-control: private, max-age=31536000, immutable`. It refuses paths outside the folder
  (`..`, absolute paths, symlinks leading out). It sits behind the same lock as the rest of
  wherdr. **Immutable means a new version needs a new folder name**, never a file replaced in
  place.
- **Browser side**: `modelStore.ts` downloads each file once in 8 MB `Range` slices into Cache
  Storage (`wherdr-asr-v1`), one entry per slice (`file?chunk=N`): an interrupted download resumes
  at the first missing slice, and no file is assembled in memory. Settings' Install and the first
  mic press share the same download; the worker then reads the slices. Installing asks for
  persistent storage (`navigator.storage.persist()`); a browser without Cache Storage (plain HTTP)
  or with a full quota has the worker stream the model from the server on each load. Caches are
  named `wherdr-asr-*`. The service worker
  (`app/service-worker/sw.ts`) leaves `/models/` alone and keeps `wherdr-asr-*` caches across app
  updates (it deletes every other old cache).

### The server fetches what it lacks

Before downloading a model the phone does not hold whole, `modelStore.ts` posts
`{ model }` to `POST /api/dictation/prepare` (`server/utils/dictationServerFiles.ts`). The server
checks the runtime set's files and the model's files at their catalog sizes (no hash of 600 MB on
every Install) and answers `ready`, or starts fetching what is missing and answers
`preparing` with `got`, `total` and `phase` (`fetch`, then `unpack` for the archive). The browser
posts again every second, Settings shows *Preparing on the server… 40 %*, and the phone download
starts once the answer is `ready`. It runs the fetch script's own code (`scripts/dictation-files.mjs`:
same pinned URLs, sha256 checks, `.part` resume), one fetch at a time for the whole server; a
second request for the same model joins the running one. A failed fetch (`error`, shown in the
row) is told once; the next Install tries again and resumes. Cancel stops the phone's polling, not
the server's fetch. A server without the route (older build) falls back to the 404 message with
the command to run.

### Long takes

Parakeet slows down on long audio (about 1.3 times real time on a 45 s take on a desktop CPU,
and more memory). `splitTake` (`app/utils/dictation/audio.ts`) cuts a take longer than 20 s into
pieces of at most 20 s, each at the quietest tenth of a second of its last 6 s. The device
engine decodes them one after the other and calls `onPartial` with the text so far after each;
`useDictation` counts its 90 s recognition timeout from the last partial result, so a long take
that keeps progressing is never cut, while a stuck engine still is. A cancel stops before the
next piece (the piece being decoded cannot be stopped).

### The fetch script

`scripts/fetch-dictation-files.mjs` downloads named **sets** (`runtime`, `ort`, model sets;
default `runtime parakeet`; `all`). Every entry has a pinned URL and a **sha256**: a download
goes to `file.part`, resumes with `Range` after an interruption, and is moved into place only
when its hash matches. An entry is either a single file (`{ url, sha256, to }`) or a `.tar.bz2`
archive (`{ url, sha256, dir, members }`) from which only the listed members are extracted; a
`.complete` stamp holding the archive's hash marks it done. `tests/fetchDictationFiles.test.ts`
covers resume, mismatch and the set list; `tests/dictationServerFiles.test.ts` the server's use of
it. The code lives in `scripts/dictation-files.mjs`, which has no CLI, since the server bundles it.

### The model catalog

The on-device models live in one data file, `app/utils/dictation/models.json`, read by the app
(`deviceModels.ts`, Settings list) and by the fetch script (its model sets). A model of a known
family is added there without code; the app needs a rebuild to ship it. An entry carries:

| Field | Meaning |
| --- | --- |
| `id`, `name` | Stable id (saved as the device's choice); short display name |
| `kind` | The family: how the worker builds it (`senseVoice`, `nemoTransducer`, `canary`; later `moonshine`, `whisper`, `qwen3Q4F16`…). An entry of a family this build does not know is skipped, never an error |
| `requires` | `[]`, `['webgpu']` or `['webgpu', 'shader-f16']`: Settings hides the model when the browser lacks it |
| `set`, `source` | The fetch script's set name and its pinned archive (`url`, `sha256`) |
| `dir`, `files` | Folder under `/models/` and its files, each with its exact `bytes` (checked against the server's on download) |
| `languages`, `punctuation` | ISO 639-1 codes; punctuation and capitals |
| `autoDetect` | `false` when the model does not detect the language (Canary): the worker is given the first of the device's languages it speaks, else English |
| `textCase` | `"upper"` when the model writes in capitals (SenseVoice, even with inverse text normalization on): the app puts its text in sentence case |
| `memory` | Measured `{ heap, peak, basis }`: WASM heap after load, and the page's peak memory. `heap` is what the device budget checks |
| `quality` | Raw published WER per language: `{ lang, dataset, wer, source }` |
| `speed` | `{ estimate: 1–5, basis, source }`, absent when there is no source |
| `license` | `{ id, url }` |

**Ratings are computed, never typed by hand.** Quality: the WER for the language, FLEURS first,
else MLS, else Common Voice; ≤ 5 → 5 dots, ≤ 7 → 4, ≤ 10 → 3, ≤ 15 → 2, above → 1, no figure →
"?". The tooltip names the figure, dataset and source. Speed: the catalog's `speed.estimate`, from
native real-time factors on a phone-class CPU (≤ 0.1 → 5, ≤ 0.2 → 4, ≤ 0.4 → 3, ≤ 0.8 → 2,
above → 1), shown as estimated; measuring it on the device is left for later. A language the model
does not speak shows "—"; a missing figure is left out of the file, never set to zero, and shows
"unknown".

### Memory budget

Safari on iOS kills a tab that uses too much memory, with no error the page can catch: the page
goes black and reloads. Measured on 2026-11-05 (worker in headless Chromium and WebKit, Linux):

| Model | WASM heap | Page peak, Chromium | Page peak, WebKit |
| --- | --- | --- | --- |
| Parakeet v3 | 818 MiB | 1.8 GB | killed during the load |
| Canary 180M | 512 MiB | 0.85 GB | 1.35 to 1.5 GB |
| SenseVoice | 512 MiB | 0.96 GB | 1.2 to 1.45 GB |

SenseVoice runs on a real iPhone; Parakeet kills it. `memoryBudget()` (`deviceModels.ts`) gives
iOS and iPadOS a 640 MiB heap budget, and other browsers a quarter of `navigator.deviceMemory`
when they report it. A model over the budget shows **Too large for this device** in Settings, and
is never chosen (`deviceModel()` falls back to the first catalog model that fits, so Canary 180M
on an iPhone).

When the page is killed anyway: a load in progress is noted in `localStorage` and cleared when it
ends or on `pagehide`. Found at the next start, it means the system killed the page: the model is
marked too large on this device, the next mic press says "Dictation stopped: the model is too
large for this device", and the choice falls back to a model that fits. A worker that reports
running out of memory (emscripten `Aborted(OOM)`, a failed grow or allocation) fails the same way,
during the session: the composer then frees the engine, so the next press loads the model that
fits without a reload. Settings tells the two cases apart, and **Try again** (or Delete) clears the
mark, since a page can also be lost for another reason.

### Adding a model

1. **Pick a model the runtime can hold.** The sherpa-onnx WASM build is single-threaded with a
   2 GiB heap: much more than about 1 GB of int8 weights does not load on the CPU. Larger
   LLM-style models (Qwen3-ASR, Whisper turbo q4f16) need onnxruntime-web on WebGPU with
   `shader-f16`.
2. **Add the entry to `models.json`**: `set`, a pinned `source` (a release asset or a Hugging
   Face `resolve/<commit>/…` URL, never a moving branch) with its sha256 (`sha256sum` of the
   downloaded archive), a new `dir` for a new version, and each file's exact `bytes` (from the
   fetched files, not typed). The fetch script picks it up as a set.
3. **Add the figures**: languages, `requires`, and published WER figures with their source.
   Leave a figure out rather than guess it.
4. **New family only**: add its builder to the worker (for sherpa-onnx families such as Canary,
   Whisper or Moonshine this is one `case`; the WASM already ships their configs), and pass the
   language when the model cannot detect it.
5. **Check**: the unit tests (catalog shape, fetch set matches the catalog), then a real take in
   French and English on an Android phone and an iPhone, noting load time, decode time and memory.
   Record the heap and peak in `memory` (see [Memory budget](#memory-budget)).
6. Document the set in [On-device dictation files](installation.md#on-device-dictation-files).

### Content Security Policy

Only the worker's own response (`/workers/dictation-worker.js`, a route rule in
`nuxt.config.ts`) carries `'wasm-unsafe-eval'` in `script-src` (`CSP_DICTATION_WORKER` in
`server/utils/csp.ts`): a worker follows its script's policy, not the page's. It lets the worker
compile its WebAssembly runtime (sherpa-onnx, onnxruntime-web) served from `/models/runtime/`.
The page itself cannot compile WebAssembly, and `eval()` of JavaScript is never allowed:
`'unsafe-eval'` stays out.
Runtimes and workers load from `'self'` only (`worker-src 'self' blob:`, `connect-src 'self'`):
no CDN at run time. A runtime that needs anything more must say why in its pull request.

## Task split

The work is cut into small pull requests (about 400 changed lines each), all plugging into the
interface above.

| | Task | State |
| --- | --- | --- |
| A1 | Engine interface, capture, pane terms, contract tests | Merged |
| A2 | Composer mic and Dictation setting | Merged |
| A3 | Online engine (OpenRouter) | Merged |
| F1 | `/models/**` route, fetch script with sha256, CSP, service worker | Merged |
| F2 | On-device engine: worker, CPU models with French (Parakeet v3) | Merged |
| F3 | Model list in Settings: install, delete, progress, resume, storage used, WebGPU detection, ratings | Merged |
| **F4** | **WebGPU models (Qwen3-ASR q4f16)** | **Open for an outside contributor** |

### F4: WebGPU models

Goal: a model that runs on the GPU in the phone's browser, starting with **Qwen3-ASR 0.6B
q4f16** (about 848 MB; French and English; uses pane terms as context).

- onnxruntime-web 1.23.2 is already fetched by the `ort` set into
  `models/runtime/onnxruntime-web-1.23.2/`; the Qwen3 files go in their own set with pinned URLs
  and sha256.
- A `qwen3Q4F16` family in the worker (onnxruntime-web on WebGPU, its BPE tokenizer), behind the
  same `DictationEngine`: either a family of the device engine or its own engine registered as
  above.
- Catalog entry with `runtime.requires: ['webgpu', 'shader-f16']`; `readiness()` answers
  `unsupported` when `navigator.gpu` or the `shader-f16` feature is missing. No CPU fallback is
  needed, but the failure must be clean.
- Pane terms (`opts.terms`) passed as the model's context prompt; `caps.terms: true`.
- A debug view (decode a WAV file, show timings and the terms used) is welcome in development
  builds only, not as a product page.

Done when: the contract suite passes; unit tests cover the new family's pure logic; a French and
an English take work on at least one Android phone with WebGPU, with load time, decode time and
memory reported in the pull request; a device without WebGPU or `shader-f16` gets the
`unsupported` message, not a crash. iOS Safari results are welcome but not required.

## Read aloud

The other direction: **Play** under each agent reply reads it aloud, chosen in **Settings ›
Conversation › Read aloud** (per device: Off, or the device's voices; on by default where the
browser has `speechSynthesis`).

| File | Role |
| --- | --- |
| `app/utils/speech/plainText.ts` | `speakableText()`: the words of a reply, "Code block." for code; `speechChunks()`: pieces of at most 220 characters (Chrome cuts long utterances) |
| `app/composables/useReadAloud.ts` | Engine and voice choice, the voice list (`voiceschanged`), one reply at a time for the app |
| `app/components/ReadAloudButton.vue`, `ReadAloudSettings.vue` | Play / Stop under a reply; the settings (voice search, Test) |

Every piece is queued in the tap itself: iOS only speaks from a user gesture. iOS may stop
speech when the screen locks or the app goes to the background, without an `end` event; a check
every 1.5 s puts the button back to Play. Leaving the pane stops its reply. Voices marked
"online" (Chrome's Google voices) send the text to their vendor. An OpenRouter engine
(`POST /api/v1/audio/speech`, relayed by the server like dictation) is a planned follow-up.

## Known limits

- No published speed figures exist for speech models in a phone browser; speed ratings stay
  estimates until measured on the device.
- Memory: Safari can kill a tab beyond roughly 1 to 1.5 GB on a 4 GB iPhone. The figures in
  [Memory budget](#memory-budget) were measured on desktop engines; only SenseVoice and Parakeet
  were tried on a real iPhone so far.
- Outside an installed app, Safari may clear site storage (and downloaded models) after 7 days
  without a visit.
- `ScriptProcessorNode` is deprecated but works everywhere; moving to an `AudioWorklet` would add
  a module file under the CSP.
