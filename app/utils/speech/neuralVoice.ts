// Read aloud with an on-device neural voice (the `wherdr` engine of
// useReadAloud): a Piper voice from voices.json in the TTS worker
// (public/workers/tts-worker.js), played through WebAudio. The voice files are
// installed through the dictation model store (Cache Storage); a voice not
// installed, or too large for this device, is not used and the caller falls
// back to the system voices.
//
// A reply goes to the worker sentence by sentence, at most LOOKAHEAD ahead of
// what plays, so a stop never waits behind a long queue. The AudioContext is
// resumed inside the tap (iOS plays only after a user gesture); audio that
// comes back for a stopped reply is dropped. The worker is released after
// IDLE_MS without speech and on pagehide: its WASM heap only goes back to the
// system when it closes.
import catalog from './voices.json'
import { OUT_OF_MEMORY } from '../dictation/device'
import { DEVICE_CACHE, DEVICE_RUNTIME, checkCrash, crashedModels, markLoading, markTooLarge, memoryBudget } from '../dictation/deviceModels'
import { CHUNK, deleteModel, installModel, storedBytes } from '../dictation/modelStore'
import type { Progress, StoredModel } from '../dictation/modelStore'

export interface Voice {
  id: string
  name: string
  lang: string
  locale: string
  default?: boolean
  set: string
  dir: string
  model: string
  members: { path: string, bytes: number }[]
  attribution: string
  // Measured on a phone (docs/read-aloud.md): WASM heap after load and while
  // speaking, and the real-time factor. Absent until measured.
  memory?: { heap: number, speaking?: number, basis: string }
  speed?: { rtf: number, basis: string }
}

// What the last reply measured (shown by the settings' Test).
export interface VoiceStats {
  voice: string
  loadMs?: number // worker: runtime, files and model, on a cold start only
  firstMs?: number // tap to the first sentence's audio
  genMs: number // time spent generating speech
  audioMs: number // length of the speech generated
  heap: number // largest WASM heap seen, bytes
}

export const VOICES = catalog.voices as Voice[]
export const TTS_WORKER_URL = '/workers/tts-worker.js'
export const IDLE_MS = 60_000
export const LOOKAHEAD = 2

export const asStored = (v: Voice): StoredModel => ({ id: v.id, dir: v.dir, set: v.set, files: v.members })
export const voiceBytes = (v: Voice) => v.members.reduce((n, m) => n + m.bytes, 0)
// WASM heap a voice needs, until measured on a phone: its weights, the ONNX
// runtime's copy of them and the working buffers.
export const heapEstimate = (v: Voice) => 3 * voiceBytes(v)
// What the memory budget checks: the measured heap, else the estimate.
export const heapNeeded = (v: Voice) => Math.max(v.memory?.heap ?? 0, v.memory?.speaking ?? 0) || heapEstimate(v)

// The default voice for the first of the device's languages that has one, else English.
export function defaultVoice(langs: readonly string[] = globalThis.navigator?.languages ?? []): Voice {
  const has = (l: string) => VOICES.find(v => v.default && v.lang === l)
  return langs.map(l => has(l.slice(0, 2).toLowerCase())).find(Boolean) ?? has('en')!
}

// A cheap guess of a reply's language, French or English: common short words
// and French accents. A reply is read by the voice of its language.
const FR_WORDS = /\b(le|la|les|des|une?|est|et|pas|que|qui|pour|dans|avec|sur|ce|je|tu|vous|nous|il|elle|du|au|mais|ou)\b/gi
const EN_WORDS = /\b(the|and|is|are|to|of|that|it|for|with|this|you|we|not|be|was|have|but|or)\b/gi
const FR_ACCENTS = /[éèêàçùâîôûœ]/gi
export function replyLanguage(text: string): 'fr' | 'en' {
  const fr = (text.match(FR_WORDS)?.length ?? 0) + (text.match(FR_ACCENTS)?.length ?? 0) / 2
  return fr > (text.match(EN_WORDS)?.length ?? 0) ? 'fr' : 'en'
}

