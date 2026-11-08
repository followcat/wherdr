// Qwen3-ASR q4f16 on ORT WebGPU. Not wired into the model catalog yet.
// Ported from @followcat's public/workers/asr-worker.js
// (github.com/followcat/wherdr, branch mobile, MIT).
// Same load/phase/dl/ready/decode/final/error protocol as dictation-worker.js;
// decode additionally accepts terms[] and language, and returns language/truncated.
// {t:'cancel',id} suppresses that request; {t:'dispose'} releases the model.
// All session operations are serialized, including recovery and disposal.
'use strict'

importScripts('/workers/model-files.js', '/workers/qwen3/tokenizer.js', '/workers/qwen3/prompt.js', '/workers/qwen3/mel.js', '/workers/qwen3/fp16.js')
const Q = self.wherdrQwen3
const CANCELLED = Symbol('cancelled')
const jobs = new Map()
let queue = Promise.resolve(), model = null, loadConfig = null, active = null

function check(state, job) {
  if (state.failure) throw state.failure
  if (job?.cancelled) throw CANCELLED
}

async function reset() {
  const state = model
  model = null
  if (!state) return
  // Partial initialization owns its successful sessions too. A failed release
  // must not skip the other sessions or the device.
  for (const session of state.sessions) {
    try { await session.release() } catch { /* device may already be lost */ }
  }
  state.restore()
  for (const device of state.devices) {
    try { device.destroy() } catch { /* continue recovery after device loss */ }
  }
  if (self.ort === state.ort) self.ort = null // let the old WASM heap become collectible
}

