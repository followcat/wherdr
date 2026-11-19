# Read aloud: the voice of wherdr

[Documentation](README.md) · [Project](../README.md)

**Voice of wherdr (on this device)** reads replies with a neural voice that runs on the phone:
the text never leaves the device. It is chosen in **Settings › Conversation › Read aloud**, next
to Off and the device's own voices. How the engine works (worker, streaming, memory marks) is in
[Dictation design › Read aloud](dictation.md#read-aloud).

## Voices

| Voice | Language | Download | Licence | Attribution shown |
| --- | --- | --- | --- | --- |
| Siwis (`fr_FR-siwis-medium`) | French, default | 64 MB | CC BY 4.0 ([SIWIS database](https://doi.org/10.7488/ds/1705)) | Yes, required: the SIWIS French Speech Synthesis Database by Pierre-Edouard Honnet, Philip Garner and Alexandros Lazaridis (University of Edinburgh, CSTR) |
| Cori (`en_GB-cori-medium`) | English (UK), default | 64 MB | Public domain (LibriVox recordings, [voice page](https://brycebeattie.com/files/tts/)) | Yes, as a courtesy: Bryce Beattie |
| MLS (`fr_FR-mls-medium`) | French, fallback, not offered in Settings | 78 MB | CC BY 4.0 ([MLS](https://openslr.org/94/)) | In the catalog: Vineel Pratap et al. (Meta AI) |
| Canto (`canto-tts-nano-int8`) | Cantonese (`zh-HK`), default | 247 MB (233 MiB weights + 3.5 MiB G2P and OpenCC) | Apache-2.0 (model, codec, G2P code, OpenCC); rime-cantonese CC BY 4.0 (G2P data) | Yes, required: canto-tts-nano by typangaa (Apache-2.0), fine-tuned from MOSS-TTS-Nano by OpenMOSS (Apache-2.0); int8 conversion by dandelionchase (Apache-2.0, see its NOTICE); G2P canto-hk-g2p (Apache-2.0) with rime-cantonese (CC BY 4.0, CanCLID) and Unihan (Unicode License v3); OpenCC (Apache-2.0). Training data: privately sourced and not released, for copyright reasons. |
| Canto GPU (`canto-nano-fp16-gpu`) | Cantonese (`zh-HK`), experimental, not default | 363 MB (360 MB fp16 weights + 3.5 MB G2P and OpenCC) | Apache-2.0; fp16 conversion by @followcat (Apache-2.0) | Yes, required: as Canto, and the fp16 conversion by @followcat. Training data: privately sourced and not released, for copyright reasons. |

Each row of the setting shows its attribution, read from `app/utils/speech/voices.json`. The
French and English voices are Piper models packaged by sherpa-onnx; the Cantonese voice is the
int8 canto-tts-nano bundle, its G2P data and the OpenCC tables. A voice is fetched by the wherdr
server (sets `tts-siwis-medium`, `tts-cori-medium`, `tts-mls-medium`, `tts-canto-nano-int8`, see
[On-device dictation files](installation.md#on-device-dictation-files)) and installed on the
device from there.
The Piper voices come as `.tar.bz2` archives: a server without the `bzip2` program unpacks them
with a built-in JS decoder (slower, nothing to install), so bzip2 is never a requirement.

## Cantonese voice

No browser prototype was reviewed; the design follows the INT8 model card and canto-tts 0.1.4.

The voice is `dandelionchase/canto-tts-nano-int8` at revision
`01f53d9e3371dda0c0b31f999ef6b5cda89d90ae`, a dynamic int8 conversion of `typangaa/canto-tts-nano`
(fine-tuned from OpenMOSS's MOSS-TTS-Nano). It reads Chinese replies in Cantonese when it is
installed; the reply's language is guessed from its characters, and Japanese (any kana) is never
sent to it. Text is normalised with **OpenCC `s2t` phrases and characters** (simplified is the
common input), converted to Jyutping with **canto-hk-g2p 2.6.1 built for WASM**, split into the
model's onset/rime/tone tokens and run through onnxruntime-web 1.23.2 (the existing `ort` set,
CPU/WASM, one thread, no `SharedArrayBuffer`, no cross-origin isolation, no WebGPU). The model's
own SentencePiece BPE is reproduced in JS and checked against the Python reference.

A sentence is split at the G2P's word boundaries into short parts (about 24 characters for the
first, 48 for the rest) so the codec's full decode stays bounded; a part that still reaches the
48-frame cap is split once more at a word boundary, never inside a word. A long reply is
synthesised one sentence at a time, at most one sentence ahead, and each sentence's KV cache,
frames and audio are dropped after it plays.

**Canto GPU (experimental).** `canto-nano-fp16-gpu` is the float16 conversion of the same model
(`@followcat/canto-tts-nano-fp16` at `e89ed00`), for GPUs. It runs only when `navigator.gpu` gives
an adapter with `shader-f16`; otherwise its settings row says **Needs WebGPU with shader-f16: not
available on this device** and offers nothing, and it never falls back to WASM. It shares the
G2P and OpenCC files with the INT8 voice. Choose it with **Use**; the INT8 voice stays the
default. The settings row of each Canto voice shows the last reply's execution provider, phase
(CPU-side I/O or GPU KV), load time, first-audio time and real-time factor, so the two can be
compared: install both, Use one, play a reply or Test, read the row, then Use the other.

On this desktop (Chromium 153, Intel Iris Xe through Vulkan, 2026-11-19) the GPU voice was
**slower** than the INT8: RTF 5.7–6.4 with CPU-side I/O and 4.5–6.2 with the per-frame KV kept on
the GPU, against 1.4–1.9 for the INT8. Its WASM heap was 33–58 MiB because the fp16 weights stay
on the GPU; the GPU memory itself is not measured. The phone is the test that matters, and it is
not measured. The three example sentences and both phases were written as WAVs for the check
(short, medium and English code-switching); listen before choosing.

Measured on a desktop (Chromium 141, Playwright chromium-1243, Linux, 2026-11-19), **not on a
phone**:

| What | Canto |
| --- | --- |
| Load (runtime, files and model) | 11.4 s with 1.23.2; 8.6 s with 1.31.1 (both from a local server) |
| Real-time factor | 2.18 (1.23.2 worker; 1.31.1 was 1.37 in the same test) |
| Worker WASM heap, sample | 496 MiB (1.23.2); 515 MiB (1.31.1) |
| Catalog `memory` | 624 MiB (WASM + OpenCC maps + PCM + 10%); desktop basis, not a phone |
| Canto GPU download | 363 MB |
| Canto GPU load | 10.4–10.6 s (desktop) |
| Canto GPU first audio (example) | 10.2–18.9 s (desktop) |
| Canto GPU real-time factor | 5.7–6.4 CPU I/O, 4.5–6.2 GPU KV (desktop; INT8 1.4–1.9) |
| Canto GPU heap | 33–58 MiB WASM (the weights are on the GPU); catalog 64 MiB |

Synthesis is slower than playback on this desktop, so replies may pause between parts on a
phone. The voice never lowers the model or its quality to go faster. The memory is compared to
the same 640 MiB iOS budget as the Piper voices; a device that cannot hold it shows **Too large
for this device** and uses its own voices, and a page killed while loading it is marked too
large. The 1.31.1 figures are in the report: its 54-frame sentence was about 3% faster and its
load about 30% faster; the review's bar was 15% for the sentence, so the existing 1.23.2 set
stays.

The model, codec and int8 conversion are Apache-2.0; the G2P code is Apache-2.0, its rime-cantonese
data is CC BY 4.0 (attribution above), Unihan is under the Unicode License v3, and OpenCC is
Apache-2.0. **Training data:** the model card says it was privately sourced and is not released,
for copyright reasons. The Apache-2.0 licence is not a statement that the training data is free
of rights issues.

## Licences of the engine

| Part | Licence | Where |
| --- | --- | --- |
| sherpa-onnx (WASM runtime and `sherpa-onnx-tts.js`) | Apache 2.0 | runtime set, shared with dictation |
| ONNX Runtime (inside the WASM) | MIT | same |
| espeak-ng (phonemizer, inside the WASM) and its `espeak-ng-data` | GPL 3.0 or later | same, and each voice's `espeak-ng-data/` |
| Piper voice models | per voice, above | the voice sets |
| canto-hk-g2p 2.6.1 (WASM) | Apache-2.0; data rime-cantonese CC BY 4.0, Unihan Unicode License v3 | the G2P wasm (committed) and the voice's G2P data |
| OpenCC `s2t` tables (ver.1.2.0) | Apache-2.0 | the Canto voice set |
| onnxruntime-web 1.23.2 (Canto worker) | MIT | the existing `ort` set |

### espeak-ng

Piper voices are fed phonemes, not letters: sherpa-onnx turns the text into phonemes with
espeak-ng, compiled into its WASM build, and reads the language rules from `espeak-ng-data/`
(trimmed to French and English, about 0.9 MB, part of each voice). espeak-ng is GPL 3.0 or
later. wherdr does not bundle these files: the server downloads them unchanged from their
pinned upstream sources (a sherpa-onnx WASM build matching releases 1.12.34 to 1.12.40, each file checked by sha256) and serves them to the
device. Their source is [espeak-ng](https://github.com/espeak-ng/espeak-ng) and
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). The choice for now is to keep this pinned
1.12.x runtime with espeak-ng; a runtime without a GPL phonemizer would need a different
phonemizer and new voices.

## Measurements

The catalog keeps what a voice was measured to take on a phone, as dictation models do:

| Field | Meaning |
| --- | --- |
| `memory` | `{ heap, speaking, basis }`: WASM heap after load and while speaking, in bytes, and how it was measured |
| `speed` | `{ rtf, basis }`: real-time factor, time to generate speech divided by its length (below 1 is faster than speech) |

**Memory budget.** A voice is used only when it fits: `heapNeeded()` (`neuralVoice.ts`) takes
the larger of the measured `memory.heap` and `memory.speaking`, and, until a voice is measured,
an estimate of three times its files (about 230 MB for MLS). It is checked against
the device budget of dictation, `memoryBudget()`: 640 MiB of heap on iOS and iPadOS, a quarter
of `navigator.deviceMemory` elsewhere. A voice over it shows **Too large for this device** and
its replies use the device's voices. The worker also reports its real heap once loaded, and a
voice that goes over the budget then is stopped and marked too large.

**Measured on an iPhone 13** (iOS Safari, home-screen app, **Test** in Settings › Conversation ›
Read aloud, 2026-11-10, cold start; both voices were already installed, so no download time):

| What | Siwis (French) | Cori (English) | Canto |
| --- | --- | --- | --- |
| Download | 64 MB | 64 MB | 247 MB (not measured on a phone) |
| Load (runtime, files, model) | 1.6 s | 2.1 s | not measured (desktop 11.4 s; 8.6 s with 1.31.1) |
| First sentence (tap to first audio) | 2.1 s | 2.7 s | not measured |
| Real-time factor | 0.16 | 0.17 | not measured (desktop 2.18; 1.31.1 1.37) |
| Heap | 537 MB | 537 MB | not measured (desktop 496 MiB; catalog 624 MiB) |

The Canto figures in that row are **desktop Chromium**, never a phone; its section above has
the full table. A phone measurement is still to do.

**What Heap means.** Test's Heap is the size of the worker's WASM memory, not what the voice
itself uses: Siwis and Cori show the same 537 MB (512 MiB), the memory the sherpa-onnx runtime
reserves, which the voice fits inside. The Canto voice's Heap is the onnxruntime-web WASM memory
plus the JS side counted for its catalog figure (624 MiB, desktop); its worker check stops a
device that goes over the budget. The catalog keeps `memory.heap`, so the budget check is
cautious: 512 MiB and 624 MiB fit the 640 MiB budget of iOS; elsewhere the Canto voice needs a
device that reports at least 4 GB. The page's memory while speaking and after release is not
measured yet (step 3 below). MLS has no phone figures yet and keeps the estimate.

### How to measure

1. On the phone, open **Settings › Conversation › Read aloud**, choose **Voice of wherdr**, and
   install the voice. The row then shows the download time. The Canto row shows its 247 MB
   before the download.
2. Tap **Test** right after a reload (cold start). When it ends, the row shows **Load** (the
   worker: runtime, files and model), **First sentence** (tap to the first audio), **Real-time
   factor** and **Heap** (the largest WASM heap seen). A second Test gives the warm figures. For
   the two Canto voices the row also shows the execution provider and phase; Use one, play a
   reply (not only Test), and read its row, then Use the other. On a phone without WebGPU with
   shader-f16 the GPU row says so and is not usable.
3. For the page's memory while speaking and after release (the worker is closed 60 s after the
   last speech), use Safari's Web Inspector (Timelines › Memory) with the phone plugged into a
   Mac.
4. Record the figures in the voice's `memory` and `speed` in `voices.json`, with a `basis` that
   names the device and the date, and update the table above. The Canto voice's current `basis`
   says Chromium on a desktop: replace it with the phone's figure when it is measured, and keep
   the 640 MiB budget unchanged. If a phone cannot hold it, it shows **Too large for this
   device** and uses the device's voices.
