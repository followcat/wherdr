// The on-device engine: sherpa-onnx WASM on the CPU (dictation-worker.js) or
// onnxruntime-web on WebGPU (dictation-webgpu-worker.js). Model files come
// from the wherdr server (/models/**) once, kept in Cache Storage by
// modelStore.ts (the same download as Settings › Dictation), then read from
// there. Nothing leaves the device.
import { splitTake } from './audio'
import { abortError, DeviceUnsupported, ModelTooLarge } from './engine'
import type { DictationEngine, PrepareProgress, Readiness } from './engine'
import { DEVICE_CACHE, DEVICE_MODEL_KEY, DEVICE_MODELS, DEVICE_RUNTIMES, deviceLanguage, deviceModel, gpuFeatures, markLoading, markTooLarge, markUnsupported, memoryFit, modelBytes, sentenceCase, takeCrash, unsupportedModels } from './deviceModels'
import type { DeviceModel, DeviceNeed } from './deviceModels'
import { CHUNK, installModel, prepareOnServer, storedBytes } from './modelStore'
import type { Progress } from './modelStore'

export const WORKER_URL = '/workers/dictation-worker.js'
export const WEBGPU_WORKER_URL = '/workers/dictation-webgpu-worker.js'

export interface DeviceEngineDeps {
  model?: DeviceModel
  gpu?: readonly DeviceNeed[]
  worker?: (url: string) => Worker
  caches?: CacheStorage | null
  fetch?: typeof fetch
}

type FromWorker =
  | { t: 'phase', phase: string }
  | { t: 'dl', file: string, got: number, total: number }
  | { t: 'ready', ms: number, heap?: number }
  | { t: 'final', id: number, text: string, ms: number, heap?: number, language?: string, truncated?: boolean }
  | { t: 'error', id?: number, error: string }

interface Pending { resolve: (r: { text: string, ms: number }) => void, reject: (e: unknown) => void }

// A worker that says it ran out of memory: the model is too large for this
// device. Emscripten reports an abort for OOM or a failed memory grow; the
// browser, a failed buffer allocation. Other errors stay plain failures.
export const OUT_OF_MEMORY = /out of memory|Aborted\(OOM\)|enlarge memory|allocation failed/i
export const UNSUPPORTED_DEVICE = /^Unsupported speech device\b/i

function readSavedId(): string | null {
  try { return localStorage.getItem(DEVICE_MODEL_KEY) }
  catch { return null }
}

function savedModel(gpu?: readonly DeviceNeed[]): DeviceModel {
  return deviceModel(readSavedId(), undefined, undefined, gpu)
}

export async function openDeviceEngine(): Promise<DictationEngine> {
  const saved = DEVICE_MODELS.find(m => m.id === readSavedId())
  const gpu = saved?.requires.length && !unsupportedModels().has(saved.id) ? await gpuFeatures() : []
  return createDeviceEngine({ gpu })
}

