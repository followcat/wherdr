// ASR worker: loads the sherpa-onnx WASM engine + an offline model, then
// turns accumulated Float32 PCM (16 kHz mono) into final text on flush.
// All messages are plain objects; PCM frames travel as transferred
// ArrayBuffers.
//
//   in : {t:'load', wasmBase, modelBase, kind, files[], providers[], cache}
//   in : {t:'push', pcm:ArrayBuffer}        Float32, 16kHz
//   in : {t:'flush'}                         end of speech: decode the take
//   in : {t:'reset'}                         drop the buffered take
//   out: {t:'phase', phase, detail}          'wasm'|'fetch'|'create'|'decode'
//   out: {t:'dl', file, got, total}
//   out: {t:'ready', loadMs, provider}
//   out: {t:'partial', text}                 '' (kept for the composable)
//   out: {t:'final', text, decodeMs}
//   out: {t:'error', error}
//
// kind 'senseVoice': auto zh/en/ja/ko/yue, ITN punctuation.
// kind 'qwen3Asr':   best Cantonese quality; ~940 MB of weights the FS must
//                    hold — files are STREAMED in slices so the transient JS
//                    buffer never doubles the wasm heap (a whole-file
//                    writeFile OOM-killed the phone tab).
// providers: tried in order at recognizer creation (e.g. 'webgpu' then
// 'cpu'); the first that constructs wins and is reported in 'ready'.

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
let activeProvider = 'cpu'
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

// Large model files download in range slices: a long single GET through a
// tunnel or a captive mobile link dies mid-stream and restarts from zero,
// while each slice below gets its own retries and the progress survives.
const CHUNK = 8 * 1024 * 1024
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// A Response for `url`: the cache hit if stored, else a streamed download
// (also stored for next time). The body is never assembled in JS — slices
// feed a ReadableStream straight through, so a 750 MB file stays ~flat.
async function fetchCached(url, file, cache) {
  if (cache && self.caches) {
    const hit = await caches.match(url)
    if (hit) return hit
  }
  const gen = streamFile(url, file)
  const res = new Response(new ReadableStream({
    async pull(ctrl) {
      const { done, value } = await gen.next()
      if (done) ctrl.close()
      else ctrl.enqueue(value)
    },
  }), { headers: { 'content-type': 'application/octet-stream' } })
  if (cache && self.caches) {
    // Tee: one copy to disk, one to the caller. A tee'd body cannot be read
    // twice — the put consumes its own branch.
    const [forCache, forFs] = res.body ? res.body.tee() : [null, null]
    if (!forFs) throw new Error(`fetch ${file}: no body`)
    const cached = new Response(forCache, { headers: res.headers })
    ;(await caches.open('wherdr-asr-v1')).put(url, cached).catch(() => {})
    return new Response(forFs, { headers: res.headers })
  }
  return res
}

// The first request doubles as slice 0 and a range probe: a 206 means the
// server slices, a 200 means it streams whole files (older deploy) and the
// body is drained monolithically.
async function* streamFile(url, file) {
  const first = await refetch(() => fetch(url, { headers: { range: `bytes=0-${CHUNK - 1}` } }))
  if (first.status !== 206) {
    if (!first.ok) throw new Error(`fetch ${file}: HTTP ${first.status}`)
    const total = Number(first.headers.get('content-length')) || 0
    const reader = first.body.getReader()
    let got = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      got += value.length
      postMessage({ t: 'dl', file, got, total })
      yield value
    }
    return
  }
  const total = Number((first.headers.get('content-range') || '').split('/')[1]) || 0
  if (!total) throw new Error(`fetch ${file}: bad content-range`)
  const firstPart = new Uint8Array(await first.arrayBuffer())
  yield firstPart
  let got = firstPart.byteLength
  postMessage({ t: 'dl', file, got, total })
  while (got < total) {
    const end = Math.min(got + CHUNK - 1, total - 1)
    const res = await refetch(() => fetch(url, { headers: { range: `bytes=${got}-${end}` } }))
    if (res.status !== 206) throw new Error(`fetch ${file}: HTTP ${res.status} at byte ${got}`)
    const part = new Uint8Array(await res.arrayBuffer())
    if (part.byteLength !== end - got + 1) throw new Error(`fetch ${file}: short slice at byte ${got}`)
    yield part
    got = end + 1
    postMessage({ t: 'dl', file, got, total })
  }
}

