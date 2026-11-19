// Read aloud with an on-device neural voice (the `wherdr` engine of
// useReadAloud): a Piper voice from voices.json in the TTS worker
// (public/workers/tts-worker.js), or the Cantonese voice in the Canto worker
// (public/workers/canto-tts-worker.js), played through WebAudio. The voice
// files are installed through the dictation model store (Cache Storage); a
// voice not installed, or too large for this device, is not used and the
// caller falls back to the system voices.
//
// A reply goes to the worker sentence by sentence, at most LOOKAHEAD ahead of
// what plays, so a stop never waits behind a long queue. The Canto worker
// returns a sentence in parts (it splits long sentences at word boundaries);
// they play back to back. The AudioContext is resumed inside the tap (iOS
// plays only after a user gesture); audio that comes back for a stopped reply
// is dropped. The worker is released after IDLE_MS without speech and on
// pagehide: its WASM heap only goes back to the system when it closes.
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
  // Absent = a Piper voice; 'cantoNano' selects the Canto worker and model.
  kind?: 'cantoNano'
  set: string
  dir: string
  model?: string
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
export const CANTO_WORKER_URL = '/workers/canto-tts-worker.js'
// The Canto voice's ORT set, chosen by the measured speed (see the report).
export const CANTO_RUNTIME = 'onnxruntime-web-1.23.2'
export const IDLE_MS = 60_000
export const LOOKAHEAD = 2
// Stop stops the sound at once; the worker's ack says it made no further ORT
// call. Terminate only if it never answers (twice the longest measured ORT
// call, never sooner than 3 s).
export const STOP_GRACE_MS = 5_000

export const asStored = (v: Voice): StoredModel => ({ id: v.id, dir: v.dir, set: v.set, files: v.members })
export const voiceBytes = (v: Voice) => v.members.reduce((n, m) => n + m.bytes, 0)
// WASM heap a voice needs, until measured on a phone: its weights, the ONNX
// runtime's copy of them and the working buffers.
export const heapEstimate = (v: Voice) => 3 * voiceBytes(v)
// What the memory budget checks: the measured heap, else the estimate.
export const heapNeeded = (v: Voice) => Math.max(v.memory?.heap ?? 0, v.memory?.speaking ?? 0) || heapEstimate(v)

// The default voice for the first of the device's languages that has one, else English.
export function defaultVoice(langs: readonly string[] = globalThis.navigator?.languages ?? []): Voice {
  // Match the full tag or its primary subtag: fr-FR -> fr, yue -> yue.
  const has = (l: string) => {
    const full = l.toLowerCase()
    const primary = full.split('-')[0]
    return VOICES.find(v => v.default && (v.lang === full || v.lang === primary))
  }
  return langs.map(l => has(l)).find(Boolean) ?? has('en')!
}

// A cheap guess of a reply's language, French or English: common short words
// and French accents. A reply is read by the voice of its language.
const FR_WORDS = /\b(le|la|les|des|une?|est|et|pas|que|qui|pour|dans|avec|sur|ce|je|tu|vous|nous|il|elle|du|au|mais|ou)\b/gi
const EN_WORDS = /\b(the|and|is|are|to|of|that|it|for|with|this|you|we|not|be|was|have|but|or)\b/gi
const FR_ACCENTS = /[éèêàçùâîôûœ]/gi
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu
const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/u
export function replyLanguage(text: string): 'fr' | 'en' | 'yue' {
  const fr = (text.match(FR_WORDS)?.length ?? 0) + (text.match(FR_ACCENTS)?.length ?? 0) / 2
  const en = text.match(EN_WORDS)?.length ?? 0
  // Japanese contains kana: never route it to the Cantonese voice.
  if (!KANA.test(text)) {
    const cjk = text.match(CJK)?.length ?? 0
    const letters = text.replace(/\s/g, '').length
    if (cjk >= 5 && cjk >= letters * 0.2) return 'yue'
  }
  return fr > en ? 'fr' : 'en'
}

export interface SpeakOptions {
  voice: Voice
  chunks: string[]
  speed?: number
  onEnd: () => void
  onError: (err: Error) => void
}

export interface NeuralVoiceDeps {
  worker?: (url: string) => Worker
  audio?: () => AudioContext
  caches?: CacheStorage | null
  fetch?: typeof fetch
  budget?: number | null
  idleMs?: number
  stopGraceMs?: number
}

type FromWorker =
  | { t: 'phase' | 'dl' }
  | { t: 'ready', heap: number, ms?: number }
  | { t: 'parts', id: string, count: number }
  | { t: 'audio', id: string, part?: number, parts?: number, pcm: ArrayBuffer, sampleRate: number, ms?: number, heap?: number }
  | { t: 'cancelled', id: string }
  | { t: 'error', id?: string, error: string }

interface AudioPart { pcm: ArrayBuffer, sampleRate: number }
interface Speech {
  parts: AudioPart[]
  total?: number
}
interface Job {
  gen: number
  voice: Voice
  opts: SpeakOptions
  sent: number // sentences asked of the worker
  endedSentences: number
  playSent: number // sentence whose next part is scheduled next
  playPart: number
  audio: Map<number, Speech>
  sources: AudioBufferSourceNode[]
  at: number // AudioContext time the next part starts
}

