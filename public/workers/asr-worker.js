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

// ---- Qwen3-ASR 0.6B q4f16 (onnxruntime-web + WebGPU) --------------------
// A different engine than sherpa-onnx: int4-block weights with fp16
// activations, fp16 encoder, and a KV-cached decoder stepped token by token.
// ~14x faster decode than the retired int8 sherpa path on the phone
// (measured ~70 ms/token on Adreno-8xx vs ~14.5 s for a 3 s take).
const ORT_BASE = '/ort/'
const Q4_N_FFT = 400, Q4_HOP = 160, Q4_N_FREQS = 201
const q4HasF16 = typeof Float16Array !== 'undefined'
let q4 = null

function q4f32ToF16(src) {
  if (q4HasF16) return new Uint16Array(new Float16Array(src).buffer)
  const out = new Uint16Array(src.length), f = new Float32Array(1), u = new Uint32Array(f.buffer)
  for (let i = 0; i < src.length; i++) { f[0] = src[i]; const x = u[0], s = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112, m = (x >>> 13) & 0x3ff; out[i] = e <= 0 ? s : e >= 31 ? s | 0x7c00 : s | (e << 10) | m }
  return out
}
function q4f16ToF32(src) {
  if (q4HasF16) return new Float32Array(new Float16Array(src.buffer, src.byteOffset, src.length))
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) { const h = src[i], s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff; out[i] = e === 0 ? s * Math.pow(2, -14) * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + f / 1024) }
  return out
}
let _q4dft = null
function q4DftTables() {
  if (_q4dft) return _q4dft
  const cos = new Float32Array(Q4_N_FREQS * Q4_N_FFT), sin = new Float32Array(Q4_N_FREQS * Q4_N_FFT)
  for (let k = 0; k < Q4_N_FREQS; k++) for (let n = 0; n < Q4_N_FFT; n++) { const a = 2 * Math.PI * k * n / Q4_N_FFT; cos[k * Q4_N_FFT + n] = Math.cos(a); sin[k * Q4_N_FFT + n] = Math.sin(a) }
  const w = new Float32Array(Q4_N_FFT)
  for (let n = 0; n < Q4_N_FFT; n++) w[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / Q4_N_FFT)
  _q4dft = { cos, sin, w }
  return _q4dft
}
// Whisper-style log-mel: power spectrum, mel filterbank, log10, global-max
// normalize to [0,1]; the last frame is dropped per prompt_config.
function q4LogMel(audio, filters) {
  const { cos, sin, w } = q4DftTables()
  const nMels = filters.n_mels
  const fb = new Float32Array(nMels * Q4_N_FREQS)
  for (let m = 0; m < nMels; m++) for (let k = 0; k < Q4_N_FREQS; k++) fb[m * Q4_N_FREQS + k] = filters.data[m][k]
  const pad = Q4_N_FFT / 2, L = audio.length, padded = new Float32Array(L + 2 * pad)
  for (let i = 0; i < pad; i++) padded[i] = audio[pad - i]
  padded.set(audio, pad)
  for (let i = 0; i < pad; i++) padded[pad + L + i] = audio[L - 2 - i]
  const nFrames = 1 + Math.floor((padded.length - Q4_N_FFT) / Q4_HOP), T = nFrames - 1
  const out = new Float32Array(nMels * T), frame = new Float32Array(Q4_N_FFT), power = new Float32Array(Q4_N_FREQS)
  let gmax = -1 / 0
  for (let t = 0; t < T; t++) {
    const off = t * Q4_HOP
    for (let n = 0; n < Q4_N_FFT; n++) frame[n] = padded[off + n] * w[n]
    for (let k = 0; k < Q4_N_FREQS; k++) {
      let re = 0, im = 0
      const b = k * Q4_N_FFT
      for (let n = 0; n < Q4_N_FFT; n++) { re += frame[n] * cos[b + n]; im -= frame[n] * sin[b + n] }
      power[k] = re * re + im * im
    }
    for (let m = 0; m < nMels; m++) {
      let acc = 0
      const fb2 = m * Q4_N_FREQS
      for (let k = 0; k < Q4_N_FREQS; k++) acc += fb[fb2 + k] * power[k]
      const v = Math.log10(Math.max(acc, 1e-10))
      out[m * T + t] = v
      if (v > gmax) gmax = v
    }
  }
  const fl = gmax - 8
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i], fl) + 4) / 4
  return { data: out, nMels, T }
}
function q4BytesToUnicode() {
  const bs = []
  for (let b = 0x21; b <= 0x7e; b++) bs.push(b)
  for (let b = 0xa1; b <= 0xac; b++) bs.push(b)
  for (let b = 0xae; b <= 0xff; b++) bs.push(b)
  const cs = bs.slice()
  let n = 0
  for (let b = 0; b < 256; b++) { if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++ } }
  const m = new Map()
  for (let i = 0; i < bs.length; i++) m.set(String.fromCharCode(cs[i]), bs[i])
  return m
}
// Byte-level BPE decode for the shared Qwen tokenizer (ids -> string only;
// encoding is not needed: the prompt is built from prompt_config's ids).
function q4Tokenizer(tj) {
  const idTo = []
  for (const [t, id] of Object.entries(tj.model.vocab)) idTo[id] = t
  const sp = new Map()
  for (const t of tj.added_tokens || []) sp.set(t.id, t.content)
  const c2b = q4BytesToUnicode(), td = new TextDecoder('utf-8')
  return {
    decode(ids) {
      const bytes = []
      let out = ''
      const flush = () => { if (bytes.length) { out += td.decode(new Uint8Array(bytes)); bytes.length = 0 } }
      for (const id of ids) {
        if (sp.has(id)) { flush(); continue }
        const tok = idTo[id]
        if (tok === undefined) { flush(); out += '<unk:' + id + '>'; continue }
        for (const ch of tok) {
          const b = c2b.get(ch)
          if (b === undefined) { flush(); out += ch } else bytes.push(b)
        }
      }
      flush()
      return out
    },
  }
}
const q4Argmax = (a) => { let bi = 0, bv = -1 / 0; for (let i = 0; i < a.length; i++) if (a[i] > bv) { bv = a[i]; bi = i } return bi }