export function createDeviceEngine(deps: DeviceEngineDeps = {}): DictationEngine {
  // The last page was killed while loading a model: said once, at the next
  // press, while the choice falls back to one that fits (deviceModel).
  const crashed = takeCrash()
  let notice = crashed ? DEVICE_MODELS.find(m => m.id === crashed) : undefined
  const model = deps.model ?? savedModel(deps.gpu)
  const cacheStorage = deps.caches === undefined ? globalThis.caches : deps.caches
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const workerUrl = model.kind === 'qwen3Q4F16' ? WEBGPU_WORKER_URL : WORKER_URL
  const runtimeDir = DEVICE_RUNTIMES[model.runtime ?? 'runtime']
  const makeWorker = deps.worker ?? (url => new Worker(url))
  const urlOf = (path: string) => `/models/${model.dir}/${path}`
  const total = modelBytes(model)

  let worker: Worker | null = null
  let loading: Promise<void> | null = null
  let failLoad: ((err: Error) => void) | null = null
  let onProgress: ((p: PrepareProgress) => void) | undefined
  let nextId = 0
  let disposed = false
  // Stops a load's wait for the server's files (no Cache Storage) on dispose.
  let waitServer: AbortController | null = null
  const pending = new Map<number, Pending>()

  // The worker failed (load error, crash, out of memory): everything waiting
  // on it fails, and the next prepare starts a fresh one.
  function reset(err: Error) {
    worker?.terminate()
    worker = null
    loading = null
    markLoading(null)
    failLoad?.(err)
    failLoad = null
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  }

  // Into Cache Storage first, where the worker reads it. A browser that cannot
  // keep it (no Cache Storage, quota full) has the worker stream it from the server.
  async function fetchModel(): Promise<string> {
    const report = (p: Progress) => onProgress?.({ phase: 'fetch', ...p })
    if (!cacheStorage) {
      // Streamed from the server: it still has to hold the files.
      waitServer = new AbortController()
      try { await prepareOnServer(model, { fetch: doFetch }, waitServer.signal, report) }
      finally { waitServer = null }
      return ''
    }
    try {
      await installModel(model, report, { caches: cacheStorage, fetch: doFetch })
      return DEVICE_CACHE
    }
    catch (e) {
      if ((e as Error).name === 'QuotaExceededError') return ''
      throw e
    }
  }

  function start(cache: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const w = makeWorker(workerUrl)
      worker = w
      failLoad = reject
      markLoading(model.id)
      let started = false // the worker spoke: a silent death after is not a missing file
      const fail = (err: Error) => { if (worker === w) reset(err); reject(err) }
      // A load that dies (no message) or runs out of memory: too large here.
      const tooLarge = (msg: string) => { markTooLarge(model.id, 'oom'); return new ModelTooLarge(msg) }
      const unsupported = (msg: string) => { markUnsupported(model.id); return new DeviceUnsupported(msg) }
      const workerError = (msg: string) => UNSUPPORTED_DEVICE.test(msg) ? unsupported(msg) : new Error(msg || 'dictation worker failed')
      const loadFailed = (msg: string) => fail((!msg && started) || OUT_OF_MEMORY.test(msg) ? tooLarge(msg || 'dictation worker died') : workerError(msg))
      w.onerror = (e) => {
        e.preventDefault?.()
        if (failLoad) loadFailed(e.message)
        else fail(workerError(e.message))
      }
      w.onmessage = ({ data: m }: MessageEvent<FromWorker>) => {
        started = true
        if (m.t === 'phase') onProgress?.({ phase: m.phase })
        else if (m.t === 'dl') {
          const i = model.files.findIndex(f => f.path === m.file)
          const before = model.files.slice(0, Math.max(0, i)).reduce((n, f) => n + f.bytes, 0)
          onProgress?.({ phase: 'fetch', got: before + m.got, total })
        }
        else if (m.t === 'ready') { failLoad = null; markLoading(null); resolve() }
        else if (m.t === 'final') {
          pending.get(m.id)?.resolve({ text: model.textCase === 'upper' ? sentenceCase(m.text) : m.text, ms: m.ms })
          pending.delete(m.id)
        }
        else if (m.id === undefined) loadFailed(m.error)
        else if (OUT_OF_MEMORY.test(m.error)) fail(tooLarge(m.error))
        else if (UNSUPPORTED_DEVICE.test(m.error)) fail(unsupported(m.error))
        else {
          pending.get(m.id)?.reject(new Error(m.error))
          pending.delete(m.id)
        }
      }
      w.postMessage({
        t: 'load',
        runtime: `/models/runtime/${runtimeDir}/`,
        base: `/models/${model.dir}`,
        kind: model.kind,
        files: model.files.map(f => f.path),
        bytes: model.files.map(f => f.bytes),
        chunk: CHUNK,
        cache,
        language: model.autoDetect === false ? deviceLanguage(model) : '',
      })
    })
  }

  const cached = async () => !!cacheStorage && await storedBytes(model, { caches: cacheStorage }) === total

  // One piece to the worker; a copy, so the caller keeps its take. On abort,
  // { t: 'cancel', id } suppresses the WebGPU worker's queued or active take.
  function decode(pcm: Float32Array, opts: { terms: string[], language?: string, signal: AbortSignal }): Promise<{ text: string, ms: number }> {
    if (!worker) return Promise.reject(abortError()) // disposed meanwhile
    const id = ++nextId
    const result = new Promise<{ text: string, ms: number }>((resolve, reject) => {
      pending.set(id, { resolve, reject })
    })
    const copy = pcm.slice()
    worker.postMessage({ t: 'decode', id, pcm: copy.buffer, terms: opts.terms, ...(opts.language ? { language: opts.language } : {}) }, [copy.buffer])
    const onAbort = () => { if (pending.delete(id)) worker?.postMessage({ t: 'cancel', id }) }
    opts.signal.addEventListener('abort', onAbort, { once: true })
    return result.finally(() => opts.signal.removeEventListener('abort', onAbort))
  }

  function prepare(progress?: (p: PrepareProgress) => void): Promise<void> {
    onProgress = progress
    if (!loading) {
      // Disposed while downloading (another model chosen): no worker is started.
      const run = fetchModel().then(cache => (disposed ? Promise.reject(abortError()) : start(cache)))
      loading = run
      run.catch(() => { if (loading === run) loading = null }) // the next press tries again
    }
    return loading
  }

  return {
    id: 'device',
    caps: { terms: model.kind === 'qwen3Q4F16', languages: model.languages, offline: true },

    async readiness(): Promise<Readiness> {
      if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') return { ready: false, reason: 'unsupported' }
      if (model.requires.length) {
        const have = await gpuFeatures()
        const missing = model.requires.filter(r => !have.includes(r))
        if (missing.length) return { ready: false, reason: 'unsupported', detail: `${model.name} requires ${missing.join(' and ')}` }
      }
      if (notice) {
        const detail = notice.name
        notice = undefined
        return { ready: false, reason: 'too-large', detail }
      }
      const fit = memoryFit(model)
      if (fit === 'unsupported') return { ready: false, reason: 'unsupported', detail: model.name }
      if (fit !== 'ok') return { ready: false, reason: 'too-large', detail: model.name }
      if (await cached().catch(() => false)) return { ready: true }
      // Not on this device yet: prepare downloads it if the server has it.
      try {
        const heads = await Promise.all(model.files.map(f => doFetch(urlOf(f.path), { method: 'HEAD' })))
        const missing = heads.findIndex(r => !r.ok)
        if (missing < 0) return { ready: true }
        return { ready: false, reason: 'not-installed', detail: `${model.name}: ${model.files[missing]!.path} (HTTP ${heads[missing]!.status})` }
      }
      catch {
        return { ready: false, reason: 'offline' }
      }
    },

    prepare,

    // A long take is decoded piece by piece (splitTake): each piece reports
    // the text so far, and a cancel stops before the next piece.
    async transcribe(take, opts) {
      if (opts.signal.aborted) throw abortError()
      const aborted = new Promise<never>((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(abortError()), { once: true })
      })
      aborted.catch(() => {})
      await Promise.race([prepare(onProgress), aborted])
      let text = ''
      let ms = 0
      for (const piece of splitTake(take.pcm)) {
        if (opts.signal.aborted) throw abortError()
        const r = await Promise.race([decode(piece, opts), aborted])
        text = [text, r.text].filter(Boolean).join(' ')
        ms += r.ms
        opts.onPartial?.(text)
      }
      return { text, ms }
    },

    dispose() {
      disposed = true
      waitServer?.abort(abortError())
      if (worker) reset(abortError())
    },
  }
}
