// The on-device engine (app/utils/dictation/device.ts) against a worker that
// speaks the dictation worker's protocol; and its model list against the
// fetch script, which must put the same files where the engine looks.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDictationEngineContract } from './dictationEngineContract'
import { createDeviceEngine, openDeviceEngine, WEBGPU_WORKER_URL, WORKER_URL } from '../app/utils/dictation/device'
import { DEVICE_CACHE, DEVICE_MODELS, DEVICE_RUNTIME, IOS_HEAP_BUDGET, ORT_RUNTIME, deviceLanguage, deviceModel, forgetUnsupported, memoryBudget, memoryFit, sentenceCase, unsupportedModels } from '../app/utils/dictation/deviceModels'
import { TAKE_RATE, isAbortError } from '../app/utils/dictation/engine'
import { CHUNK } from '../app/utils/dictation/modelStore'
import { fakeCaches, rangeServer } from './fakeModelCache'
import { DEFAULT_SETS, SETS } from '../scripts/dictation-files.mjs'

const model = { ...DEVICE_MODELS[0]!, files: [{ path: 'a.onnx', bytes: 100 }, { path: 'tokens.txt', bytes: 10 }] }

class FakeWorker {
  static made: FakeWorker[] = []
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: { message: string, preventDefault?: () => void }) => void) | null = null
  got: { t: string, [k: string]: unknown }[] = []
  terminated = false
  constructor(private o: { loadError?: string, decodeError?: string, text?: string, dies?: boolean, holdDecode?: boolean, truncated?: boolean, language?: string } = {}, public url = '') { FakeWorker.made.push(this) }
  private send(data: unknown) { setTimeout(() => !this.terminated && this.onmessage?.({ data }), 1) }
  postMessage(m: { t: string, id?: number, pcm?: ArrayBuffer, files?: string[] }) {
    this.got.push(m)
    if (m.t === 'cancel' || m.t === 'dispose') return
    if (m.t === 'load') {
      if (this.o.loadError) return this.send({ t: 'error', error: this.o.loadError })
      this.send({ t: 'phase', phase: 'fetch' })
      if (this.o.dies) return void setTimeout(() => this.onerror?.({ message: '' }), 2)
      this.send({ t: 'dl', file: 'a.onnx', got: 100, total: 100 })
      this.send({ t: 'dl', file: 'tokens.txt', got: 5, total: 10 })
      this.send({ t: 'ready', ms: 3, heap: 1 })
    }
    else if (this.o.decodeError) this.send({ t: 'error', id: m.id, error: this.o.decodeError })
    else if (!this.o.holdDecode) {
      this.send({ t: 'final', id: m.id, text: this.o.text ?? 'bonjour', ms: 7, heap: 1, ...(this.o.language ? { language: this.o.language } : {}), ...(this.o.truncated !== undefined ? { truncated: this.o.truncated } : {}) })
    }
  }
  terminate() { this.terminated = true }
}

const make = (o: ConstructorParameters<typeof FakeWorker>[0] = {}, m = model) =>
  createDeviceEngine({ model: m, caches: null, worker: url => new FakeWorker(o, url) as unknown as Worker })

// localStorage for the Node tests.
function memoryStorage() {
  const map = new Map<string, string>()
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) }
}
const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' }
const take = () => ({ pcm: new Float32Array(TAKE_RATE).fill(0.5), seconds: 1 })

afterEach(() => {
  FakeWorker.made = []
  for (const id of unsupportedModels()) forgetUnsupported(id)
  vi.unstubAllGlobals()
})

runDictationEngineContract('device', () => make())

