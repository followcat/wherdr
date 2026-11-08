import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
type Message = { t: string, id?: number, [key: string]: unknown }
type Stage = 'encoder' | 'init' | 'step'

// Real worker, downloader and numeric/text helpers; only GPU and ORT are fake.
function harness() {
  const config = {
    layout_version: 2, variants: { q4f16: { encoder: 'encoder.onnx', decoder_init: 'init.onnx', decoder_step: 'step.onnx', weights: 'weights.data' } },
    mel: { filters_file: 'mel.json', drop_last_frame: true }, decoder: { hidden_size: 2, vocab_size: 256 },
    embedding: { file: 'embed.bin', scales_file: 'scales.bin' },
    prompt: { prefix_ids: [1, 2, 251, 3], suffix_ids: [4], audio_pad_id: 5, asr_text_id: 252, eos_ids: [251], max_new_tokens: 8 },
    language_prefix_ids: { en: [6, 252] },
  }
  const printable = (b: number) => (b >= 33 && b <= 126) || (b >= 161 && b <= 172) || b >= 174
  let extra = 256
  const vocab = Object.fromEntries(Array.from({ length: 256 }, (_, b) => [String.fromCharCode(printable(b) ? b : extra++), b]))
  const tokenizer = {
    normalizer: { type: 'NFC' },
    pre_tokenizer: { type: 'Sequence', pretokenizers: [
      { type: 'Split', pattern: { Regex: '[\\s\\S]+' }, behavior: 'Isolated', invert: false },
      { type: 'ByteLevel', add_prefix_space: false, use_regex: false },
    ] }, model: { vocab, merges: [] }, added_tokens: [],
  }
  const embedding = Int8Array.from({ length: 512 }, (_, i) => i % 127)
  const scales = new Float32Array(256).fill(0.01)
  const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
  const files = new Map<string, Uint8Array>([
    ['prompt_config.json', encode(config)], ['tokenizer.json', encode(tokenizer)],
    ['mel.json', encode({ n_mels: 1, data: [Array.from({ length: 201 }, (_, k) => k === 1 ? 1 : 0)] })],
    ['embed.bin', new Uint8Array(embedding.buffer)], ['scales.bin', new Uint8Array(scales.buffer)],
    ['weights.data', new Uint8Array([1])], ['encoder.onnx', new Uint8Array([1])],
    ['init.onnx', new Uint8Array([2])], ['step.onnx', new Uint8Array([3])],
  ])
  const messages: Message[] = [], tensors: Tensor[] = [], sessions: { kind: Stage, released: number }[] = []
  const devices: { lost: Promise<void>, loss: ReturnType<typeof deferred>, destroy: ReturnType<typeof vi.fn>, features: Set<string> }[] = []
  const calls: { kind: Stage, feeds: Record<string, Tensor> }[] = []
  let sequence = [111, 107, 251], token = 0, inFlight = 0, maxInFlight = 0
  let failRun: Stage | undefined, failCreate: Stage | undefined, missingGpu = false, missingF16 = false, rejectAdapter = false
  let precision = 'float16', failRelease = false
  let onLoaded: (() => void) | undefined
  let gate: { kind: Stage, started: ReturnType<typeof deferred>, done: ReturnType<typeof deferred> } | undefined
  class Tensor {
    disposed = 0
    location = 'cpu'
    constructor(public type: string, public data: Float32Array | Uint16Array | BigInt64Array, public dims: number[]) { tensors.push(this) }
    async getData() { return this.data }
    dispose() { this.disposed++ }
  }
  const gpuTensor = () => { const t = new Tensor('float16', new Uint16Array([0]), [1]); t.location = 'gpu-buffer'; return t }
  const env: { wasm: Record<string, unknown>, webgpu: { device?: typeof devices[number], [key: string]: unknown } } = { wasm: {}, webgpu: {} }
  const fakeOrt = {
    env, Tensor,
    InferenceSession: { create: vi.fn(async (bytes: Uint8Array, options: { executionProviders: string[], preferredOutputLocation?: unknown, externalData?: { path: string, data: Uint8Array }[] }) => {
      const kind = (['encoder', 'init', 'step'] as Stage[])[bytes[0]! - 1]!
      // Model ORT 1.23.2's native adapter/device acquisition. The custom
      // device option is deliberately forbidden: real inference fails there.
      expect(options.executionProviders).toEqual(['webgpu'])
      if (!env.webgpu.device) {
        const checked = await ctx.navigator.gpu.requestAdapter()
        env.webgpu.device = await checked.requestDevice({ requiredFeatures: [] })
      }
      if (kind === failCreate) { failCreate = undefined; throw new Error('synthetic create failure') }
      if (kind !== 'encoder') {
        expect(options.preferredOutputLocation).toEqual({ present_keys: 'gpu-buffer', present_values: 'gpu-buffer' })
        expect(options.externalData?.[0]?.path).toBe('weights.data')
        expect(Array.from(options.externalData![0]!.data)).toEqual([1])
      }
      const record = { kind, released: 0 }; sessions.push(record)
      return {
        inputNames: kind === 'encoder' ? ['mel'] : ['input_embeds', 'position_ids'],
        get inputMetadata() {
          // The last synchronous initialization work, before load's await resumes.
          if (kind === 'step') { const callback = onLoaded; onLoaded = undefined; callback?.() }
          return [{ type: precision }, { type: 'int64' }]
        },
        release: async () => { record.released++; if (failRelease) { failRelease = false; throw new Error('synthetic release failure') } },
        run: async (feeds: Record<string, Tensor>) => {
          calls.push({ kind, feeds }); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
          try {
            if (gate?.kind === kind) { const g = gate; gate = undefined; g.started.resolve(); await g.done.promise }
            if (kind === failRun) { failRun = undefined; throw new Error('synthetic run failure') }
            if (kind === 'encoder') return { audio_features: new Tensor(precision, precision === 'float16' ? new Uint16Array([0x3c00, 0x4000]) : new Float32Array([1, 2]), [1, 1, 2]) }
            if (kind === 'init') token = 0
            else {
              expect(feeds.past_keys!.disposed).toBe(0)
              expect(feeds.past_values!.disposed).toBe(0)
              expect(feeds.past_keys!.location).toBe('gpu-buffer')
            }
            const logits = precision === 'float16' ? new Uint16Array(256) : new Float32Array(256)
            logits[sequence[Math.min(token++, sequence.length - 1)]!] = precision === 'float16' ? 0x3c00 : 1
            return { logits: new Tensor(precision, logits, [1, 1, 256]), present_keys: gpuTensor(), present_values: gpuTensor() }
          } finally { inFlight-- }
        },
      }
    }) },
  }
  const adapter = {
    features: { has: () => !missingF16 },
    requestDevice: vi.fn(async () => {
      const loss = deferred(), destroy = vi.fn(() => loss.resolve())
      const device = { lost: loss.promise, destroy, loss, features: new Set(['shader-f16']) }
      devices.push(device)
      return device
    }),
  }
  const nativeDeviceRequest = adapter.requestDevice
  const ctx = vm.createContext({ TextEncoder, TextDecoder, Response, ReadableStream, performance, setTimeout,
    navigator: { gpu: { requestAdapter: async () => { if (rejectAdapter) throw new Error('synthetic adapter failure'); return missingGpu ? null : adapter } } },
    fetch: vi.fn(async (url: string) => {
      const name = url.slice(url.lastIndexOf('/') + 1), data = files.get(name)
      return new Response(data as BodyInit, { status: data ? 200 : 404, headers: { 'content-length': String(data?.length || 0) } })
    }),
    postMessage: (msg: Message) => { messages.push(msg) },
  })
  ctx.self = ctx
  ctx.importScripts = (...urls: string[]) => {
    for (const url of urls) {
      if (url.endsWith('ort.webgpu.min.js')) { env.wasm = {}; env.webgpu = {}; ctx.ort = fakeOrt }
      else vm.runInContext(readFileSync(new URL('../public' + url, import.meta.url), 'utf8'), ctx, { filename: url })
    }
  }
  vm.runInContext(readFileSync(new URL('../public/workers/dictation-webgpu-worker.js', import.meta.url), 'utf8'), ctx)
  const send = (data: Message) => ctx.onmessage({ data })
  const load = () => send({ t: 'load', runtime: '/models/runtime/ort/', base: '/models/example', kind: 'qwen3Q4F16', files: [...files.keys()], bytes: [...files.values()].map(v => v.length), chunk: 8 * 1024 * 1024, cache: '' })
  return {
    messages, tensors, sessions, devices, calls, files, fakeOrt, adapter, nativeDeviceRequest,
    send, load, idle: () => vm.runInContext('queue', ctx) as Promise<void>,
    decode: (id: number, opts = {}) => send({ t: 'decode', id, pcm: new Float32Array(160).buffer, ...opts }),
    sequence: (ids: number[]) => { sequence = ids },
    failRun: (stage: Stage) => { failRun = stage }, failCreate: (stage: Stage) => { failCreate = stage },
    precision: (type: string) => { precision = type }, failRelease: () => { failRelease = true },
    gpu: (value: 'missing' | 'no-f16' | 'reject') => { missingGpu = value === 'missing'; missingF16 = value === 'no-f16'; rejectAdapter = value === 'reject' },
    gate: (kind: Stage) => { const g = { kind, started: deferred(), done: deferred() }; gate = g; return g },
    maxInFlight: () => maxInFlight,
    lose: () => devices.at(-1)!.loss.resolve(),
    onLoaded: (callback: () => void) => { onLoaded = callback },
    setBudget: (n: number) => { config.prompt.max_new_tokens = n; files.set('prompt_config.json', encode(config)) },
  }
}

