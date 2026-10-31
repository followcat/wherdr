// ASR worker: loads the sherpa-onnx WASM engine + a transducer model, then
// turns Float32 PCM (16 kHz mono) into partial/final text. All messages are
// plain objects; PCM frames travel as transferred ArrayBuffers.
//
//   in : {t:'load', wasmBase, modelBase, files, cache}
//   in : {t:'push', pcm:ArrayBuffer}        Float32, 16kHz
//   in : {t:'flush'}                         end of speech: finish input
//   in : {t:'reset'}                         drop the current stream
//   out: {t:'phase', phase, detail}          'fetch'|'wasm'|'create'
//   out: {t:'dl', file, got, total}
//   out: {t:'ready', loadMs}
//   out: {t:'partial', text}
//   out: {t:'segment', text}                 endpoint reached, stream reset
//   out: {t:'final', text, decodeMs}
//   out: {t:'error', error}

'use strict'

// The emscripten loader and the ASR bindings' browser shim read/write `window`;
// give them the worker global instead.
self.window = self

const WASM_BASE = '/wasm/'
const MODEL_DIR = '/asr-models'

let recognizer = null
let stream = null
let utterance = ''   // accumulated text for the current utterance (survives endpoint resets)

self.Module = {
  locateFile: (f) => WASM_BASE + f,
  onRuntimeInitialized() { postMessage({ t: 'phase', phase: 'wasm', detail: 'runtime ready' }) },
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
  postMessage({ t: 'phase', phase: 'fetch' })

  // If the wasm binary failed to fetch/instantiate, no HEAP views exist and
  // every FS call throws a cryptic `reading 'buffer'` TypeError — check for
  // the engine up front and report something actionable instead.
  if (typeof OnlineRecognizer !== 'function' || !Module.FS || !Module.HEAPU8) {
    throw new Error('speech engine failed to initialize (wasm not loaded) — check the connection and try again')
  }

  // Emscripten FS paths come from the official wasm example layout: one dir
  // with encoder.onnx / decoder.onnx / joiner.onnx / tokens.txt.
  try { Module.FS.mkdir(MODEL_DIR) } catch (e) {}
  const targets = { encoder: 'encoder.onnx', decoder: 'decoder.onnx', joiner: 'joiner.onnx', tokens: 'tokens.txt' }
  for (const [slot, file] of Object.entries(msg.files)) {
    const buf = await fetchCached(`${msg.modelBase}/${file}`, file, msg.cache)
    Module.FS.writeFile(`${MODEL_DIR}/${targets[slot] || file}`, new Uint8Array(buf))
  }

  postMessage({ t: 'phase', phase: 'create' })
  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: `${MODEL_DIR}/encoder.onnx`,
        decoder: `${MODEL_DIR}/decoder.onnx`,
        joiner: `${MODEL_DIR}/joiner.onnx`,
      },
      tokens: `${MODEL_DIR}/tokens.txt`,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 30,
  }
  recognizer = new OnlineRecognizer(config, Module)
  stream = recognizer.createStream()
}

function pump() {
  if (!recognizer || !stream) return
  while (recognizer.isReady(stream)) recognizer.decode(stream)
  const r = recognizer.getResult(stream)
  if (r.text) postMessage({ t: 'partial', text: utterance + r.text })
  if (recognizer.isEndpoint(stream)) {
    const seg = recognizer.getResult(stream)
    if (seg.text) { utterance += (utterance ? ' ' : '') + seg.text; postMessage({ t: 'segment', text: utterance }) }
    recognizer.reset(stream)
  }
}

self.onmessage = async (e) => {
  const m = e.data
  try {
    if (m.t === 'load') {
      const t0 = performance.now()
      await load(m)
      postMessage({ t: 'ready', loadMs: Math.round(performance.now() - t0) })
    } else if (m.t === 'push') {
      if (!stream) return
      stream.acceptWaveform(16000, new Float32Array(m.pcm))
      pump()
    } else if (m.t === 'flush') {
      // Always answer a flush — with no stream there is simply nothing to
      // decode; a silent return leaves the composer stuck in "Recognizing…".
      if (!stream || !recognizer) { postMessage({ t: 'final', text: '', decodeMs: 0 }); return }
      const t0 = performance.now()
      stream.inputFinished()
      while (recognizer.isReady(stream)) recognizer.decode(stream)
      const r = recognizer.getResult(stream)
      const text = r.text ? (utterance ? utterance + ' ' + r.text : r.text) : utterance
      postMessage({ t: 'final', text, decodeMs: Math.round(performance.now() - t0) })
      utterance = ''
      recognizer.reset(stream)
      stream.free()
      stream = recognizer.createStream()
    } else if (m.t === 'reset') {
      if (stream && recognizer) { stream.free(); stream = recognizer.createStream() }
      utterance = ''
      postMessage({ t: 'partial', text: '' })
    }
  } catch (err) {
    postMessage({ t: 'error', error: String(err && err.stack || err) })
  }
}

importScripts(WASM_BASE + 'sherpa-onnx-wasm-combined.js')
importScripts(WASM_BASE + 'sherpa-onnx-core.js')
importScripts(WASM_BASE + 'sherpa-onnx-asr.js')