export function createNeuralVoice(deps: NeuralVoiceDeps = {}) {
  // A page killed while loading a voice marks it too large (as for dictation).
  checkCrash()
  const makeWorker = deps.worker ?? ((url: string) => new Worker(url))
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
  let stopTimer: ReturnType<typeof setTimeout> | undefined
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
    if (j) {
      clearTimeout(stopTimer)
      worker?.postMessage({ t: 'cancel', id: `${j.gen}.${j.sent - 1}`, gen: j.gen })
      stopTimer = setTimeout(() => release(), deps.stopGraceMs ?? STOP_GRACE_MS)
      armIdle()
    }
  }

  function release() {
    stop()
    clearTimeout(stopTimer)
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
    const w = makeWorker(v.kind === 'cantoNano' ? CANTO_WORKER_URL : TTS_WORKER_URL)
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
      else if (m.t === 'parts') onParts(m.id, m.count)
      else if (m.t === 'audio') onAudio(m.id, m)
      else if (m.t === 'cancelled') clearTimeout(stopTimer)
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
    const load = {
      t: 'load',
      runtime: `/models/runtime/${v.kind === 'cantoNano' ? CANTO_RUNTIME : DEVICE_RUNTIME}/`,
      base: `/models/${v.dir}`,
      files: v.members.map(m => m.path),
      bytes: v.members.map(m => m.bytes),
      chunk: CHUNK,
      cache: DEVICE_CACHE,
      kind: v.kind,
      model: v.model,
    }
    w.postMessage(load)
  }

  // Ask for the next sentences, keeping at most LOOKAHEAD beyond the one playing.
  function pump() {
    const j = job
    if (!j || !ready || !worker) return
    const ahead = j.voice.kind === 'cantoNano' ? 1 : LOOKAHEAD
    while (j.sent < j.opts.chunks.length && j.sent - j.endedSentences <= ahead) {
      worker.postMessage({ t: 'speak', id: `${j.gen}.${j.sent}`, text: j.opts.chunks[j.sent], speed: j.opts.speed ?? 1 })
      j.sent++
    }
  }

  function speech(j: Job, i: number): Speech {
    let s = j.audio.get(i)
    if (!s) { s = { parts: [] }; j.audio.set(i, s) }
    return s
  }

  function onParts(id: string, count: number) {
    const [g, i] = id.split('.').map(Number)
    const j = job
    if (!j || g !== j.gen) return
    speech(j, i!).total = count
    schedule(j)
  }

  function onAudio(id: string, a: { pcm: ArrayBuffer, sampleRate: number, part?: number, parts?: number, ms?: number, heap?: number }) {
    const [g, i] = id.split('.').map(Number)
    const j = job
    if (!j || !ctx || g !== j.gen) return // late audio of a stopped reply
    if (stats) {
      stats.firstMs ??= Math.round(now() - tapAt)
      stats.genMs += a.ms ?? 0
      stats.audioMs += Math.round(a.pcm.byteLength / 4 / a.sampleRate * 1000)
      sawHeap(a.heap)
    }
    if (budget != null && a.heap && a.heap > budget) return fail(`out of memory: the voice takes ${a.heap} bytes`)
    const s = speech(j, i!)
    s.total = a.parts ?? s.total ?? 1
    s.parts[a.part ?? 0] = { pcm: a.pcm, sampleRate: a.sampleRate }
    schedule(j)
  }

  // Play the next available part, in order, gapless; a sentence ends after its
  // last part, then one more sentence is asked for.
  function schedule(j: Job) {
    if (!j || !ctx) return
    for (;;) {
      const s = j.audio.get(j.playSent)
      const p = s?.parts[j.playPart]
      if (!s || !p) return
      const pcm = new Float32Array(p.pcm)
      const buf = ctx.createBuffer(1, Math.max(1, pcm.length), p.sampleRate)
      buf.getChannelData(0).set(pcm)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      const at = Math.max(ctx.currentTime, j.at)
      src.start(at)
      j.at = at + buf.duration
      j.sources.push(src)
      const last = j.playPart >= (s.total ?? 1) - 1
      src.onended = () => {
        if (job !== j) return
        j.sources.shift()
        if (!last) return
        j.endedSentences++
        if (j.endedSentences < j.opts.chunks.length) return pump()
        job = null
        armIdle()
        j.opts.onEnd()
      }
      j.playPart++
      if (j.playPart >= (s.total ?? 1)) { j.playSent++; j.playPart = 0 }
    }
  }

  // Called from the tap. false: this voice cannot speak here (not installed,
  // too large), the caller uses the system voices.
  function speak(opts: SpeakOptions): boolean {
    if (!usable(opts.voice) || !opts.chunks.length) return false
    stop()
    clearTimeout(stopTimer)
    clearTimeout(idle)
    if (!ctx || ctx.state === 'closed') ctx = makeAudio()
    void ctx.resume().catch(() => {})
    job = {
      gen: ++gen,
      voice: opts.voice,
      opts,
      sent: 0,
      endedSentences: 0,
      playSent: 0,
      playPart: 0,
      audio: new Map(),
      sources: [],
      at: 0,
    }
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
