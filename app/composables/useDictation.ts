// Dictation capture, shared by every engine: mic → 16 kHz mono take → the
// chosen engine → text. Ported from followcat's useSpeech (followcat/wherdr).
//
// One take at a time for the whole app. Each useDictation() call gets its own
// facade: split panes mount several composers, and a take belongs to the
// facade that started it. Its text goes to that composer alone, the other
// facades read 'busy', and another composer unmounting never ends it.
//
// The mic opens at once on press (iOS only starts an AudioContext inside the
// press's user activation) and the PCM is kept while the engine prepares: the
// user can talk while a model loads.
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { TAKE_RATE, isAbortError } from '../utils/dictation/engine'
import type { DictationEngine, DictationEngineId, NotReadyReason, PrepareProgress, Readiness } from '../utils/dictation/engine'
import { loadEngine } from '../utils/dictation/registry'
import { concatPcm, createResampler, rms } from '../utils/dictation/audio'

export type DictationStatus = 'idle' | 'preparing' | 'recording' | 'transcribing' | 'rewriting' | 'error' | 'busy'

export interface DictationError {
  reason: NotReadyReason | 'mic' | 'failed' | 'timeout'
  detail?: string
}

export interface DictationStart {
  engine: DictationEngineId
  language?: string
  terms?: string[]
  onText: (text: string) => void // the take's text, never empty
  // The optional rewrite of that text; it rejects only when the take is cancelled.
  rewrite?: (text: string, signal: AbortSignal) => Promise<string>
}

export interface Dictation {
  status: ComputedRef<DictationStatus>
  error: Ref<DictationError | null>
  levels: Ref<number[]> // RMS bars of the live wave, newest last
  recMs: Ref<number>
  progress: Ref<PrepareProgress | null> // the engine loading, while it does
  // Resolves once the mic is live (or the start failed: see `error`).
  // Throws only when another pane holds the mic.
  start: (o: DictationStart) => Promise<void>
  stop: () => Promise<void>
  cancel: () => void
  dispose: () => void
}

// A forgotten take still ends somewhere on a phone.
export const MAX_TAKE_MS = 120_000
// A big model decodes slowly on a phone, but a wedged one must not leave the
// composer on "Recognizing…" forever. Counted from the stop, or from the last
// partial result (a long take decoded piece by piece keeps going).
export const TRANSCRIBE_TIMEOUT_MS = 90_000
const LEVELS_MAX = 40
const BUFFER = 4096

interface Facade {
  dead: boolean
  status: Ref<Exclude<DictationStatus, 'busy'>>
  error: Ref<DictationError | null>
  levels: Ref<number[]>
  recMs: Ref<number>
  progress: Ref<PrepareProgress | null>
}

// The take in progress, with everything it grabbed: a stale start releases
// only its own stream and context, never a newer take's.
interface Take {
  me: Facade
  gen: number
  opts: DictationStart
  engine: Promise<DictationEngine>
  abort: AbortController
  ctx: AudioContext | null
  stream: MediaStream | null
  nodes: AudioNode[]
  chunks: Float32Array[]
  samples: number
  cap: ReturnType<typeof setTimeout> | null
  transcribing: boolean
}

class NotReadyError extends Error {
  constructor(readonly readiness: Extract<Readiness, { ready: false }>) { super(readiness.reason) }
}

const current = shallowRef<Take | null>(null)
// Each start gets a number; stop, cancel, dispose and a newer start bump it,
// and a start that wakes up stale drops what it grabbed instead of recording
// into a dead composer or leaking a second stream.
let gen = 0

function release(take: Take) {
  if (take.cap) clearTimeout(take.cap)
  take.cap = null
  for (const n of take.nodes) n.disconnect()
  take.nodes = []
  take.stream?.getTracks().forEach(t => t.stop())
  take.stream = null
  take.ctx?.close().catch(() => {})
  take.ctx = null
}

function errorOf(e: unknown): DictationError {
  if (e instanceof NotReadyError) return { reason: e.readiness.reason, detail: e.readiness.detail }
  if ((e as Error | null)?.name === 'ModelTooLarge') return { reason: 'too-large', detail: (e as Error).message }
  return { reason: 'failed', detail: e instanceof Error ? e.message : String(e) }
}

// The take ends on an error: the mic drops at once and its composer shows it.
function fail(take: Take, error: DictationError) {
  if (current.value !== take) return
  if (take.gen === gen) gen++
  take.abort.abort()
  release(take)
  current.value = null
  take.me.status.value = 'error'
  take.me.error.value = error
  take.me.progress.value = null
}

async function prepareEngine(take: Take): Promise<DictationEngine> {
  const engine = await loadEngine(take.opts.engine)
  const readiness = await engine.readiness()
  if (!readiness.ready) throw new NotReadyError(readiness)
  await engine.prepare((p) => { if (current.value === take) take.me.progress.value = p })
  if (current.value === take) take.me.progress.value = null
  return engine
}