async function loadQ4F16(msg) {
  postMessage({ t: 'phase', phase: 'wasm', detail: 'ort loading' })
  importScripts(ORT_BASE + 'ort.webgpu.min.js')
  const ort = globalThis.ort || self.ort
  ort.env.wasm.wasmPaths = ORT_BASE
  ort.env.wasm.numThreads = 1
  let gpu = null
  for (let i = 0; i < 4 && !gpu; i++) { gpu = await navigator.gpu.requestAdapter().catch(() => null); if (!gpu) await sleep(1200) }
  if (!gpu) throw new Error('WebGPU adapter unavailable — q4f16 needs WebGPU')
  if (!gpu.features.has('shader-f16')) throw new Error('this GPU lacks shader-f16 — pick a different speech model')

  postMessage({ t: 'phase', phase: 'fetch' })
  const MB = msg.modelBase
  const get = (f) => fetchCached(`${MB}/${f}`, f, msg.cache)
  const PC = await (await get('prompt_config.json')).json()
  const V = PC.variants.q4f16
  const filters = await (await get(PC.mel.filters_file)).json()
  const tok = q4Tokenizer(await (await get('tokenizer.json')).json())
  const hidden = PC.decoder.hidden_size
  const embI8 = new Int8Array(await (await get(PC.embedding.file)).arrayBuffer())
  const embScales = new Float32Array(await (await get(PC.embedding.scales_file)).arrayBuffer())
  const weights = new Uint8Array(await (await get(V.weights)).arrayBuffer())

  postMessage({ t: 'phase', phase: 'create' })
  const so = { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' }
  const kv = { present_keys: 'gpu-buffer', present_values: 'gpu-buffer' }
  const encSess = await ort.InferenceSession.create(new Uint8Array(await (await get(V.encoder)).arrayBuffer()), so)
  const initSess = await ort.InferenceSession.create(new Uint8Array(await (await get(V.decoder_init)).arrayBuffer()), { ...so, externalData: [{ path: V.weights, data: weights }], preferredOutputLocation: kv })
  const stepSess = await ort.InferenceSession.create(new Uint8Array(await (await get(V.decoder_step)).arrayBuffer()), { ...so, externalData: [{ path: V.weights, data: weights }], preferredOutputLocation: kv })
  const meta = (s, name) => s.inputMetadata?.[s.inputNames.indexOf(name)]?.type
  q4 = {
    ort, PC, filters, tok, hidden, embI8, embScales, encSess, initSess, stepSess,
    embType: meta(initSess, 'input_embeds') || 'float16',
    stepEmbType: meta(stepSess, 'input_embeds') || 'float16',
    encMelType: encSess.inputMetadata?.[0]?.type || 'float32',
  }
  activeProvider = 'webgpu'
}

// Greedy decode of one take: mel -> encoder -> prompt+embed -> prefill ->
// KV-cached step loop until EOS / max_new_tokens.
async function decodeQ4F16(all) {
  const { ort, PC, filters, tok, hidden, embI8, embScales, encSess, initSess, stepSess, embType, stepEmbType, encMelType } = q4
  const mel = q4LogMel(all, filters)
  const encOut = await encSess.run({ mel: new ort.Tensor(encMelType, encMelType === 'float16' ? q4f32ToF16(mel.data) : mel.data, [1, mel.nMels, mel.T]) })
  const af = encOut.audio_features, nAudio = af.dims[1]
  const afF32 = af.type === 'float16' ? q4f16ToF32(af.data) : af.data
  const ids = [...PC.prompt.prefix_ids]
  const audioStart = ids.length
  for (let i = 0; i < nAudio; i++) ids.push(PC.prompt.audio_pad_id)
  ids.push(...PC.prompt.suffix_ids)
  const embedRow = (id, out, off) => { const o = id * hidden, s = embScales[id]; for (let i = 0; i < hidden; i++) out[off + i] = embI8[o + i] * s }
  const x = new Float32Array(ids.length * hidden)
  for (let i = 0; i < ids.length; i++) embedRow(ids[i], x, i * hidden)
  x.set(afF32, audioStart * hidden)
  const pre = await initSess.run({
    input_embeds: new ort.Tensor(embType, embType === 'float16' ? q4f32ToF16(x) : x, [1, ids.length, hidden]),
    position_ids: new ort.Tensor('int64', BigInt64Array.from({ length: ids.length }, (_, i) => BigInt(i)), [1, ids.length]),
  })
  const EOS = new Set(PC.prompt.eos_ids)
  const vocabN = pre.logits.dims[pre.logits.dims.length - 1]
  let lg = pre.logits.type === 'float16' ? q4f16ToF32(pre.logits.data) : pre.logits.data
  let next = q4Argmax(lg.subarray(lg.length - vocabN))
  let pk = pre.present_keys, pv = pre.present_values
  const gen = [next]
  let pos = ids.length
  while (!EOS.has(next) && gen.length < PC.prompt.max_new_tokens) {
    const e = new Float32Array(hidden)
    embedRow(next, e, 0)
    const s = await stepSess.run({
      input_embeds: new ort.Tensor(stepEmbType, stepEmbType === 'float16' ? q4f32ToF16(e) : e, [1, 1, hidden]),
      position_ids: new ort.Tensor('int64', BigInt64Array.from([BigInt(pos)]), [1, 1]),
      past_keys: pk, past_values: pv,
    })
    pk.dispose?.(); pv.dispose?.()
    pk = s.present_keys; pv = s.present_values
    lg = s.logits.type === 'float16' ? q4f16ToF32(s.logits.data) : s.logits.data
    next = q4Argmax(lg.subarray(lg.length - vocabN)); gen.push(next); pos++
  }
  pk.dispose?.(); pv.dispose?.()
  const cut = gen.indexOf(PC.prompt.asr_text_id)
  return tok.decode(cut >= 0 ? gen.slice(cut + 1) : gen)
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

let sherpaStarted = false
function ensureSherpa() {
  if (sherpaStarted) return
  sherpaStarted = true
  importScripts(WASM_BASE + 'sherpa-onnx-wasm-combined.js')
  importScripts(WASM_BASE + 'sherpa-onnx-core.js')
  importScripts(WASM_BASE + 'sherpa-onnx-asr.js')
}

async function load(msg) {
  // q4f16 is a different engine (onnxruntime-web + WebGPU), no sherpa FS.
  if (msg.kind === 'qwen3Q4F16') {
    try { recognizer && recognizer.free() } catch (e) {}
    recognizer = null
    await loadQ4F16(msg)
    return
  }
  q4 = null
  ensureSherpa()
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
      if ((!recognizer && !q4) || !pendingLen) { postMessage({ t: 'final', text: '', decodeMs: 0 }); return }
      const t0 = performance.now()
      postMessage({ t: 'phase', phase: 'decode' })
      const all = new Float32Array(pendingLen)
      let at = 0
      for (const c of pending) { all.set(c, at); at += c.length }
      pending.length = 0; pendingLen = 0
      // Take stats travel with the result — a silent mic and a bad decode
      // look identical in the UI otherwise.
      let peak = 0, sumSq = 0
      for (let i = 0; i < all.length; i++) { const v = Math.abs(all[i]); if (v > peak) peak = v; sumSq += v * v }
      const take = { secs: Math.round(all.length / SAMPLE_RATE * 10) / 10, rms: Math.sqrt(sumSq / (all.length || 1)), peak }
      if (q4) {
        const text = await decodeQ4F16(all)
        postMessage({ t: 'final', text, decodeMs: Math.round(performance.now() - t0), take })
        return
      }
      const stream = recognizer.createStream()
      try {
        stream.acceptWaveform(SAMPLE_RATE, all)
        recognizer.decode(stream)
        const r = recognizer.getResult(stream)
        const text = (r.text || '').replace(/<\|[^|]*\|>/g, '').trim()
        postMessage({ t: 'final', text, decodeMs: Math.round(performance.now() - t0), take })
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

// sherpa-onnx is imported lazily by ensureSherpa() inside load(): the
// q4f16 engine needs onnxruntime-web instead, and skipping the wasm keeps
// its heavier model page from carrying an unused runtime.