async function refetch(doFetch) {
  let lastErr = null
  for (let i = 0; i < 5; i++) {
    try {
      const r = await doFetch()
      if (r.status < 500) return r
      lastErr = new Error(`HTTP ${r.status}`)
    } catch (e) { lastErr = e }
    await sleep(700 * (i + 1))
  }
  throw lastErr
}

// A file into the emscripten FS in reader-sized slices: the model weights
// must live in the wasm heap anyway, but the JS-side buffer stays ~1 MB
// instead of holding a second full copy (the phone tab was OOM-killed at a
// ~1.9 GB transient doing writeFile(whole ArrayBuffer)).
async function fsWriteStreamed(path, res) {
  const dir = path.slice(0, path.lastIndexOf('/'))
  if (dir) { try { Module.FS.mkdir(dir) } catch (e) {} }
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
  } finally { Module.FS.close(fd) }
}

// Per-engine modelConfig bodies — field names are the JS binding's
// camelCase (useItn, not useInverseTextNormalization; a wrong name is
// ignored silently and SenseVoice then never emits punctuation).
function engineBody(kind) {
  const M = MODEL_DIR
  switch (kind) {
    case 'qwen3Asr': return {
      convFrontend: `${M}/conv_frontend.onnx`,
      encoder: `${M}/encoder.int8.onnx`,
      decoder: `${M}/decoder.int8.onnx`,
      tokenizer: `${M}/tokenizer`,
      // ~13 audio tokens/s: 2048 covers a 120 s take with headroom.
      maxTotalLen: 2048,
      maxNewTokens: 512,
    }
    case 'funasrNano': return {
      encoderAdaptor: `${M}/encoder_adaptor.int8.onnx`,
      llm: `${M}/llm.int8.onnx`,
      embedding: `${M}/embedding.int8.onnx`,
      tokenizer: `${M}/Qwen3-0.6B`,
      language: '',
      itn: 1,
      userPrompt: '语音转写:',
      maxNewTokens: 512,
    }
    case 'cohereTranscribe': return {
      encoder: `${M}/encoder.int8.onnx`,
      decoder: `${M}/decoder.int8.onnx`,
      language: '',
    }
    case 'senseVoice': return {
      model: `${M}/model.int8.onnx`,
      language: '',
      useItn: 1,
    }
    // wenetCtc / omnilingual / dolphin / fireRedAsrCtc and any other
    // single-file CTC engine take just {model}.
    default: return { model: `${M}/model.int8.onnx` }
  }
}

function recognizerConfig(kind, providers) {
  const body = engineBody(kind)
  // The LLM-style engines carry their own tokenizer dir; the rest read
  // modelConfig.tokens.
  const tokens = (kind === 'qwen3Asr' || kind === 'funasrNano') ? '' : `${MODEL_DIR}/tokens.txt`
  return providers.map(p => () => new OfflineRecognizer({
    modelConfig: {
      [kind]: body,
      tokens,
      numThreads: 1,
      provider: p,
      debug: 0,
    },
  }, Module))
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
  const files = Array.isArray(msg.files) ? msg.files : Object.values(msg.files)
  for (const file of files) {
    const res = await fetchCached(`${msg.modelBase}/${file}`, file, msg.cache)
    await fsWriteStreamed(`${MODEL_DIR}/${file}`, res)
  }

  postMessage({ t: 'phase', phase: 'create' })
  const providers = msg.providers && msg.providers.length ? msg.providers : ['cpu']
  const tries = recognizerConfig(msg.kind || 'senseVoice', providers)
  let lastErr = null
  for (let i = 0; i < tries.length; i++) {
    try { recognizer = tries[i](); activeProvider = providers[i]; return }
    catch (e) { lastErr = e; postMessage({ t: 'phase', phase: 'create', detail: `provider ${providers[i]} failed, retrying: ${String(e).slice(0, 120)}` }) }
  }
  throw lastErr || new Error('recognizer creation failed')
}

self.onmessage = async (e) => {
  const m = e.data
  try {
    if (m.t === 'load') {
      const t0 = performance.now()
      await load(m)
      postMessage({ t: 'ready', loadMs: Math.round(performance.now() - t0), provider: activeProvider })
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
