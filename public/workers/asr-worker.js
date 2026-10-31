// ASR worker: loads the sherpa-onnx WASM engine + a SenseVoice model, then
// turns accumulated Float32 PCM (16 kHz mono) into final text on flush.
// All messages are plain objects; PCM frames travel as transferred
// ArrayBuffers.
//
//   in : {t:'load', wasmBase, modelBase, files, cache}
//   in : {t:'push', pcm:ArrayBuffer}        Float32, 16kHz
//   in : {t:'flush'}                         end of speech: decode the take
//   in : {t:'reset'}                         drop the buffered take
//   out: {t:'phase', phase, detail}          'wasm'|'fetch'|'create'|'decode'
//   out: {t:'dl', file, got, total}
//   out: {t:'ready', loadMs}
//   out: {t:'partial', text}                 '' (kept for the composable)
//   out: {t:'final', text, decodeMs}
//   out: {t:'error', error}
//
// SenseVoice is an offline model: there are no streaming partials. The whole
// take is buffered and decoded once, in one shot, which is also what makes it
// comfortable with code-switched zh/en/yue.

'use strict'

// The emscripten loader and the ASR bindings' browser shim read/write `window`;
// give them the worker global instead.
self.window = self

const WASM_BASE = '/wasm/'
const MODEL_DIR = '/asr-models'
const SAMPLE_RATE = 16000
// Longest take we will buffer — the composer also caps recording at 120 s.
const MAX_SAMPLES = SAMPLE_RATE * 180

let recognizer = null
const pending = []      // Float32Array chunks of the current take
let pendingLen = 0

// Emscripten instantiates the .wasm asynchronously: importScripts returns as
// soon as the loader kicks it off, and the 'load' message is handled while
// compilation is still in flight. Wait on these callbacks instead of probing
// HEAP views at message time — on a phone that probe fires several seconds
// too early and reports a healthy engine as broken.
let _engineResolve = null
let _engineError = null
const engineReady = new Promise((res) => { _engineResolve = res })

self.Module = {
  locateFile: (f) => WASM_BASE + f,
  onRuntimeInitialized() { postMessage({ t: 'phase', phase: 'wasm', detail: 'runtime ready' }); _engineResolve && _engineResolve() },
  onAbort(what) { _engineError = new Error('speech engine aborted: ' + what); _engineResolve && _engineResolve() },
  print: () => {},
  printErr: (m) => console.warn('[wasm]', m),
  noInitialRun: true,
}

async function fetchCached(url, file, cache) {
  if (cache && self.caches) {
    const hit = await caches.match(url)
    if (hit) return hit.arrayBuffer()
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${file}: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  const buf = res.body && res.body.getReader ? await readProgress(res, file, total) : await res.arrayBuffer()
  if (cache && self.caches) (await caches.open('wherdr-asr-v1')).put(url, new Response(buf.slice(0), { headers: res.headers })).catch(() => {})
  return buf
}

async function readProgress(res, file, total) {
  const reader = res.body.getReader()
  const chunks = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
    postMessage({ t: 'dl', file, got, total })
  }
  const out = new Uint8Array(got)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out.buffer
}

async function load(msg) {
  postMessage({ t: 'phase', phase: 'wasm', detail: 'engine loading' })

  // Wait for the async wasm instantiate before touching the FS — bounded so a
  // hung fetch can't wedge the mic forever.
  await Promise.race([
    engineReady,
    new Promise((_, rej) => setTimeout(() => rej(new Error('speech engine load timed out — check the connection and try again')), 60000)),
  ])
  if (_engineError) throw _engineError
  if (typeof OfflineRecognizer !== 'function' || !Module.FS || !Module.HEAPU8) {
    throw new Error('speech engine failed to initialize (wasm not loaded) — check the connection and try again')
  }

  postMessage({ t: 'phase', phase: 'fetch' })

  try { Module.FS.mkdir(MODEL_DIR) } catch (e) {}
  for (const file of Object.values(msg.files)) {
    const buf = await fetchCached(`${msg.modelBase}/${file}`, file, msg.cache)
    Module.FS.writeFile(`${MODEL_DIR}/${file}`, new Uint8Array(buf))
  }

  postMessage({ t: 'phase', phase: 'create' })
  // SenseVoice: '' = auto language (zh/en/ja/ko/yue); ITN gives punctuation
  // and normalized numbers in the output text.
  recognizer = new OfflineRecognizer({
    modelConfig: {
      senseVoice: {
        model: `${MODEL_DIR}/model.int8.onnx`,
        language: '',
        useInverseTextNormalization: 1,
      },
      tokens: `${MODEL_DIR}/tokens.txt`,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
  }, Module)
}

self.onmessage = async (e) => {
  const m = e.data
  try {
    if (m.t === 'load') {
      const t0 = performance.now()
      await load(m)
      postMessage({ t: 'ready', loadMs: Math.round(performance.now() - t0) })
    } else if (m.t === 'push') {
      if (pendingLen >= MAX_SAMPLES) return
      const pcm = new Float32Array(m.pcm)
      pending.push(pcm)
      pendingLen += pcm.length
    } else if (m.t === 'flush') {
      // Always answer a flush — with nothing buffered there is nothing to
      // decode; a silent return leaves the composer stuck on "Recognizing…".
      if (!recognizer || !pendingLen) { postMessage({ t: 'final', text: '', decodeMs: 0 }); return }
      const t0 = performance.now()
      postMessage({ t: 'phase', phase: 'decode' })
      const all = new Float32Array(pendingLen)
      let at = 0
      for (const c of pending) { all.set(c, at); at += c.length }
      pending.length = 0; pendingLen = 0
      const stream = recognizer.createStream()
      try {
        stream.acceptWaveform(SAMPLE_RATE, all)
        recognizer.decode(stream)
        const r = recognizer.getResult(stream)
        const text = (r.text || '').replace(/<\|[^|]*\|>/g, '').trim()
        postMessage({ t: 'final', text, decodeMs: Math.round(performance.now() - t0) })
      } finally { stream.free() }
    } else if (m.t === 'reset') {
      pending.length = 0; pendingLen = 0
      postMessage({ t: 'partial', text: '' })
    }
  } catch (err) {
    pending.length = 0; pendingLen = 0
    postMessage({ t: 'error', error: String(err && err.stack || err) })
  }
}

importScripts(WASM_BASE + 'sherpa-onnx-wasm-combined.js')
importScripts(WASM_BASE + 'sherpa-onnx-core.js')
importScripts(WASM_BASE + 'sherpa-onnx-asr.js')