export interface SpeakOptions {
  voice: Voice
  chunks: string[]
  speed?: number
  onEnd: () => void
  onError: (err: Error) => void
}

export interface NeuralVoiceDeps {
  worker?: () => Worker
  audio?: () => AudioContext
  caches?: CacheStorage | null
  fetch?: typeof fetch
  budget?: number | null
  idleMs?: number
}

type FromWorker =
  | { t: 'phase' | 'dl' }
  | { t: 'ready', heap: number, ms?: number }
  | { t: 'audio', id: string, pcm: ArrayBuffer, sampleRate: number, ms?: number, heap?: number }
  | { t: 'error', id?: string, error: string }

interface Job {
  gen: number
  opts: SpeakOptions
  sent: number // sentences asked of the worker
  scheduled: number // sentences handed to WebAudio
  ended: number // sentences done playing
  at: number // AudioContext time the next sentence starts
  audio: Map<number, { pcm: ArrayBuffer, sampleRate: number }>
  sources: AudioBufferSourceNode[]
}

export function createNeuralVoice(deps: NeuralVoiceDeps = {}) {
  // A page killed while loading a voice marks it too large (as for dictation).
  checkCrash()
  const makeWorker = deps.worker ?? (() => new Worker(TTS_WORKER_URL))
  const makeAudio = deps.audio ?? (() => new AudioContext())
  const store = { caches: deps.caches, fetch: deps.fetch }
  const budget = deps.budget === undefined ? memoryBudget() : deps.budget
  const installed = new Set<string>()
  let worker: Worker | null = null
  let loaded: Voice | null = null
  let ready = false
  let ctx: AudioContext | null = null
  let job: Job | null = null
  let gen = 0
  let idle: ReturnType<typeof setTimeout> | undefined
  let stats: VoiceStats | null = null
  let tapAt = 0
  const now = () => globalThis.performance?.now() ?? Date.now()
  const sawHeap = (h?: number) => { if (stats && h) stats.heap = Math.max(stats.heap, h) }

  const fits = (v: Voice) => !crashedModels()[v.id] && (budget == null || heapNeeded(v) <= budget)
  const usable = (v: Voice) => installed.has(v.id) && fits(v)

  // Which voices this device holds whole: speak() decides from this, in the tap.
  async function refresh() {
    for (const v of VOICES) {
      const whole = await storedBytes(asStored(v), store).catch(() => 0) === voiceBytes(v)
      if (whole) installed.add(v.id)
      else installed.delete(v.id)
    }
  }

  async function install(v: Voice, onProgress?: (p: Progress) => void) {
    await installModel(asStored(v), onProgress, store)
    installed.add(v.id)
  }

  async function remove(v: Voice) {
    installed.delete(v.id)
    if (loaded?.id === v.id) release()
    await deleteModel(asStored(v), store)
  }

  function stop() {
    const j = job
    job = null
    for (const s of j?.sources ?? []) {
      try { s.stop() }
      catch { /* not started */ }
    }
    if (j) armIdle()
  }

  function release() {
    stop()
    clearTimeout(idle) // stop() armed it
    worker?.terminate()
    worker = null
    loaded = null
    ready = false
    markLoading(null)
    void ctx?.close().catch(() => {})
    ctx = null
  }

  function armIdle() {
    clearTimeout(idle)
    idle = setTimeout(release, deps.idleMs ?? IDLE_MS)
  }

  // The worker failed: a load that dies silently or runs out of memory marks
  // the voice too large here; the reply stops with the error.
  function fail(msg: string) {
    if (loaded && (OUT_OF_MEMORY.test(msg) || (!msg && !ready))) markTooLarge(loaded.id, 'oom')
    const j = job
    release()
    j?.opts.onError(new Error(msg || 'the voice worker stopped'))
  }

  function startWorker(v: Voice) {
    if (worker && loaded?.id === v.id) return
    worker?.terminate()
    const w = makeWorker()
    worker = w
    loaded = v
    ready = false
    markLoading(v.id)
    w.onmessage = ({ data: m }: MessageEvent<FromWorker>) => {
      if (w !== worker) return
      if (m.t === 'ready') {
        if (budget != null && m.heap > budget) return fail(`out of memory: the voice takes ${m.heap} bytes`)
        ready = true
        markLoading(null)
        if (stats) stats.loadMs = m.ms
        sawHeap(m.heap)
        pump()
      }
      else if (m.t === 'audio') onAudio(m.id, m)
      else if (m.t === 'error') {
        // A sentence of a stopped reply: nobody is listening.
        if (m.id !== undefined && Number(m.id.split('.')[0]) !== job?.gen && !OUT_OF_MEMORY.test(m.error)) return
        fail(m.error)
      }
    }
    w.onerror = (e) => {
      e.preventDefault?.()
      if (w === worker) fail(e.message)
    }
    w.postMessage({
      t: 'load',
      runtime: `/models/runtime/${DEVICE_RUNTIME}/`,
      base: `/models/${v.dir}`,
      model: v.model,
      files: v.members.map(m => m.path),
      bytes: v.members.map(m => m.bytes),
      chunk: CHUNK,
      cache: DEVICE_CACHE,
    })
  }

  // Ask for the next sentences, keeping at most LOOKAHEAD beyond the one playing.
  function pump() {
    const j = job
    if (!j || !ready || !worker) return
    while (j.sent < j.opts.chunks.length && j.sent - j.ended <= LOOKAHEAD) {
      worker.postMessage({ t: 'speak', id: `${j.gen}.${j.sent}`, text: j.opts.chunks[j.sent], speed: j.opts.speed ?? 1 })
      j.sent++
    }
  }

  function onAudio(id: string, a: { pcm: ArrayBuffer, sampleRate: number, ms?: number, heap?: number }) {
    const [g, i] = id.split('.').map(Number)
    const j = job
    if (!j || !ctx || g !== j.gen) return // late audio of a stopped reply
    if (stats) {
      stats.firstMs ??= Math.round(now() - tapAt)
      stats.genMs += a.ms ?? 0
      stats.audioMs += Math.round(a.pcm.byteLength / 4 / a.sampleRate * 1000)
      sawHeap(a.heap)
    }
    j.audio.set(i!, a)
    // In order, each one right after the previous (gapless).
    for (let next = j.audio.get(j.scheduled); next; next = j.audio.get(j.scheduled)) {
      j.audio.delete(j.scheduled++)
      const pcm = new Float32Array(next.pcm)
      const buf = ctx.createBuffer(1, Math.max(1, pcm.length), next.sampleRate)
      buf.getChannelData(0).set(pcm)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      const at = Math.max(ctx.currentTime, j.at)
      src.start(at)
      j.at = at + buf.duration
      j.sources.push(src)
      src.onended = () => {
        if (job !== j) return
        j.sources.shift()
        if (++j.ended < j.opts.chunks.length) return pump()
        job = null
        armIdle()
        j.opts.onEnd()
      }
    }
  }

  // Called from the tap. false: this voice cannot speak here (not installed,
  // too large), the caller uses the system voices.
  function speak(opts: SpeakOptions): boolean {
    if (!usable(opts.voice) || !opts.chunks.length) return false
    stop()
    clearTimeout(idle)
    if (!ctx || ctx.state === 'closed') ctx = makeAudio()
    void ctx.resume().catch(() => {})
    job = { gen: ++gen, opts, sent: 0, scheduled: 0, ended: 0, at: 0, audio: new Map(), sources: [] }
    stats = { voice: opts.voice.id, genMs: 0, audioMs: 0, heap: 0 }
    tapAt = now()
    startWorker(opts.voice)
    pump()
    return true
  }

  globalThis.addEventListener?.('pagehide', release)

  return { speak, stop, release, refresh, install, remove, usable, fits, stats: () => stats }
}

export type NeuralVoice = ReturnType<typeof createNeuralVoice>