describe('the on-device engine', () => {
  it('loads the model once, reports overall download progress, and decodes a copy of the take', async () => {
    const engine = make()
    const seen: unknown[] = []
    await engine.prepare(p => seen.push(p))
    await engine.prepare()
    expect(FakeWorker.made).toHaveLength(1)
    expect(FakeWorker.made[0]!.got[0]).toMatchObject({
      t: 'load', kind: model.kind, base: `/models/${model.dir}`, runtime: `/models/runtime/${DEVICE_RUNTIME}/`, files: ['a.onnx', 'tokens.txt'],
    })
    expect(seen).toEqual([{ phase: 'fetch' }, { phase: 'fetch', got: 100, total: 110 }, { phase: 'fetch', got: 105, total: 110 }])
    const t = take()
    expect(await engine.transcribe(t, { terms: [], signal: new AbortController().signal })).toEqual({ text: 'bonjour', ms: 7 })
    expect(t.pcm.length).toBe(TAKE_RATE) // not detached
    engine.dispose()
    expect(FakeWorker.made[0]!.terminated).toBe(true)
  })

  it('decodes a long take piece by piece, with the text so far after each', async () => {
    const engine = make()
    const partial: string[] = []
    const abort = new AbortController()
    const long = { pcm: new Float32Array(TAKE_RATE * 45).fill(0.5), seconds: 45 }
    expect(await engine.transcribe(long, { terms: [], signal: abort.signal, onPartial: t => partial.push(t) }))
      .toEqual({ text: 'bonjour bonjour bonjour', ms: 21 })
    expect(partial).toEqual(['bonjour', 'bonjour bonjour', 'bonjour bonjour bonjour'])
    // Cancelled during the first piece: the next ones are never sent.
    const run = engine.transcribe(long, { terms: [], signal: abort.signal, onPartial: () => abort.abort() })
    expect(isAbortError(await run.catch(e => e))).toBe(true)
    await new Promise(r => setTimeout(r, 10))
    expect(FakeWorker.made[0]!.got.filter(m => m.t === 'decode')).toHaveLength(4)
  })

  it('downloads into Cache Storage before the worker reads it, or streams it when the quota is full', async () => {
    const caches = fakeCaches()
    const seen: unknown[] = []
    const engine = createDeviceEngine({ model, caches, fetch: rangeServer(model).fetch, worker: () => new FakeWorker() as unknown as Worker })
    await engine.prepare(p => seen.push(p))
    expect(seen.slice(0, 3)).toEqual([{ phase: 'fetch', got: 0, total: 110 }, { phase: 'fetch', got: 100, total: 110 }, { phase: 'fetch', got: 110, total: 110 }])
    expect(FakeWorker.made[0]!.got[0]).toMatchObject({ cache: DEVICE_CACHE, chunk: CHUNK, bytes: [100, 10] })
    vi.stubGlobal('Worker', FakeWorker)
    expect(await engine.readiness()).toEqual({ ready: true })

    const full = fakeCaches()
    const open = full.open.bind(full)
    full.open = async (n: string) => ({ ...(await open(n)), put: async () => { throw new DOMException('full', 'QuotaExceededError') } }) as unknown as Cache
    await createDeviceEngine({ model: { ...model, id: 'q' }, caches: full, fetch: rangeServer(model).fetch, worker: () => new FakeWorker() as unknown as Worker }).prepare()
    expect(FakeWorker.made[1]!.got[0]).toMatchObject({ cache: '' })
  })

  it('fails the load and starts a fresh worker on the next press', async () => {
    const engine = make({ loadError: 'bad tokens.txt' })
    await expect(engine.prepare()).rejects.toThrow('bad tokens.txt')
    await expect(engine.prepare()).rejects.toThrow('bad tokens.txt')
    expect(FakeWorker.made).toHaveLength(2)
    expect(FakeWorker.made[0]!.terminated).toBe(true)
  })

  it('fails softly when the model is too large: out of memory, or the worker dies while loading', async () => {
    vi.stubGlobal('localStorage', memoryStorage())
    const oom = await make({ loadError: 'Aborted(OOM)' }).prepare().catch(e => e)
    expect(oom.name).toBe('ModelTooLarge')
    expect(JSON.parse(localStorage.getItem('dictationTooLarge')!)).toEqual({ [model.id]: 'oom' })
    expect((await make({ dies: true }).prepare().catch(e => e)).name).toBe('ModelTooLarge')
    expect(localStorage.getItem('dictationLoading')).toBeNull()
    // A worker that never started (its file missing) is not a memory problem.
    const silent = createDeviceEngine({ model, caches: null, worker: () => ({ postMessage() { setTimeout(() => this.onerror?.({ message: '' }), 1) }, terminate() {} }) as unknown as Worker })
    expect((await silent.prepare().catch(e => e)).name).toBe('Error')
    // Nor is any other abort: no mark on a weak signal.
    vi.stubGlobal('localStorage', memoryStorage())
    expect((await make({ loadError: 'RuntimeError: Aborted(assertion failed)' }).prepare().catch(e => e)).name).toBe('Error')
    expect(localStorage.getItem('dictationTooLarge')).toBeNull()
  })

  it('puts a capitals-only model in sentence case and tells a model without detection the language', async () => {
    const sense = { ...model, textCase: 'upper' as const }
    // Recorded SenseVoice output (2025-09 int8, ITN on), sherpa-onnx's en.wav.
    const engine = make({ text: 'AK NOT WHAT YOUR COUNTY CAN DO FOR YOU ASK WHAT YOU CAN DO FOR YOUR COUNTRY' }, sense)
    expect((await engine.transcribe(take(), { terms: [], signal: new AbortController().signal })).text)
      .toBe('Ak not what your county can do for you ask what you can do for your country')
    vi.stubGlobal('navigator', { languages: ['fr-FR', 'en'] })
    await make({}, { ...model, kind: 'canary', languages: ['de', 'en', 'es', 'fr'], autoDetect: false }).prepare()
    expect(FakeWorker.made.at(-1)!.got[0]).toMatchObject({ kind: 'canary', language: 'fr' })
    await make().prepare()
    expect(FakeWorker.made.at(-1)!.got[0]).toMatchObject({ language: '' })
  })

  it('says once that the page was killed loading a model, and falls back to one that fits', async () => {
    vi.resetModules()
    vi.stubGlobal('localStorage', memoryStorage())
    vi.stubGlobal('Worker', FakeWorker)
    localStorage.setItem('dictationDeviceModel', 'parakeet-v3')
    localStorage.setItem('dictationLoading', 'parakeet-v3') // never cleared: the page died
    const { createDeviceEngine: create } = await import('../app/utils/dictation/device')
    const engine = create({ caches: null, fetch: async () => new Response(null, { status: 200 }) })
    expect(await engine.readiness()).toEqual({ ready: false, reason: 'too-large', detail: 'Parakeet v3' })
    expect(await engine.readiness()).toEqual({ ready: true })
    expect(engine.caps.languages).toEqual(DEVICE_MODELS.find(m => m.id === 'canary-180m')!.languages)
    expect(localStorage.getItem('dictationLoading')).toBeNull()
    expect(JSON.parse(localStorage.getItem('dictationTooLarge')!)).toEqual({ 'parakeet-v3': 'killed' })
  })

  it('rejects a load still running when disposed', async () => {
    const engine = make()
    const loading = engine.prepare()
    engine.dispose()
    expect(isAbortError(await loading.catch(e => e))).toBe(true)
  })

  it('stops waiting for the server to fetch the files when disposed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let polls = 0
      const fetch = vi.fn(async () => { polls++; return Response.json({ state: 'preparing', phase: 'fetch', got: 1, total: 10 }) })
      const engine = createDeviceEngine({ model, caches: null, fetch, worker: () => new FakeWorker() as unknown as Worker })
      const seen: unknown[] = []
      const loading = engine.prepare(p => seen.push(p))
      await vi.waitFor(() => expect(seen).toEqual([{ phase: 'fetch', got: 1, total: 10, server: true, unpack: false }]))
      engine.dispose()
      expect(isAbortError(await loading.catch(e => e))).toBe(true)
      // Past the next poll (PREPARE_POLL_MS): none is sent.
      await vi.advanceTimersByTimeAsync(1100)
      expect(polls).toBe(1)
      expect(FakeWorker.made).toHaveLength(0)
    } finally { vi.useRealTimers() }
  })

  describe('readiness', () => {
    const head = (status: number) => vi.fn(async () => new Response(null, { status }))
    const cachesWith = (hit: boolean) => ({ open: async () => ({ keys: async () => (hit ? model.files.map(f => ({ url: `http://x/models/${model.dir}/${f.path}` })) : []) }) }) as unknown as CacheStorage

    it('is ready when the model is cached, or when the server has it', async () => {
      vi.stubGlobal('Worker', FakeWorker)
      const fetch = head(404)
      expect(await createDeviceEngine({ model, caches: cachesWith(true), fetch }).readiness()).toEqual({ ready: true })
      expect(fetch).not.toHaveBeenCalled()
      expect(await createDeviceEngine({ model, caches: cachesWith(false), fetch: head(200) }).readiness()).toEqual({ ready: true })
    })

    it('names the missing file, or says offline', async () => {
      vi.stubGlobal('Worker', FakeWorker)
      expect(await createDeviceEngine({ model, caches: null, fetch: head(404) }).readiness())
        .toEqual({ ready: false, reason: 'not-installed', detail: `${model.name}: a.onnx (HTTP 404)` })
      const offline = vi.fn(async () => { throw new TypeError('offline') })
      expect(await createDeviceEngine({ model, caches: null, fetch: offline }).readiness()).toEqual({ ready: false, reason: 'offline' })
    })

    it('is unsupported without workers', async () => {
      vi.stubGlobal('Worker', undefined)
      expect(await createDeviceEngine({ model, caches: null }).readiness()).toEqual({ ready: false, reason: 'unsupported' })
    })

    it('is unsupported for Qwen without WebGPU or without shader-f16', async () => {
      const qwen = DEVICE_MODELS.find(m => m.kind === 'qwen3Q4F16')!
      vi.stubGlobal('Worker', FakeWorker)
      vi.stubGlobal('navigator', {})
      const noGpu = await createDeviceEngine({ model: qwen, caches: null, fetch: head(200) }).readiness()
      expect(noGpu).toMatchObject({ ready: false, reason: 'unsupported' })
      expect((noGpu as { detail?: string }).detail).toContain('webgpu')
      vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ features: new Set() }) } })
      const noF16 = await createDeviceEngine({ model: qwen, caches: null, fetch: head(200) }).readiness()
      expect(noF16).toMatchObject({ ready: false, reason: 'unsupported' })
      expect((noF16 as { detail?: string }).detail).toContain('shader-f16')
      vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } })
      expect(await createDeviceEngine({ model: qwen, caches: null, fetch: head(200) }).readiness()).toEqual({ ready: true })
    })
  })

  it('wires Qwen to the WebGPU worker and ort runtime, passes terms and language, and cancels by id', async () => {
    const qwen = { ...DEVICE_MODELS.find(m => m.kind === 'qwen3Q4F16')!, files: model.files }
    for (const m of DEVICE_MODELS) {
      expect(createDeviceEngine({ model: m, caches: null }).caps.terms).toBe(m.kind === 'qwen3Q4F16')
    }
    const cpu = make()
    await cpu.prepare()
    expect(FakeWorker.made[0]!.url).toBe(WORKER_URL)

    const engine = make({ text: 'salut wherdr', language: 'fr', truncated: true }, qwen)
    await engine.prepare()
    const w = FakeWorker.made[1]!
    expect(w.url).toBe(WEBGPU_WORKER_URL)
    expect(w.got[0]).toMatchObject({
      t: 'load', kind: 'qwen3Q4F16', base: `/models/${qwen.dir}`, runtime: `/models/runtime/${ORT_RUNTIME}/`,
    })

    const res = await engine.transcribe(take(), { terms: ['wherdr', 'qwen3'], language: 'fr', signal: new AbortController().signal })
    expect(res).toEqual({ text: 'salut wherdr', ms: 7 })
    expect(w.got[1]).toMatchObject({ t: 'decode', id: 1, terms: ['wherdr', 'qwen3'], language: 'fr' })

    // Aborting an in-flight decode posts cancel with that request's id.
    const held = make({ holdDecode: true }, qwen)
    await held.prepare()
    const abort = new AbortController()
    const running = held.transcribe(take(), { terms: ['pane'], signal: abort.signal })
    await vi.waitFor(() => expect(FakeWorker.made[2]!.got.some(m => m.t === 'decode')).toBe(true))
    abort.abort()
    expect(isAbortError(await running.catch(e => e))).toBe(true)
    expect(FakeWorker.made[2]!.got.at(-1)).toEqual({ t: 'cancel', id: 1 })
  })

  it('marks only Unsupported speech device for the page, leaves GPU loss retryable, and probes WebGPU only when a GPU model is saved', async () => {
    vi.stubGlobal('localStorage', memoryStorage())
    vi.stubGlobal('Worker', FakeWorker)
    const qwen = { ...DEVICE_MODELS.find(m => m.kind === 'qwen3Q4F16')!, files: model.files }
    localStorage.setItem('dictationDeviceModel', qwen.id)

    const unsupportedLoad = await make({ loadError: 'Unsupported speech device: WebGPU and shader-f16 required' }, qwen).prepare().catch(e => e)
    expect(unsupportedLoad.name).toBe('DeviceUnsupported')
    expect(unsupportedModels().has(qwen.id)).toBe(true)
    expect(localStorage.getItem('dictationTooLarge')).toBeNull()
    expect(localStorage.getItem('dictationDeviceModel')).toBe(qwen.id)

    // While marked unsupported for this page, readiness answers 'unsupported',
    // openDeviceEngine() skips probing WebGPU and falls back to CPU (parakeet-v3).
    const requestAdapter = vi.fn(async () => ({ features: new Set<string>(['shader-f16']) }))
    vi.stubGlobal('navigator', { gpu: { requestAdapter } })
    expect(await make({}, qwen).readiness()).toEqual({ ready: false, reason: 'unsupported', detail: qwen.name })
    requestAdapter.mockClear()
    const fallback = await openDeviceEngine()
    expect(fallback.caps.terms).toBe(false)
    expect(fallback.caps.languages).toEqual(DEVICE_MODELS.find(m => m.id === 'parakeet-v3')!.languages)
    expect(requestAdapter).not.toHaveBeenCalled()

    // Clearing the mark allows Qwen again, and probing still runs only when Qwen is saved.
    forgetUnsupported(qwen.id)
    expect(unsupportedModels().has(qwen.id)).toBe(false)

    // GPU loss and unexpected-device errors stay plain Errors and never mark Qwen unsupported.
    const lostLoad = await make({ loadError: 'Speech GPU device lost' }, qwen).prepare().catch(e => e)
    expect(lostLoad.name).toBe('Error')
    expect(lostLoad.message).toBe('Speech GPU device lost')
    expect(unsupportedModels().has(qwen.id)).toBe(false)

    const unexpectedLoad = await make({ loadError: 'Speech runtime used an unexpected GPU device' }, qwen).prepare().catch(e => e)
    expect(unexpectedLoad.name).toBe('Error')
    expect(unexpectedLoad.message).toBe('Speech runtime used an unexpected GPU device')
    expect(unsupportedModels().has(qwen.id)).toBe(false)

    const lost = make({ decodeError: 'Speech GPU device lost' }, qwen)
    const decodeErr = await lost.transcribe(take(), { terms: [], signal: new AbortController().signal }).catch(e => e)
    expect(decodeErr.name).toBe('Error')
    expect(decodeErr.message).toBe('Speech GPU device lost')
    expect(unsupportedModels().has(qwen.id)).toBe(false)
    expect(localStorage.getItem('dictationTooLarge')).toBeNull()

    localStorage.removeItem('dictationDeviceModel')
    // Default and CPU choices never request a WebGPU adapter on open.
    expect((await openDeviceEngine()).caps.terms).toBe(false)
    localStorage.setItem('dictationDeviceModel', 'sensevoice')
    expect((await openDeviceEngine()).caps.terms).toBe(false)
    expect(requestAdapter).not.toHaveBeenCalled()

    localStorage.setItem('dictationDeviceModel', qwen.id)
    requestAdapter.mockResolvedValueOnce({ features: new Set<string>() })
    expect((await openDeviceEngine()).caps.terms).toBe(false)
    expect(requestAdapter).toHaveBeenCalledTimes(1)
    requestAdapter.mockResolvedValueOnce({ features: new Set(['shader-f16']) })
    expect((await openDeviceEngine()).caps.terms).toBe(true)
    expect(requestAdapter).toHaveBeenCalledTimes(2)
  })

  it('resets the worker on idle Speech GPU device lost without marking Qwen unsupported, and reloads cleanly on the next press', async () => {
    vi.stubGlobal('localStorage', memoryStorage())
    vi.stubGlobal('Worker', FakeWorker)
    const qwen = { ...DEVICE_MODELS.find(m => m.kind === 'qwen3Q4F16')!, files: model.files }
    localStorage.setItem('dictationDeviceModel', qwen.id)
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } })

    const engine = make({}, qwen)
    await engine.prepare()
    expect(FakeWorker.made).toHaveLength(1)
    expect(FakeWorker.made[0]!.url).toBe(WEBGPU_WORKER_URL)

    // Idle GPU loss (e.g. Android PWA backgrounded) terminates the worker without marking unsupported.
    FakeWorker.made[0]!.onmessage!({ data: { t: 'error', error: 'Speech GPU device lost' } })
    expect(FakeWorker.made[0]!.terminated).toBe(true)
    expect(unsupportedModels().has(qwen.id)).toBe(false)

    // Next press still picks Qwen and reloads it in a fresh WebGPU worker.
    expect((await openDeviceEngine()).caps.terms).toBe(true)
    await engine.prepare()
    expect(FakeWorker.made).toHaveLength(2)
    expect(FakeWorker.made[1]!.url).toBe(WEBGPU_WORKER_URL)
    expect(await engine.transcribe(take(), { terms: [], signal: new AbortController().signal }))
      .toEqual({ text: 'bonjour', ms: 7 })
  })

  it('forgets the unsupported mark on page reload so saved Qwen is picked again', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    const qwen = DEVICE_MODELS.find(m => m.kind === 'qwen3Q4F16')!
    storage.setItem('dictationDeviceModel', qwen.id)
    await make({ loadError: 'Unsupported speech device: WebGPU and shader-f16 required' }, { ...qwen, files: model.files }).prepare().catch(() => {})
    expect(unsupportedModels().has(qwen.id)).toBe(true)

    vi.resetModules()
    vi.stubGlobal('localStorage', storage)
    const reloaded = await import('../app/utils/dictation/deviceModels')
    expect(reloaded.unsupportedModels().size).toBe(0)
    expect(reloaded.deviceModel(storage.getItem('dictationDeviceModel'), null, {}, ['webgpu', 'shader-f16']).id).toBe(qwen.id)
  })
})

