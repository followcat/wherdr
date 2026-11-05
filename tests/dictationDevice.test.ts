// The on-device engine (app/utils/dictation/device.ts) against a worker that
// speaks the dictation worker's protocol; and its model list against the
// fetch script, which must put the same files where the engine looks.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runDictationEngineContract } from './dictationEngineContract'
import { createDeviceEngine } from '../app/utils/dictation/device'
import { DEVICE_CACHE, DEVICE_MODELS, DEVICE_RUNTIME, IOS_HEAP_BUDGET, deviceLanguage, deviceModel, memoryBudget, memoryFit, sentenceCase } from '../app/utils/dictation/deviceModels'
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
  constructor(private o: { loadError?: string, text?: string, dies?: boolean } = {}) { FakeWorker.made.push(this) }
  private send(data: unknown) { setTimeout(() => !this.terminated && this.onmessage?.({ data }), 1) }
  postMessage(m: { t: string, id?: number, pcm?: ArrayBuffer, files?: string[] }) {
    this.got.push(m)
    if (m.t === 'load') {
      if (this.o.loadError) return this.send({ t: 'error', error: this.o.loadError })
      this.send({ t: 'phase', phase: 'fetch' })
      if (this.o.dies) return void setTimeout(() => this.onerror?.({ message: '' }), 2)
      this.send({ t: 'dl', file: 'a.onnx', got: 100, total: 100 })
      this.send({ t: 'dl', file: 'tokens.txt', got: 5, total: 10 })
      this.send({ t: 'ready', ms: 3, heap: 1 })
    }
    else this.send({ t: 'final', id: m.id, text: this.o.text ?? 'bonjour', ms: 7, heap: 1 })
  }
  terminate() { this.terminated = true }
}

const make = (o: ConstructorParameters<typeof FakeWorker>[0] = {}, m = model) =>
  createDeviceEngine({ model: m, caches: null, worker: () => new FakeWorker(o) as unknown as Worker })

// localStorage for the Node tests.
function memoryStorage() {
  const map = new Map<string, string>()
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) }
}
const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' }
const take = () => ({ pcm: new Float32Array(TAKE_RATE).fill(0.5), seconds: 1 })

afterEach(() => {
  FakeWorker.made = []
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
    let polls = 0
    const fetch = vi.fn(async () => { polls++; return Response.json({ state: 'preparing', phase: 'fetch', got: 1, total: 10 }) })
    const engine = createDeviceEngine({ model, caches: null, fetch, worker: () => new FakeWorker() as unknown as Worker })
    const seen: unknown[] = []
    const loading = engine.prepare(p => seen.push(p))
    await vi.waitFor(() => expect(seen).toEqual([{ phase: 'fetch', got: 1, total: 10, server: true, unpack: false }]))
    engine.dispose()
    expect(isAbortError(await loading.catch(e => e))).toBe(true)
    await new Promise(r => setTimeout(r, 1100))
    expect(polls).toBe(1)
    expect(FakeWorker.made).toHaveLength(0)
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
  })
})

describe('device models', () => {
  it('match what the fetch script downloads, Parakeet v3 by default', () => {
    for (const m of DEVICE_MODELS) {
      const [entry] = SETS[m.set]
      expect(entry.dir).toBe(m.dir)
      expect([...entry.members].sort()).toEqual(m.files.map(f => f.path).sort())
    }
    expect(SETS.runtime[0].to).toContain(`runtime/${DEVICE_RUNTIME}/`)
    expect(DEFAULT_SETS).toEqual(['runtime', DEVICE_MODELS[0]!.set])
    expect(DEVICE_MODELS[0]!.languages).toEqual(expect.arrayContaining(['fr', 'en']))
    expect(deviceModel('sensevoice').id).toBe('sensevoice')
    expect(deviceModel('gone').id).toBe('parakeet-v3')
  })

  it('carry their measured memory, checked against this device\'s budget', () => {
    for (const m of DEVICE_MODELS) expect(m.memory!.heap).toBeGreaterThan(0)
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