async function load(msg) {
  await reset()
  postMessage({ t: 'phase', phase: 'runtime' })
  const gpu = self.navigator.gpu, requestAdapter = gpu?.requestAdapter
  const adapter = await requestAdapter?.call(gpu)
  if (!adapter || !adapter.features.has('shader-f16')) throw new Error('Unsupported speech device: WebGPU and shader-f16 required')
  const requestDevice = adapter.requestDevice
  const state = model = { sessions: [], devices: new Set(), failure: null, restore() {
    gpu.requestAdapter = requestAdapter; adapter.requestDevice = requestDevice
  } }
  // ORT 1.23.2's native WebGPU path ignores env.webgpu.adapter, and an
  // imported custom device fails synchronous downloads (ORT #32257).
  // Keep its native device/instance creation, bound to the checked adapter
  // in this private worker, and capture every device for partial-load cleanup.
  gpu.requestAdapter = async () => adapter
  adapter.requestDevice = async (descriptor = {}) => {
    const device = await requestDevice.call(adapter, { ...descriptor,
      requiredFeatures: [...new Set([...(descriptor.requiredFeatures || []), 'shader-f16'])] })
    state.devices.add(device)
    device.lost.then(() => {
      if (model !== state) return
      state.failure = new Error('Speech GPU device lost')
      if (!active) postMessage({ t: 'error', error: state.failure.message })
      // Never release sessions while an awaited run is still using them.
      queue = queue.then(async () => { if (model === state) await reset() })
    })
    return device
  }
  // Re-execute the classic bundle to discard ORT's cached backend failures
  // and its lost default device. The cached .mjs factory makes fresh WASM state.
  importScripts(msg.runtime + 'ort.webgpu.min.js')
  const ort = self.ort
  state.ort = ort
  ort.env.wasm.wasmPaths = msg.runtime
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  ort.env.webgpu.adapter = adapter
  const get = async file => {
    const i = msg.files.indexOf(file)
    if (i < 0) throw new Error('Missing speech model file: ' + file)
    const res = await self.wherdrModelFiles.openFile(`${msg.base}/${file}`, file, msg.bytes[i], msg)
    const bytes = await res.arrayBuffer()
    check(state)
    if (bytes.byteLength !== msg.bytes[i]) throw new Error('Invalid speech model file size: ' + file)
    return bytes
  }
  const json = async file => JSON.parse(new TextDecoder().decode(await get(file)))
  postMessage({ t: 'phase', phase: 'fetch' })
  const config = await json('prompt_config.json'), v = config.variants.q4f16
  if (config.layout_version !== 2 || !Number.isInteger(config.prompt.max_new_tokens) || config.prompt.max_new_tokens < 1) throw new Error('Unsupported speech model prompt configuration')
  const filters = await json(config.mel.filters_file)
  Q.mel.logMel(new Float32Array(), filters) // validate before loading weights
  const tok = Q.tokenizer(await json('tokenizer.json'))
  const hidden = config.decoder.hidden_size
  const emb = new Int8Array(await get(config.embedding.file))
  const scales = new Float32Array(await get(config.embedding.scales_file))
  if (emb.length !== scales.length * hidden || scales.length !== config.decoder.vocab_size) throw new Error('Invalid speech model embeddings')
  let weights = new Uint8Array(await get(v.weights))
  postMessage({ t: 'phase', phase: 'create' })
  const options = { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' }
  const create = async (file, decoder = false) => {
    const session = await ort.InferenceSession.create(new Uint8Array(await get(file)), decoder ? {
      ...options, externalData: [{ path: v.weights, data: weights }],
      preferredOutputLocation: { present_keys: 'gpu-buffer', present_values: 'gpu-buffer' },
    } : options)
    state.sessions.push(session)
    const device = ort.env.webgpu.device
    if (!state.devices.has(device) || !device.features.has('shader-f16')
      || (state.device && state.device !== device)) throw new Error('Speech runtime used an unexpected GPU device')
    state.device = device
    check(state)
    return session
  }
  state.encoder = await create(v.encoder)
  state.init = await create(v.decoder_init, true)
  state.step = await create(v.decoder_step, true)
  weights = null // session creation has consumed the external weights
  const type = (session, name) => session.inputMetadata[session.inputNames.indexOf(name)].type
  Object.assign(state, { config, filters, tok, hidden, emb, scales,
    melType: type(state.encoder, 'mel'), initType: type(state.init, 'input_embeds'), stepType: type(state.step, 'input_embeds') })
  return state
}

async function decode(state, msg, job) {
  const { ort, config, hidden, emb, scales } = state
  const owned = new Set()
  const tensor = (type, data, dims) => {
    const t = new ort.Tensor(type, data, dims)
    owned.add(t)
    return t
  }
  const release = t => { if (owned.delete(t)) { try { t.dispose() } catch { /* keep cleaning */ } } }
  const run = async (session, feeds) => {
    check(state, job)
    const out = await session.run(feeds)
    for (const t of Object.values(out)) owned.add(t)
    check(state, job)
    return out
  }
  const floats = async t => {
    const data = await t.getData()
    check(state, job)
    return t.type === 'float16' ? Q.fp16.f16ToF32(data) : data
  }
  const embed = (id, out, offset) => {
    if (!Number.isInteger(id) || id < 0 || id >= scales.length) throw new Error('Invalid speech token id')
    for (let i = 0; i < hidden; i++) out[offset + i] = emb[id * hidden + i] * scales[id]
  }
  const input = (type, data, dims) => tensor(type, type === 'float16' ? Q.fp16.f32ToF16(data) : data, dims)
  const nextToken = async logits => {
    const data = await floats(logits), n = logits.dims.at(-1)
    let best = -Infinity, id = -1
    for (let i = data.length - n; i < data.length; i++) if (data[i] > best) { best = data[i]; id = i - (data.length - n) }
    release(logits)
    if (id < 0) throw new Error('Invalid speech decoder logits')
    return id
  }
  try {
    check(state, job)
    const mel = Q.mel.logMel(new Float32Array(msg.pcm), state.filters, { dropLastFrame: config.mel.drop_last_frame })
    const mt = input(state.melType, mel.data, [1, mel.nMels, mel.T])
    const encoded = await run(state.encoder, { mel: mt })
    release(mt)
    const af = encoded.audio_features, nAudio = af.dims[1]
    const context = Q.prompt.contextOf(msg.terms)
    const prompt = Q.prompt.buildPrompt(config, state.tok.encode(context), nAudio, msg.language || loadConfig.language)
    const x = new Float32Array(prompt.ids.length * hidden)
    for (let i = 0; i < prompt.ids.length; i++) embed(prompt.ids[i], x, i * hidden)
    x.set(await floats(af), prompt.audioStart * hidden)
    for (const t of Object.values(encoded)) release(t)
    const xt = input(state.initType, x, [1, prompt.ids.length, hidden])
    const pt = tensor('int64', BigInt64Array.from(prompt.ids, (_, i) => BigInt(i)), [1, prompt.ids.length])
    let out = await run(state.init, { input_embeds: xt, position_ids: pt })
    release(xt); release(pt)
    let pk = out.present_keys, pv = out.present_values
    let next = await nextToken(out.logits), pos = prompt.ids.length
    const generated = [next], eos = new Set(config.prompt.eos_ids)
    while (!eos.has(next) && generated.length < prompt.maxNewTokens) {
      const e = new Float32Array(hidden)
      embed(next, e, 0)
      const et = input(state.stepType, e, [1, 1, hidden])
      const p = tensor('int64', BigInt64Array.from([BigInt(pos++)]), [1, 1])
      out = await run(state.step, { input_embeds: et, position_ids: p, past_keys: pk, past_values: pv })
      release(et); release(p)
      if (pk !== out.present_keys) release(pk)
      if (pv !== out.present_values) release(pv)
      pk = out.present_keys; pv = out.present_values
      next = await nextToken(out.logits)
      generated.push(next)
    }
    check(state, job)
    return Q.prompt.parseOutput(config, generated, ids => state.tok.decode(ids))
  } finally {
    for (const t of owned) release(t)
  }
}

async function handle(msg, job) {
  active = msg
  const t0 = performance.now()
  try {
    if (job?.cancelled) return
    if (msg.t === 'dispose') { loadConfig = null; await reset() }
    else if (msg.t === 'load') {
      loadConfig = msg
      const state = await load(msg)
      check(state) // Device loss can settle before this await continuation.
      postMessage({ t: 'ready', ms: Math.round(performance.now() - t0) })
    } else {
      if (model?.failure) await reset()
      if (!model) {
        if (!loadConfig) throw new Error('No speech model loaded')
        await load(loadConfig)
      }
      const result = await decode(model, msg, job)
      check(model, job)
      postMessage({ t: 'final', id: msg.id, ...result, ms: Math.round(performance.now() - t0) })
    }
  } catch (err) {
    if (err !== CANCELLED) {
      await reset()
      if (!job?.cancelled) postMessage({ t: 'error', id: msg.id, error: String(err?.message || err) })
    }
  } finally {
    if (job) jobs.delete(msg.id)
    active = null
  }
}

self.onmessage = ({ data: msg }) => {
  if (msg.t === 'cancel') { const job = jobs.get(msg.id); if (job) job.cancelled = true; return }
  if (!['load', 'decode', 'dispose'].includes(msg.t)) return
  if (msg.t !== 'decode') for (const job of jobs.values()) job.cancelled = true
  if (msg.t === 'decode' && jobs.has(msg.id)) { postMessage({ t: 'error', id: msg.id, error: 'Duplicate speech request id' }); return }
  const job = msg.t === 'decode' ? { cancelled: false } : null
  if (job) jobs.set(msg.id, job)
  queue = queue.then(() => handle(msg, job))
}
