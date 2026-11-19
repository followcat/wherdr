// On-device Cantonese read-aloud worker: canto-tts-nano int8 through
// onnxruntime-web (CPU/WASM, single thread), the canto-hk-g2p WASM text front
// end, OpenCC s2t, and the model's SentencePiece BPE.
//
// The message protocol is tts-worker.js's, with two additions:
//   in : {t:'cancel', id}       stop that sentence's work
//   out: {t:'parts', id, count}  how many audio parts the sentence has
//   out: {t:'audio', id, part, parts, pcm, sampleRate, ms, heap, truncated?}
//         pcm is mono, transferred; a sentence is split at G2P word
//         boundaries so no word is cut, and the first part is short.
//   out: {t:'cancelled', id}    the worker stopped before the next ORT call
//
// The model, G2P data and OpenCC tables come from /models/** through the
// shared model-files loader; the runtime (ORT, G2P wasm) and this worker from
// /workers/ and /models/runtime/. Nothing leaves the device.
'use strict'

self.window = self

// Measure the ORT WASM heap: ORT does not expose its WebAssembly.Memory.
self.__cantoMemories = []
const OrigMemory = WebAssembly.Memory
WebAssembly.Memory = class extends OrigMemory {
  constructor(descriptor) {
    super(descriptor)
    self.__cantoMemories.push(this)
  }
}

importScripts(
  '/workers/model-files.js',
  '/workers/canto/normalize.js',
  '/workers/canto/canto_g2p.js',
  '/workers/canto/text.js',
  '/workers/canto/runner.js',
)

const { openFile } = self.wherdrModelFiles
const text = self.wherdrCantoText
const runnerApi = self.wherdrCantoRunner
const CANCELLED = runnerApi.CANCELLED
const dec = new TextDecoder()

let ortRuntime = null
let runner = null
let g2p = null
let s2t = null
let encoder = null
let current = null
let loading = null
let loaded = false

function post(msg, transfer) {
  postMessage(msg, transfer || [])
}

function bytesOf(msg, path) {
  const i = msg.files.indexOf(path)
  if (i < 0) throw new Error('missing voice file: ' + path)
  return msg.bytes[i]
}

async function readFile(msg, base, path) {
  const res = await openFile(`${base}/${path}`, path, bytesOf(msg, path), msg)
  return new Uint8Array(await res.arrayBuffer())
}

function concat(a, b) {
  const out = new Float32Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

async function speak(msg, job) {
  if (!runner || !g2p) throw new Error('no voice loaded')
  const input = s2t.convert(msg.text)
  const flat = g2p.words(input)
  const words = []
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const token = flat[i]
    const jyutping = flat[i + 1]
    words.push({ token, jyutping, pieces: text.jyutpingToPieces(jyutping) })
  }
  const groups = text.groupWords(words, { cap: 48, firstCap: 24 })
  post({ t: 'parts', id: msg.id, count: groups.length })
  for (let i = 0; i < groups.length; i++) {
    if (job.cancelled) throw CANCELLED
    const group = groups[i]
    const synth = async (g) => runner.synthesize(encoder.encodePhonemes(text.safePrepare(g.pieces.join(' '))), {
      maxFrames: 48,
      cancelled: () => job.cancelled,
    })
    let out = await synth(group)
    if (out.truncated && group.words.length > 1) {
      // Never play a cut-off word: split at a word boundary and try once.
      const mid = Math.ceil(group.words.length / 2)
      const half = (ws) => ({ words: ws, pieces: ws.flatMap(w => w.pieces) })
      const a = await synth(half(group.words.slice(0, mid)))
      const b = await synth(half(group.words.slice(mid)))
      out = { ...out, pcm: concat(a.pcm, b.pcm), ms: a.ms + b.ms, heap: Math.max(a.heap, b.heap), truncated: a.truncated || b.truncated }
    }
    if (job.cancelled) throw CANCELLED
    post({
      t: 'audio',
      id: msg.id,
      part: i,
      parts: groups.length,
      pcm: out.pcm.buffer,
      sampleRate: out.sampleRate,
      ms: out.ms,
      heap: out.heap,
      truncated: out.truncated,
    }, [out.pcm.buffer])
  }
}

async function load(msg) {
  const t0 = performance.now()
  const job = { cancelled: false }
  loading = job
  try {
    post({ t: 'phase', phase: 'runtime' })
    importScripts(msg.runtime + 'ort.webgpu.min.js')
    ortRuntime = self.ort
    if (!ortRuntime) throw new Error('the speech runtime failed to load')
    ortRuntime.env.wasm.wasmPaths = msg.runtime
    ortRuntime.env.wasm.numThreads = 1
    ortRuntime.env.wasm.proxy = false
    ortRuntime.env.logLevel = 'error'

    post({ t: 'phase', phase: 'fetch' })
    const base = msg.base
    const [word, char, separable, slang, classifier] = await Promise.all([
      readFile(msg, base, 'g2p/data/word.bin'),
      readFile(msg, base, 'g2p/data/char.bin'),
      readFile(msg, base, 'g2p/data/separable.bin'),
      readFile(msg, base, 'g2p/data/romanized_slang.bin'),
      readFile(msg, base, 'g2p/data/classifier_words.bin'),
    ])
    const g2pWasm = new Uint8Array(await (await fetch('/workers/canto/canto_g2p_bg.wasm')).arrayBuffer())
    await wasm_bindgen({ module_or_path: g2pWasm })
    g2p = new wasm_bindgen.WasmPipeline(word, char, separable, slang, classifier)
    if (job.cancelled) throw CANCELLED

    const tokenizer = await readFile(msg, base, 'tokenizer.model')
    const added = JSON.parse(dec.decode(await readFile(msg, base, 'added_tokens.json')))
    const phrases = dec.decode(await readFile(msg, base, 's2t/STPhrases.txt'))
    const chars = dec.decode(await readFile(msg, base, 's2t/STCharacters.txt'))
    encoder = text.encoder(tokenizer, added)
    s2t = text.parseS2T(phrases, chars)
    if (job.cancelled) throw CANCELLED

    post({ t: 'phase', phase: 'create' })
    runner = await runnerApi.createRunner({ ort: ortRuntime, base, msg, openFile })
    if (job.cancelled) throw CANCELLED
    loaded = true
    post({ t: 'ready', ms: Math.round(performance.now() - t0), heap: runner.heap(), sampleRate: 48000, threads: ortRuntime.env.wasm.numThreads })
  } finally {
    if (loading === job) loading = null
  }
}

async function release() {
  try { await runner?.release() } catch { /* already released */ }
  runner = null
  try { g2p?.free() } catch { /* already freed */ }
  g2p = null
  loaded = false
}

async function dispose() {
  await release()
  self.close()
}

self.onmessage = async (e) => {
  const m = e.data
  try {
    if (m.t === 'load') {
      if (loaded) await release()
      await load(m)
    }
    else if (m.t === 'cancel') {
      if (current && current.id === m.id) current.cancelled = true
      if (loading) loading.cancelled = true
      post({ t: 'cancelled', id: m.id })
    }
    else if (m.t === 'dispose') {
      await dispose()
    }
    else if (m.t === 'speak') {
      if (!loaded) throw new Error('no voice loaded')
      const job = { id: m.id, cancelled: false }
      current = job
      try { await speak(m, job) }
      finally { if (current === job) current = null }
    }
  }
  catch (err) {
    if (err !== CANCELLED) post({ t: 'error', id: m.id, error: String((err && err.message) || err) })
  }
}
