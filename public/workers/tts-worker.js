// On-device read-aloud worker: the sherpa-onnx WASM runtime (the dictation
// one, plus its TTS binding sherpa-onnx-tts.js) and one Piper voice from
// app/utils/speech/voices.json, on the CPU, one sentence at a time.
//
//   in : {t:'load', runtime, base, model, files[], bytes[], chunk, cache}
//          runtime: URL of the sherpa-onnx files, ending in '/'
//          base:    URL of the voice's folder, files[] (the catalog's
//                   members) relative to it; model: its .onnx file
//          cache:   Cache Storage name holding the files in `chunk`-byte slices
//                   (app/utils/dictation/modelStore.ts), '' = stream them from the server
//   in : {t:'speak', id, text, speed?}      speed: 1 = the voice's own pace
//   in : {t:'dispose'}                      frees the voice and closes the worker
//   out: {t:'phase', phase}                 'runtime' | 'fetch' | 'create'
//   out: {t:'dl', file, got, total}         bytes of the file being downloaded
//   out: {t:'ready', ms, heap, sampleRate}  heap: bytes of the WASM memory
//   out: {t:'audio', id, pcm, sampleRate, ms, heap}
//          pcm: Float32 mono samples (its ArrayBuffer is transferred)
//   out: {t:'error', id, error}             id is absent for a load error

'use strict'

// The emscripten loader reads and writes `window`.
self.window = self

const VOICE_DIR = '/voice'

let tts = null

// Emscripten instantiates the .wasm asynchronously: importScripts returns
// before it is done. Wait on its callbacks rather than probing the heap.
let engineReady = null
function startRuntime(runtime) {
  if (engineReady) return engineReady
  engineReady = new Promise((resolve, reject) => {
    self.Module = {
      locateFile: f => runtime + f,
      onRuntimeInitialized: resolve,
      onAbort: what => reject(new Error(`speech engine aborted: ${what}`)),
      print: () => {},
      printErr: m => console.warn('[wasm]', m),
      noInitialRun: true,
    }
  })
  importScripts(`${runtime}sherpa-onnx-wasm-combined.js`, `${runtime}sherpa-onnx-tts.js`)
  return engineReady
}

// Voice files come through the shared loader (public/workers/model-files.js).
importScripts('/workers/model-files.js')
const { openFile, fsWriteStreamed } = self.wherdrModelFiles

const sleep = ms => new Promise(r => setTimeout(r, ms))

// The parent folders of a file (espeak-ng-data/lang/roa/fr) in the FS.
function mkdirs(path) {
  const parts = path.split('/').slice(1, -1)
  for (let i = 1; i <= parts.length; i++) {
    try { Module.FS.mkdir(`/${parts.slice(0, i).join('/')}`) }
    catch { /* already there */ }
  }
}

async function load(msg) {
  postMessage({ t: 'phase', phase: 'runtime' })
  await Promise.race([
    startRuntime(msg.runtime),
    sleep(60_000).then(() => { throw new Error('speech engine load timed out') }),
  ])
  if (typeof OfflineTts !== 'function' || !Module.FS) throw new Error('speech engine failed to initialize')

  postMessage({ t: 'phase', phase: 'fetch' })
  for (const [i, file] of msg.files.entries()) {
    const path = `${VOICE_DIR}/${file}`
    mkdirs(path)
    await fsWriteStreamed(Module.FS, path, await openFile(`${msg.base}/${file}`, file, msg.bytes[i], msg))
  }

  postMessage({ t: 'phase', phase: 'create' })
  if (tts) tts.free()
  // Field names are the binding's (sherpa-onnx-tts.js): a wrong one is silently ignored.
  tts = new OfflineTts({
    offlineTtsModelConfig: {
      offlineTtsVitsModelConfig: {
        model: `${VOICE_DIR}/${msg.model}`,
        tokens: `${VOICE_DIR}/tokens.txt`,
        dataDir: `${VOICE_DIR}/espeak-ng-data`,
        noiseScale: 0.667,
        noiseScaleW: 0.8,
        lengthScale: 1,
      },
      numThreads: 1,
      debug: 0,
      provider: 'cpu',
    },
    maxNumSentences: 1,
  }, Module)
  if (!tts.handle) throw new Error('the voice failed to load')
  // The weights are now in the engine: the FS copy only costs memory. The
  // espeak-ng data (~1 MB) stays, the phonemizer reads it while speaking.
  try { Module.FS.unlink(`${VOICE_DIR}/${msg.model}`) }
  catch { /* gone */ }
}

const heap = () => (self.Module && Module.HEAPU8 ? Module.HEAPU8.length : 0)

self.onmessage = async (e) => {
  const m = e.data
  const t0 = performance.now()
  try {
    if (m.t === 'load') {
      await load(m)
      postMessage({ t: 'ready', ms: Math.round(performance.now() - t0), heap: heap(), sampleRate: tts.sampleRate })
    }
    else if (m.t === 'speak') {
      if (!tts) throw new Error('no voice loaded')
      const { samples, sampleRate } = tts.generate({ text: m.text, sid: 0, speed: m.speed || 1 })
      postMessage({ t: 'audio', id: m.id, pcm: samples.buffer, sampleRate, ms: Math.round(performance.now() - t0), heap: heap() }, [samples.buffer])
    }
    else if (m.t === 'dispose') {
      // A WASM heap never shrinks: only closing the worker gives it back.
      if (tts) tts.free()
      tts = null
      self.close()
    }
  }
  catch (err) {
    postMessage({ t: 'error', id: m.id, error: String((err && err.message) || err) })
  }
}