describe('the ORT WebGPU worker', () => {
  it('loads the pinned-layout files and decodes terms, audio and a forced language with fp16 tensors', async () => {
    const h = harness(); h.load(); await h.idle()
    expect(h.messages.filter(m => m.t === 'phase').map(m => m.phase)).toEqual(['runtime', 'fetch', 'create'])
    expect(h.messages.some(m => m.t === 'ready')).toBe(true)
    expect(h.nativeDeviceRequest).toHaveBeenCalledWith({ requiredFeatures: ['shader-f16'] })
    expect(h.fakeOrt.env.wasm).toEqual({ wasmPaths: '/models/runtime/ort/', numThreads: 1, proxy: false })
    h.decode(1, { terms: ['alpha'], language: 'en' }); await h.idle()
    expect(h.messages.find(m => m.t === 'final')).toMatchObject({ id: 1, text: 'ok', truncated: false })
    const init = h.calls.find(c => c.kind === 'init')!.feeds
    // 4 prefix + 5 term bytes + 1 audio + 1 suffix + 2 language tokens.
    expect(init.position_ids!.dims).toEqual([1, 13])
    expect([...init.position_ids!.data]).toEqual(Array.from({ length: 13 }, (_, i) => BigInt(i)))
    expect(init.input_embeds!.type).toBe('float16')
    expect([...init.input_embeds!.data].slice(18, 20)).toEqual([0x3c00, 0x4000])
    expect(h.tensors.every(t => t.disposed === 1)).toBe(true)
    h.send({ t: 'dispose' }); await h.idle(); h.send({ t: 'dispose' }); await h.idle()
    expect(h.sessions.every(s => s.released === 1)).toBe(true)
    expect(h.devices[0]!.destroy).toHaveBeenCalledTimes(1)
    expect(h.adapter.requestDevice).toBe(h.nativeDeviceRequest)
  })
  it.each(['missing', 'no-f16', 'reject'] as const)('fails cleanly on %s GPU capability', async mode => {
    const h = harness(); h.gpu(mode); h.load(); await h.idle()
    expect(h.messages.some(m => m.t === 'error')).toBe(true)
    expect(h.fakeOrt.InferenceSession.create).not.toHaveBeenCalled()
  })
  it('reports loss at the load completion boundary without publishing ready, then reloads on a fresh device', async () => {
    const h = harness(); h.onLoaded(h.lose); h.load(); await h.idle(); await h.idle()
    expect(h.messages.filter(m => m.t === 'ready' || m.t === 'error')).toEqual([
      expect.objectContaining({ t: 'error', error: 'Speech GPU device lost' }),
    ])
    expect(h.sessions.map(s => s.released)).toEqual([1, 1, 1])
    expect(h.devices[0]!.destroy).toHaveBeenCalledOnce()
    expect(h.adapter.requestDevice).toBe(h.nativeDeviceRequest)
    h.load(); await h.idle(); await h.idle()
    expect(h.messages.filter(m => m.t === 'ready')).toHaveLength(1)
    expect(h.sessions.slice(3).map(s => s.released)).toEqual([0, 0, 0])
    h.decode(1); await h.idle()
    expect(h.messages.find(m => m.id === 1)).toMatchObject({ t: 'final', text: 'ok' })
    h.send({ t: 'dispose' }); await h.idle()
    expect(h.sessions.map(s => s.released)).toEqual([1, 1, 1, 1, 1, 1])
    expect(h.devices).toHaveLength(2)
    for (const device of h.devices) expect(device.destroy).toHaveBeenCalledOnce()
    expect(h.tensors.every(t => t.disposed === 1)).toBe(true)
  })
  it.each([false, true])('handles completion loss during automatic reload with cancellation=%s', async cancelled => {
    const h = harness(); h.load(); await h.idle()
    h.lose(); await Promise.resolve(); await h.idle(); h.messages.length = 0
    h.onLoaded(() => { h.lose(); if (cancelled) h.send({ t: 'cancel', id: 1 }) })
    h.decode(1); h.decode(2); h.send({ t: 'cancel', id: 2 }); await h.idle(); await h.idle()
    expect(h.messages.filter(m => ['ready', 'final', 'error'].includes(m.t))).toEqual(cancelled ? [] : [
      expect.objectContaining({ t: 'error', id: 1, error: 'Speech GPU device lost' }),
    ])
    expect(h.calls).toHaveLength(0)
    expect(h.sessions.map(s => s.released)).toEqual([1, 1, 1, 1, 1, 1])
    for (const device of h.devices) expect(device.destroy).toHaveBeenCalledOnce()
    h.decode(3); await h.idle(); await h.idle()
    expect(h.messages.find(m => m.id === 3)).toMatchObject({ t: 'final', text: 'ok' })
    expect(h.devices).toHaveLength(3)
    expect(h.sessions.slice(6).map(s => s.released)).toEqual([0, 0, 0])
    h.send({ t: 'dispose' }); await h.idle()
    expect(h.sessions.every(s => s.released === 1)).toBe(true)
    for (const device of h.devices) expect(device.destroy).toHaveBeenCalledOnce()
    expect(h.tensors.every(t => t.disposed === 1)).toBe(true)
  })
  it('strips the automatic language header and reports token exhaustion', async () => {
    const h = harness(); h.load(); await h.idle()
    h.sequence([6, 252, 111, 107, 251]); h.decode(1); await h.idle()
    expect(h.messages.find(m => m.t === 'final')).toMatchObject({ text: 'ok', language: 'en', truncated: false })
    h.setBudget(3); h.load(); await h.idle()
    h.sequence([111]); h.decode(2); await h.idle()
    expect(h.messages.find(m => m.id === 2)).toMatchObject({ text: 'ooo', truncated: true })
    expect(h.tensors.every(t => t.disposed === 1)).toBe(true)
  })
  it('cancels an active request by id and serializes an immediate new take', async () => {
    const h = harness(); h.load(); await h.idle()
    const gate = h.gate('step'); h.decode(1); await gate.started.promise
    h.send({ t: 'cancel', id: 1 }); h.decode(2)
    gate.done.resolve(); await h.idle()
    expect(h.messages.filter(m => m.t === 'final' || m.t === 'error')).toEqual([expect.objectContaining({ t: 'final', id: 2, text: 'ok' })])
    expect(h.maxInFlight()).toBe(1)
    expect(h.tensors.every(t => t.disposed === 1)).toBe(true)
  })
  it('drops a queued cancellation without cancelling a different request', async () => {
    const h = harness(); h.load(); await h.idle()
    const gate = h.gate('encoder'); h.decode(1); await gate.started.promise
    h.decode(2); h.send({ t: 'cancel', id: 2 }); h.send({ t: 'cancel', id: 99 })
    gate.done.resolve(); await h.idle()
    expect(h.messages.filter(m => m.t === 'final').map(m => m.id)).toEqual([1])
    expect(h.calls.filter(c => c.kind === 'encoder')).toHaveLength(1)
  })
  it.each(['encoder', 'init', 'step'] as const)('cleans up a failed %s run and reloads for the next request', async stage => {
    const h = harness(); h.load(); await h.idle()
    h.failRun(stage); h.decode(1); await h.idle()
    expect(h.messages.find(m => m.id === 1)).toMatchObject({ t: 'error', error: 'synthetic run failure' })
    expect(h.tensors.every(t => t.disposed === 1)).toBe(true)
    expect(h.sessions.every(s => s.released === 1)).toBe(true)
    h.decode(2); await h.idle()
    expect(h.messages.find(m => m.id === 2)).toMatchObject({ t: 'final', text: 'ok' })
    expect(h.devices).toHaveLength(2)
  })
  it.each(['encoder', 'init', 'step'] as const)('releases partial initialization after a failed %s create', async stage => {
    const h = harness(); h.failCreate(stage); h.load(); await h.idle()
    expect(h.messages.some(m => m.t === 'error')).toBe(true)
    expect(h.sessions.every(s => s.released === 1)).toBe(true)
    expect(h.devices[0]!.destroy).toHaveBeenCalledOnce()
    h.load(); await h.idle(); h.decode(1); await h.idle()
    expect(h.messages.find(m => m.id === 1)).toMatchObject({ t: 'final', text: 'ok' })
  })
  it('recovers from device loss during a run without releasing an in-flight session', async () => {
    const h = harness(); h.load(); await h.idle()
    const gate = h.gate('step'); h.decode(1); await gate.started.promise
    h.lose(); await Promise.resolve()
    expect(h.sessions.every(s => s.released === 0)).toBe(true)
    gate.done.resolve(); await h.idle()
    expect(h.messages.find(m => m.id === 1)).toMatchObject({ t: 'error', error: 'Speech GPU device lost' })
    expect(h.tensors.every(t => t.disposed === 1)).toBe(true)
    expect(h.sessions.every(s => s.released === 1)).toBe(true)
    h.decode(2); await h.idle()
    expect(h.messages.find(m => m.id === 2)).toMatchObject({ t: 'final', text: 'ok' })
  })
  it('disposes after a running request and can load again', async () => {
    const h = harness(); h.load(); await h.idle()
    const gate = h.gate('encoder'); h.decode(1); await gate.started.promise
    h.send({ t: 'dispose' }); gate.done.resolve(); await h.idle()
    expect(h.messages.filter(m => m.id === 1)).toEqual([])
    expect(h.sessions.every(s => s.released === 1)).toBe(true)
    expect(h.tensors.every(t => t.disposed === 1)).toBe(true)
    h.load(); await h.idle(); h.decode(2); await h.idle()
    expect(h.messages.find(m => m.id === 2)).toMatchObject({ t: 'final', text: 'ok' })
  })
  it('uses float32 inputs and logits when declared by session metadata', async () => {
    const h = harness(); h.precision('float32'); h.load(); await h.idle(); h.decode(1); await h.idle()
    expect(h.messages.find(m => m.id === 1)).toMatchObject({ t: 'final', text: 'ok' })
    expect(h.calls.find(c => c.kind === 'encoder')!.feeds.mel!.type).toBe('float32')
    expect(h.calls.find(c => c.kind === 'init')!.feeds.input_embeds!.type).toBe('float32')
    expect(h.tensors.every(t => t.disposed === 1)).toBe(true)
  })
  it('rejects a short model file and can retry the load', async () => {
    const h = harness(); h.load()
    h.files.set('weights.data', new Uint8Array())
    await h.idle()
    expect(h.messages.find(m => m.t === 'error')!.error).toContain('Invalid speech model file size')
    expect(h.sessions).toHaveLength(0)
    expect(h.devices).toHaveLength(0) // reject before native runtime initialization
    expect(h.adapter.requestDevice).toBe(h.nativeDeviceRequest)
    h.files.set('weights.data', new Uint8Array([1])); h.load(); await h.idle()
    expect(h.messages.some(m => m.t === 'ready')).toBe(true)
  })
  it('releases every session even if one release rejects', async () => {
    const h = harness(); h.load(); await h.idle(); h.failRelease()
    h.send({ t: 'dispose' }); await h.idle()
    expect(h.sessions.every(s => s.released === 1)).toBe(true)
    expect(h.devices[0]!.destroy).toHaveBeenCalledOnce()
    h.load(); await h.idle()
    expect(h.devices).toHaveLength(2)
  })
  it('releases an idle lost device and reloads on the next request', async () => {
    const h = harness(); h.load(); await h.idle()
    h.lose(); await Promise.resolve(); await h.idle()
    expect(h.messages.find(m => m.t === 'error')).toMatchObject({ error: 'Speech GPU device lost' })
    expect(h.sessions.every(s => s.released === 1)).toBe(true)
    h.decode(1); await h.idle()
    expect(h.messages.find(m => m.id === 1)).toMatchObject({ t: 'final', text: 'ok' })
  })
  it('serializes a replacement load and suppresses the old take', async () => {
    const h = harness(); h.load(); await h.idle()
    const gate = h.gate('init'); h.decode(1); await gate.started.promise
    h.load(); h.decode(2); gate.done.resolve(); await h.idle()
    expect(h.messages.filter(m => m.id === 1)).toEqual([])
    expect(h.messages.find(m => m.id === 2)).toMatchObject({ t: 'final', text: 'ok' })
    expect(h.devices).toHaveLength(2)
    expect(h.sessions.slice(0, 3).every(s => s.released === 1)).toBe(true)
    expect(h.tensors.every(t => t.disposed === 1)).toBe(true)
    expect(h.maxInFlight()).toBe(1)
  })
  it('reports a decode before load without poisoning later requests', async () => {
    const h = harness(); h.decode(1); await h.idle()
    expect(h.messages.find(m => m.id === 1)).toMatchObject({ t: 'error', error: 'No speech model loaded' })
    h.load(); await h.idle(); h.decode(2); await h.idle()
    expect(h.messages.find(m => m.id === 2)).toMatchObject({ t: 'final', text: 'ok' })
  })
})
