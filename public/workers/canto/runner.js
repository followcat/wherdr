// The Canto model's ORT sessions and the reference synthesis loop
// (onnx_backend.py -> ort_cpu_runtime.py, the "fixed" sampling path):
// prefill once, then per frame local_fixed_sampled_frame + decode_step, then
// the codec's decode_full. One group of words at a time; the KV cache, frames
// and audio are released after each group.
//
// Parametrised per voice: the external-data file names, the float dtype
// (float32 for the INT8 build, float16 for the GPU build), the execution
// providers (wasm or webgpu) and whether the per-frame KV tensors stay on the
// GPU between steps. A classic script loaded by
// public/workers/canto-tts-worker.js.
'use strict'

;(() => {
const SAMPLE_RATE = 48000
const FRAME_RATE = 12.5
const N_VQ = 16
const PAD_TOKEN = 1024
const CANCELLED = Symbol('cancelled')

// What the INT8 voice uses; a voice's `runner` in the catalog overrides fields.
const DEFAULTS = {
  dtype: 'float32',
  providers: ['wasm'],
  kvGpu: false,
  external: {
    tts: 'moss_tts_decode_step.onnx.data',
    local: 'moss_tts_local_fixed_sampled_frame.onnx.data',
    codec: 'moss_audio_tokenizer_decode_shared.data',
  },
}

function runnerOptions(voiceRunner) {
  const r = voiceRunner || {}
  return {
    dtype: r.dtype === 'float16' ? 'float16' : 'float32',
    providers: Array.isArray(r.providers) && r.providers.length ? [...r.providers] : [...DEFAULTS.providers],
    kvGpu: !!r.kvGpu,
    external: { ...DEFAULTS.external, ...(r.external || {}) },
  }
}

function heap() {
  const mem = self.__cantoMemories || []
  let n = 0
  for (const m of mem) n = Math.max(n, m.buffer.byteLength)
  return n
}

// A macrotask lets a queued {t:'cancel'} run; awaiting ORT promises alone can
// starve the worker's message queue for a whole sentence.
const yieldNow = () => new Promise(resolve => setTimeout(resolve, 0))

function randomFloats(n) {
  const u = new Uint32Array(n)
  self.crypto.getRandomValues(u)
  const f = new Float32Array(n)
  for (let i = 0; i < n; i++) f[i] = Math.min(0.99999994, u[i] / 4294967296)
  return f
}

async function createRunner({ ort, base, msg, openFile, options: voiceRunner }) {
  const opt = runnerOptions(voiceRunner)
  const f16 = opt.dtype === 'float16'
  const floatType = f16 ? 'float16' : 'float32'
  const F = self.wherdrCantoFp16
  if (f16 && !F) throw new Error('the fp16 helpers are not loaded')
  const dec = new TextDecoder()
  const bytesOf = (path) => {
    const i = msg.files.indexOf(path)
    if (i < 0) throw new Error('missing model file: ' + path)
    return msg.bytes[i]
  }
  const read = async (path) => {
    const res = await openFile(`${base}/${path}`, path, bytesOf(path), msg)
    return new Uint8Array(await res.arrayBuffer())
  }
  const readJson = async (path) => JSON.parse(dec.decode(await read(path)))
  const manifest = await readJson('browser_poc_manifest.json')
  const ttsMeta = await readJson('MOSS-TTS-Nano-cantophon-ONNX/tts_browser_onnx_meta.json')
  const codecMeta = await readJson('MOSS-Audio-Tokenizer-Nano-ONNX/codec_browser_onnx_meta.json')
  const ttsDir = 'MOSS-TTS-Nano-cantophon-ONNX/'
  const codecDir = 'MOSS-Audio-Tokenizer-Nano-ONNX/'
  const sessionOptions = { executionProviders: opt.providers, graphOptimizationLevel: 'all' }
  const kvLocation = opt.kvGpu
    ? Object.fromEntries(Array.from({ length: 12 }, (_, i) => [
      [`present_key_${i}`, 'gpu-buffer'],
      [`present_value_${i}`, 'gpu-buffer'],
    ]).flat())
    : undefined
  const session = async (graph, dataPath, data, keepsKv = false) => {
    const model = await read(ttsDir + graph)
    return ort.InferenceSession.create(model, {
      ...sessionOptions,
      externalData: dataPath ? [{ path: dataPath, data }] : undefined,
      preferredOutputLocation: keepsKv ? kvLocation : undefined,
    })
  }

  let ttsData = await read(ttsDir + opt.external.tts)
  const decode = await session('moss_tts_decode_step.onnx', opt.external.tts, ttsData, true)
  const prefill = await session('moss_tts_prefill.onnx', opt.external.tts, ttsData, true)
  ttsData = null
  let localData = await read(ttsDir + opt.external.local)
  const local = await session('moss_tts_local_fixed_sampled_frame.onnx', opt.external.local, localData)
  localData = null
  let codecData = await read(codecDir + opt.external.codec)
  const codecSession = await ort.InferenceSession.create(await read(codecDir + 'moss_audio_tokenizer_decode_full.onnx'), {
    ...sessionOptions,
    externalData: [{ path: opt.external.codec, data: codecData }],
  })
  codecData = null

  // A single provider is requested and there is no silent CPU fallback: a
  // WebGPU session that could not create its device would have thrown by now.
  const provider = opt.providers[0] || 'wasm'
  if (opt.providers.includes('webgpu') && !ort.env.webgpu?.device) {
    throw new Error('WebGPU did not create a device for the speech model')
  }

  const nVq = manifest.tts_config.n_vq
  const width = nVq + 1
  const pad = manifest.tts_config.audio_pad_token_id ?? PAD_TOKEN
  const audioStart = manifest.tts_config.audio_start_token_id
  const audioEnd = manifest.tts_config.audio_end_token_id
  const userSlot = manifest.tts_config.audio_user_slot_token_id
  const assistantSlot = manifest.tts_config.audio_assistant_slot_token_id

  function textRows(ids) {
    return ids.map((t) => {
      const row = new Int32Array(width)
      row.fill(pad)
      row[0] = t
      return row
    })
  }

  function promptRows(ids) {
    const prefix = [...manifest.prompt_templates.user_prompt_prefix_token_ids, audioStart]
    const rows = [...textRows(prefix)]
    for (const codes of manifest.default_voice.prompt_audio_codes) {
      const row = new Int32Array(width)
      row.fill(pad)
      row[0] = userSlot
      row.set(codes.slice(0, nVq), 1)
      rows.push(row)
    }
    const suffix = [
      audioEnd,
      ...manifest.prompt_templates.user_prompt_after_reference_token_ids,
      ...ids,
      ...manifest.prompt_templates.assistant_prompt_prefix_token_ids,
      audioStart,
    ]
    rows.push(...textRows(suffix))
    return rows
  }

  // The random draws are made in f32 and converted only at the tensor edge.
  const floatTensor = (values, dims) => {
    const data = f16 ? F.toF16(values) : (values instanceof Float32Array ? values : Float32Array.from(values))
    return new ort.Tensor(floatType, data, dims)
  }
  const modelFloatTensor = (data, dims) => new ort.Tensor(floatType, data, dims)

  async function synthesize(ids, { maxFrames, cancelled }) {
    const t0 = performance.now()
    const rows = promptRows(ids)
    const n = rows.length
    const flat = new Int32Array(n * width)
    rows.forEach((r, i) => flat.set(r, i * width))
    const mask = new Int32Array(n).fill(1)
    const pf = await prefill.run({
      input_ids: new ort.Tensor('int32', flat, [1, n, width]),
      attention_mask: new ort.Tensor('int32', mask, [1, n]),
    })
    if (cancelled?.()) throw CANCELLED
    let hidden = pf.global_hidden.data.subarray((n - 1) * 768)
    const pastKeys = []
    const pastValues = []
    for (let i = 0; i < 12; i++) {
      pastKeys.push(pf['present_key_' + i])
      pastValues.push(pf['present_value_' + i])
    }
    let pastLen = n
    const seen = new Int32Array(nVq * 1024)
    const frames = []
    let truncated = false
    const disposeKv = () => {
      if (!opt.kvGpu) return
      for (const t of [...pastKeys, ...pastValues]) {
        try { t.dispose?.() } catch { /* device may be lost */ }
      }
    }
    try {
      for (let f = 0; f < maxFrames; f++) {
        if (f % 4 === 0) await yieldNow()
        if (cancelled?.()) throw CANCELLED
        const fr = await local.run({
          global_hidden: modelFloatTensor(hidden, [1, 768]),
          repetition_seen_mask: new ort.Tensor('int32', seen, [1, nVq, 1024]),
          assistant_random_u: floatTensor(randomFloats(1), [1]),
          audio_random_u: floatTensor(randomFloats(nVq), [1, nVq]),
        })
        const cont = Number(fr.should_continue.data[0]) !== 0
        if (!cont) break
        const frame = Int32Array.from(fr.frame_token_ids.data)
        frames.push(frame)
        for (let c = 0; c < nVq; c++) seen[c * 1024 + frame[c]] = 1
        const row = new Int32Array(width)
        row.fill(pad)
        row[0] = assistantSlot
        row.set(frame, 1)
        const feeds = {
          input_ids: new ort.Tensor('int32', row, [1, 1, width]),
          past_valid_lengths: new ort.Tensor('int32', new Int32Array([pastLen]), [1]),
        }
        for (let i = 0; i < 12; i++) {
          feeds['past_key_' + i] = pastKeys[i]
          feeds['past_value_' + i] = pastValues[i]
        }
        const ds = await decode.run(feeds)
        hidden = ds.global_hidden.data
        for (let i = 0; i < 12; i++) {
          // On the GPU the old tensors are ours to release; the CPU ones are
          // ordinary arrays and go with the GC.
          if (opt.kvGpu) {
            try { pastKeys[i].dispose?.() } catch { /* released */ }
            try { pastValues[i].dispose?.() } catch { /* released */ }
          }
          pastKeys[i] = ds['present_key_' + i]
          pastValues[i] = ds['present_value_' + i]
        }
        pastLen++
        if (f === maxFrames - 1) truncated = true
      }
      if (!frames.length) {
        disposeKv()
        return { pcm: new Float32Array(0), sampleRate: SAMPLE_RATE, truncated, ms: Math.round(performance.now() - t0), heap: heap() }
      }
      const codes = new Int32Array(frames.length * nVq)
      frames.forEach((fr, i) => codes.set(fr, i * nVq))
      const out = await codecSession.run({
        audio_codes: new ort.Tensor('int32', codes, [1, frames.length, nVq]),
        audio_code_lengths: new ort.Tensor('int32', new Int32Array([frames.length]), [1]),
      })
      const length = Number(out.audio_lengths.data[0])
      const raw = out.audio.data
      const audio = f16 ? F.fromF16(raw) : raw
      const pcm = new Float32Array(length)
      for (let i = 0; i < length; i++) pcm[i] = (audio[i] + audio[length + i]) / 2
      disposeKv()
      return {
        pcm,
        sampleRate: codecMeta.codec_config.sample_rate || SAMPLE_RATE,
        truncated,
        frames: frames.length,
        ms: Math.round(performance.now() - t0),
        heap: heap(),
      }
    }
    catch (err) {
      disposeKv()
      throw err
    }
  }

  async function release() {
    for (const s of [prefill, decode, local, codecSession]) {
      try { await s.release() } catch { /* already released */ }
    }
  }

  return { synthesize, release, heap, manifest, ttsMeta, codecMeta, frameRate: FRAME_RATE, provider, phase: opt.kvGpu ? 'gpu-kv' : 'cpu-io', dtype: opt.dtype }
}

self.wherdrCantoRunner = { createRunner, runnerOptions, heap, CANCELLED }
})()