describe('device models', () => {
  it('match what the fetch script downloads, Parakeet v3 by default', () => {
    for (const m of DEVICE_MODELS) {
      expect(SETS[m.runtime]).toBeDefined()
      if ('url' in m.source) {
        const [entry] = SETS[m.set]
        expect(entry.dir).toBe(m.dir)
        expect([...entry.members].sort()).toEqual(m.files.map(f => f.path).sort())
      }
      else {
        expect(SETS[m.set]).toEqual(m.files.map(f => ({ url: m.source.base + f.path, sha256: f.sha256, to: `${m.dir}/${f.path}` })))
      }
    }
    expect(SETS.runtime[0].to).toContain(`runtime/${DEVICE_RUNTIME}/`)
    expect(DEFAULT_SETS).toEqual(['runtime', DEVICE_MODELS[0]!.set])
    expect(DEVICE_MODELS[0]!.languages).toEqual(expect.arrayContaining(['fr', 'en']))
    expect(deviceModel('sensevoice').id).toBe('sensevoice')
    expect(deviceModel('gone').id).toBe('parakeet-v3')
  })

  it('keeps GPU models opt-in: never the default or fallback, and honoured only with GPU features and budget', () => {
    const qwen = DEVICE_MODELS.find(m => m.kind === 'qwen3Q4F16')!
    expect(qwen.requires).toEqual(['webgpu', 'shader-f16'])
    expect(qwen.memory).toBeDefined()
    expect(qwen.memory!.heap).toBe(1_000_000_000)
    expect(qwen.memory!.peak).toBeUndefined()
    expect(qwen.memory!.basis).toMatch(/estimated/i)
    expect(qwen.memory!.basis).toMatch(/not measured/i)

    const gpu = ['webgpu', 'shader-f16'] as const
    expect(deviceModel(null, null, {}, gpu).id).toBe('parakeet-v3')
    expect(deviceModel('gone', null, {}, gpu).id).toBe('parakeet-v3')
    expect(deviceModel('parakeet-v3', IOS_HEAP_BUDGET, {}, gpu).id).toBe('canary-180m')
    expect(deviceModel(null, null, { 'parakeet-v3': 'oom', 'canary-180m': 'oom', 'sensevoice': 'oom' }, gpu).id).toBe('parakeet-v3')
    expect(deviceModel(qwen.id, null, {}, gpu).id).toBe(qwen.id)
    expect(deviceModel(qwen.id, null, { [qwen.id]: 'oom' }, gpu).id).toBe('parakeet-v3')
    expect(deviceModel(qwen.id, null, {}, gpu, new Set([qwen.id])).id).toBe('parakeet-v3')
    expect(deviceModel(qwen.id).id).toBe('parakeet-v3')
    expect(deviceModel(qwen.id, null, {}, ['webgpu']).id).toBe('parakeet-v3')
    expect(deviceModel(qwen.id, IOS_HEAP_BUDGET, {}, []).id).toBe('canary-180m')

    // Budget checks keep Qwen off iOS and <= 2 GB Android, while allowing 4 GB and 8 GB devices.
    const budgetIos = memoryBudget(IPHONE)!
    const budget2 = memoryBudget({ userAgent: 'Mozilla/5.0 (Linux; Android 14)', deviceMemory: 2 })!
    const budget4 = memoryBudget({ userAgent: 'Mozilla/5.0 (Linux; Android 14)', deviceMemory: 4 })!
    const budget8 = memoryBudget({ userAgent: 'Mozilla/5.0 (Linux; Android 14)', deviceMemory: 8 })!
    expect(memoryFit(qwen, budgetIos, {})).toBe('budget')
    expect(deviceModel(qwen.id, budgetIos, {}, gpu).id).toBe('canary-180m')
    expect(memoryFit(qwen, budget2, {})).toBe('budget')
    expect(deviceModel(qwen.id, budget2, {}, gpu).id).toBe('canary-180m')
    expect(memoryFit(qwen, budget4, {})).toBe('ok')
    expect(deviceModel(qwen.id, budget4, {}, gpu).id).toBe(qwen.id)
    expect(memoryFit(qwen, budget8, {})).toBe('ok')
    expect(deviceModel(qwen.id, budget8, {}, gpu).id).toBe(qwen.id)
  })

  it('carry their measured memory, checked against this device\'s budget', () => {
    for (const m of DEVICE_MODELS.filter(m => !m.requires.length)) expect(m.memory!.heap).toBeGreaterThan(0)
    expect(memoryBudget(IPHONE)).toBe(IOS_HEAP_BUDGET)
    expect(memoryBudget({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(IOS_HEAP_BUDGET) // iPad
    expect(memoryBudget({ userAgent: 'Mozilla/5.0 (Linux; Android 14)', deviceMemory: 4 })).toBe(2 ** 30)
    expect(memoryBudget({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBeNull()
    const parakeet = DEVICE_MODELS.find(m => m.id === 'parakeet-v3')!
    expect(memoryFit(parakeet, IOS_HEAP_BUDGET, {})).toBe('budget')
    expect(memoryFit(parakeet, null, { 'parakeet-v3': 'killed' })).toBe('killed')
    expect(memoryFit(parakeet, null, { 'parakeet-v3': 'oom' })).toBe('oom')
    // Too large is never chosen: an iPhone gets Canary, even with Parakeet saved.
    expect(deviceModel(null, IOS_HEAP_BUDGET, {}).id).toBe('canary-180m')
    expect(deviceModel('parakeet-v3', IOS_HEAP_BUDGET, {}).id).toBe('canary-180m')
    expect(deviceModel('sensevoice', IOS_HEAP_BUDGET, {}).id).toBe('sensevoice')
    expect(deviceModel(null, null, { 'parakeet-v3': 'killed' }).id).toBe('canary-180m')
    expect(deviceModel(null, null, {}).id).toBe('parakeet-v3')
  })

  it('pick the device\'s language for a model without detection', () => {
    const canary = DEVICE_MODELS.find(m => m.id === 'canary-180m')!
    expect(deviceLanguage(canary, ['fr-FR', 'en-US'])).toBe('fr')
    expect(deviceLanguage(canary, ['ja-JP', 'es'])).toBe('es')
    expect(deviceLanguage(canary, ['ja-JP'])).toBe('en')
  })

  it('put capitals-only text in sentence case and keep any other', () => {
    expect(sentenceCase('I THINK I\'M DONE. OK THEN')).toBe('I think I\'m done. Ok then')
    expect(sentenceCase('Already fine, NASA.')).toBe('Already fine, NASA.')
    expect(sentenceCase('你好')).toBe('你好')
  })
})
