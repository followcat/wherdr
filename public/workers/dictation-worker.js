// On-device dictation worker: the sherpa-onnx WASM runtime and one offline
// model, on the CPU, one take at a time. Driven by app/utils/dictation/device.ts.
// Ported from followcat's public/workers/asr-worker.js (followcat/wherdr,
// branch mobile, MIT); the WebGPU (onnxruntime-web) path is left for later.
//
//   in : {t:'load', runtime, base, kind, files[], bytes[], chunk, cache}
//          runtime: URL of the sherpa-onnx files, ending in '/'
//          base:    URL of the model's folder, files[] relative to it
//          cache:   Cache Storage name holding the files in `chunk`-byte slices
//                   (app/utils/dictation/modelStore.ts), '' = stream them from the server
//   in : {t:'decode', id, pcm}              pcm: Float32 ArrayBuffer, 16 kHz mono
//   out: {t:'phase', phase}                 'runtime' | 'fetch' | 'create'
//   out: {t:'dl', file, got, total}         bytes of the file being downloaded
//   out: {t:'ready', ms, heap}              heap: bytes of the WASM memory
//   out: {t:'final', id, text, ms, heap}
//   out: {t:'error', id, error}             id is absent for a load error

'use strict'

// The emscripten loader and the ASR bindings read and write `window`.
self.window = self

const MODEL_DIR = '/model'
const SAMPLE_RATE = 16000

let recognizer = null

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
  importScripts(`${runtime}sherpa-onnx-wasm-combined.js`, `${runtime}sherpa-onnx-core.js`, `${runtime}sherpa-onnx-asr.js`)
  return engineReady
}

// Model files come through the shared loader (public/workers/
// model-files.js): the cached `?chunk=N` slices or a whole entry, else
// resumable 8 MB Range slices from the server, { t:'dl' } progress posted
// as the bytes arrive.
importScripts('/workers/model-files.js')
const { openFile } = self.wherdrModelFiles

const sleep = ms => new Promise(r => setTimeout(r, ms))

// A file into the emscripten FS slice by slice: the weights must live in the
// WASM heap anyway, but no second whole copy is held in JS (a whole-file
// writeFile got a phone tab killed, in followcat's tests).
async function fsWriteStreamed(path, res) {
  const fd = Module.FS.open(path, 'w')
  const reader = res.body.getReader()
  let off = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      Module.FS.write(fd, value, 0, value.length, off)
      off += value.length
    }
  }
  finally { Module.FS.close(fd) }
}

// The model part of the recognizer config, per model family. Field names are
// the JS binding's (useItn, not useInverseTextNormalization: a wrong name is
// silently ignored).
function modelConfig(kind) {
  const M = MODEL_DIR
  switch (kind) {
    // SenseVoice: zh, en, ja, ko, yue, detected; punctuation through ITN.
    case 'senseVoice': return { senseVoice: { model: `${M}/model.int8.onnx`, language: '', useItn: 1 } }
    // NeMo transducers (Parakeet TDT v3: 25 European languages, detected).
    case 'nemoTransducer': return {
      transducer: { encoder: `${M}/encoder.int8.onnx`, decoder: `${M}/decoder.int8.onnx`, joiner: `${M}/joiner.int8.onnx` },
      modelType: 'nemo_transducer',
    }
    default: throw new Error(`unknown model kind: ${kind}`)
  }
}

async function load(msg) {
  postMessage({ t: 'phase', phase: 'runtime' })
  await Promise.race([
    startRuntime(msg.runtime),
    sleep(60_000).then(() => { throw new Error('speech engine load timed out') }),
  ])
  if (typeof OfflineRecognizer !== 'function' || !Module.FS) throw new Error('speech engine failed to initialize')

  postMessage({ t: 'phase', phase: 'fetch' })
  try { Module.FS.mkdir(MODEL_DIR) }
  catch { /* already there */ }
  for (const [i, file] of msg.files.entries()) {
    await fsWriteStreamed(`${MODEL_DIR}/${file}`, await openFile(`${msg.base}/${file}`, file, msg.bytes[i], msg))
  }

  postMessage({ t: 'phase', phase: 'create' })
  if (recognizer) recognizer.free()
  recognizer = new OfflineRecognizer({
    modelConfig: { ...modelConfig(msg.kind), tokens: `${MODEL_DIR}/tokens.txt`, numThreads: 1, provider: 'cpu', debug: 0 },
  }, Module)
  // The weights are now in the recognizer: the FS copies only cost memory.
  for (const file of msg.files) {
    try { Module.FS.unlink(`${MODEL_DIR}/${file}`) }
    catch { /* gone */ }
  }
}

function decode(pcm) {
  const stream = recognizer.createStream()
  try {
    stream.acceptWaveform(SAMPLE_RATE, pcm)
    recognizer.decode(stream)
    // SenseVoice writes its language and emotion tags as <|…|>.
    return (recognizer.getResult(stream).text || '').replace(/<\|[^|]*\|>/g, '').trim()
  }
  finally { stream.free() }
}

const heap = () => (self.Module && Module.HEAPU8 ? Module.HEAPU8.length : 0)

self.onmessage = async (e) => {
  const m = e.data
  const t0 = performance.now()
  try {
    if (m.t === 'load') {
      await load(m)
      postMessage({ t: 'ready', ms: Math.round(performance.now() - t0), heap: heap() })
    }
    else if (m.t === 'decode') {
      if (!recognizer) throw new Error('no model loaded')
      const text = decode(new Float32Array(m.pcm))
      postMessage({ t: 'final', id: m.id, text, ms: Math.round(performance.now() - t0), heap: heap() })
    }
  }
  catch (err) {
    postMessage({ t: 'error', id: m.id, error: String((err && err.message) || err) })
  }
}