async function start(me: Facade, opts: DictationStart) {
  if (me.dead) throw new Error('disposed')
  const busy = current.value
  if (busy && busy.me !== me) throw new Error('The microphone is busy in another pane')
  if (busy) cancel(me)
  const take: Take = {
    me, gen: ++gen, opts, engine: null!, abort: new AbortController(),
    ctx: null, stream: null, nodes: [], chunks: [], samples: 0, cap: null, transcribing: false,
  }
  current.value = take
  me.status.value = 'preparing'
  me.error.value = null
  me.levels.value = []
  me.recMs.value = 0
  me.progress.value = null
  take.engine = prepareEngine(take)
  take.engine.catch(e => fail(take, errorOf(e)))
  const stale = () => take.gen !== gen
  try {
    // Before any await: the press's user activation starts it on iOS. The
    // native rate, resampled in code (Firefox refuses a mic source on a
    // context of another rate).
    take.ctx = new AudioContext()
    // Dictation, not a call: echo cancellation, noise suppression and gain
    // control gate quiet speech on Android badly enough to break recognition.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    if (stale()) { stream.getTracks().forEach(t => t.stop()); return }
    take.stream = stream
    const ctx = take.ctx
    if (ctx.state === 'suspended') await ctx.resume()
    if (stale()) return
    const resample = createResampler(ctx.sampleRate)
    const src = ctx.createMediaStreamSource(stream)
    const node = ctx.createScriptProcessor(BUFFER, 1, 1)
    node.onaudioprocess = (e) => {
      if (stale()) return
      const raw = e.inputBuffer.getChannelData(0)
      const pcm = resample(raw)
      take.chunks.push(pcm)
      take.samples += pcm.length
      // Two bars per buffer feed the composer's live wave.
      const half = raw.length >> 1
      me.levels.value = [...me.levels.value, rms(raw, 0, half), rms(raw, half)].slice(-LEVELS_MAX)
      me.recMs.value = Math.round(take.samples / TAKE_RATE * 1000)
    }
    // The processor only runs while pulled by the output, but wiring it to
    // the speaker plays the mic back into the take: route through silence.
    const mute = ctx.createGain()
    mute.gain.value = 0
    src.connect(node)
    node.connect(mute)
    mute.connect(ctx.destination)
    take.nodes = [src, node, mute]
    me.status.value = 'recording'
    take.cap = setTimeout(() => void stop(me), MAX_TAKE_MS)
  }
  catch (err) {
    // A denied mic or a dead context: nothing grabbed may leak, and the
    // composer reads the error from `error`.
    if (!stale()) fail(take, { reason: 'mic', detail: err instanceof Error ? err.message : String(err) })
  }
}

async function stop(me: Facade) {
  const take = current.value
  if (!take || take.me !== me || take.transcribing) return
  const recorded = me.status.value === 'recording' && take.samples > 0
  gen++
  release(take)
  if (!recorded) {
    // Released before the mic opened, or nothing captured: no take.
    current.value = null
    me.status.value = 'idle'
    me.progress.value = null
    return
  }
  take.transcribing = true
  me.status.value = 'transcribing'
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const engine = await take.engine
    if (current.value !== take) return
    const pcm = concatPcm(take.chunks, take.samples)
    take.chunks = []
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timedOut = true; take.abort.abort() }, TRANSCRIBE_TIMEOUT_MS)
    }
    arm()
    const { text } = await engine.transcribe(
      { pcm, seconds: pcm.length / TAKE_RATE },
      { language: take.opts.language, terms: take.opts.terms ?? [], signal: take.abort.signal, onPartial: arm },
    )
    // Cancelled meanwhile (an engine that ignores its signal): drop the text.
    if (current.value !== take) return
    let clean = text.trim()
    if (clean && take.opts.rewrite) {
      if (timer) clearTimeout(timer)
      me.status.value = 'rewriting'
      clean = (await take.opts.rewrite(clean, take.abort.signal)).trim() || clean
      if (current.value !== take) return
    }
    current.value = null
    me.status.value = 'idle'
    if (clean) take.opts.onText(clean)
  }
  catch (e) {
    if (timedOut) fail(take, { reason: 'timeout' })
    else if (!isAbortError(e)) fail(take, errorOf(e))
  }
  finally {
    if (timer) clearTimeout(timer)
  }
}

// Cancel drops the audio and the result at once; it also dismisses an error.
function cancel(me: Facade) {
  me.levels.value = []
  me.recMs.value = 0
  me.progress.value = null
  me.error.value = null
  if (me.status.value === 'error') me.status.value = 'idle'
  const take = current.value
  if (!take || take.me !== me) return
  gen++
  take.abort.abort()
  release(take)
  current.value = null
  me.status.value = 'idle'
}

// The composer goes away: its own take is dropped so nothing lands in another
// draft; anyone else's take and the loaded engine are untouched.
function dispose(me: Facade) {
  me.dead = true
  cancel(me)
}

export function useDictation(): Dictation {
  const me: Facade = {
    dead: false,
    status: ref('idle'),
    error: ref(null),
    levels: ref([]),
    recMs: ref(0),
    progress: ref(null),
  }
  if (getCurrentScope()) onScopeDispose(() => dispose(me))
  return {
    status: computed(() => current.value && current.value.me !== me ? 'busy' : me.status.value),
    error: me.error,
    levels: me.levels,
    recMs: me.recMs,
    progress: me.progress,
    start: o => start(me, o),
    stop: () => stop(me),
    cancel: () => cancel(me),
    dispose: () => dispose(me),
  }
}
