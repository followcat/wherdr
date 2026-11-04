// On-device ASR: a Web Worker running sherpa-onnx WASM (offline models —
// SenseVoice-small or Qwen3-ASR, picked in Settings). The worker downloads
// the model into Cache Storage on first use, reports progress, then buffers
// Float32 PCM frames (16 kHz mono) and decodes the whole take in one shot on
// flush — neither model streams partials.
export type SpeechStatus = 'idle' | 'downloading' | 'loading' | 'ready' | 'recording' | 'flushing' | 'busy' | 'error'

interface DlProgress { file: string; got: number; total: number }
interface TakeStats { secs: number, rms: number, peak: number }

// A single take is capped — the buffered take is decoded at once on stop,
// and a forgotten recording should still end somewhere on a phone.
const MAX_RECORD_MS = 120_000
// Decode can take tens of seconds on a big model (Qwen3 on a phone); the
// flushing UI must not flip back to ready early.
const FLUSH_TIMEOUT_MS = 90_000
// Bump when the worker's message contract changes: the URL query defeats
// stale precached copies left behind by an older service worker.
const WORKER_V = '6'

// One engine for the whole app: loading a recognizer costs seconds (the
// models stay in Cache Storage, but the engine init does not), so the worker
// survives pane switches. Each useSpeech() call gets its own facade — split
// panes mount several composers, and a take belongs to the facade that
// started it: its text lands only in that draft, and another composer
// unmounting never tears the take down. While a take runs, other facades
// read status 'busy' and their mic press is refused.
let engine: ReturnType<typeof createEngine> | null = null
export function useSpeech() {
  return (engine ??= createEngine()).attach()
}

// Per-facade take state — everything a consumer reads about ITS take.
interface Facade {
  dead: boolean
  finalText: Ref<string>
  partial: Ref<string>
  segments: Ref<string[]>
  levels: Ref<number[]>
  recMs: Ref<number>
  take: Ref<TakeStats | null>
  decodeMs: Ref<number | null>
  lastCtx: Ref<string>
}

function clearTake(me: Facade) {
  me.partial.value = ''; me.finalText.value = ''; me.segments.value = []
  me.levels.value = []; me.recMs.value = 0
}

function createEngine() {
  const engineStatus = ref<SpeechStatus>('idle')
  const error = ref('')
  const phase = ref('')
  const dl = ref<DlProgress | null>(null)
  const loadMs = ref(0)
  const LEVELS_MAX = 40

  // The facade holding the live take — results route to it alone. A ref so
  // every facade's 'busy' status re-evaluates when ownership moves.
  const owner = shallowRef<Facade | null>(null)

  let worker: Worker | null = null
  let loadedModelId: string | null = null
  // Set by cancel/dispose: a take the caller abandoned. Its flush answer is
  // still coming — the 'final' for it is dropped, never shown or typed.
  let takeDead = false
  // Every facade waiting on the engine to load — a second caller must not
  // evict the first's promise.
  const readyWaiters = new Set<{ resolve: () => void, reject: (e: Error) => void }>()
  let ctx: AudioContext | null = null
  let node: ScriptProcessorNode | null = null
  let src: MediaStreamAudioSourceNode | null = null
  let media: MediaStream | null = null
  let capTimer: ReturnType<typeof setTimeout> | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let pendingCtx = ''

  const takeOf = (me: Facade | null) => me && !me.dead ? me : null

  function onMsg(e: MessageEvent) {
    const m = e.data
    if (m.t === 'phase') phase.value = m.phase
    else if (m.t === 'dl') dl.value = { file: m.file, got: m.got, total: m.total }
    else if (m.t === 'ready') {
      loadMs.value = m.loadMs
      if (engineStatus.value !== 'recording' && engineStatus.value !== 'flushing') engineStatus.value = 'ready'
      for (const w of readyWaiters) w.resolve(); readyWaiters.clear()
    }
    else if (m.t === 'partial') { const o = takeOf(owner.value); if (o) o.partial.value = m.text }
    else if (m.t === 'segment') { const o = takeOf(owner.value); if (o && m.text) { o.segments.value.push(m.text); o.partial.value = '' } }
    else if (m.t === 'final') {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      if (takeDead) { takeDead = false; owner.value = null; return }
      const o = takeOf(owner.value); owner.value = null
      if (o) {
        o.finalText.value = m.text; o.decodeMs.value = m.decodeMs; o.take.value = m.take || null
        o.lastCtx.value = typeof m.ctx === 'string' ? m.ctx : o.lastCtx.value
      }
      engineStatus.value = 'ready'
    }
    else if (m.t === 'error') {
      error.value = m.error
      owner.value = null
      teardownAudio()
      // A failed load leaves the worker permanently useless (no recognizer
      // and no stream) — kill it so the next mic press retries from scratch.
      // A runtime error mid-session is isolated by the worker's own try/catch,
      // so the engine stays usable.
      if (engineStatus.value === 'downloading' || engineStatus.value === 'loading') killWorker()
      for (const w of readyWaiters) w.reject(new Error(m.error)); readyWaiters.clear()
      engineStatus.value = 'error'
    }
  }

  function killWorker() {
    worker?.terminate(); worker = null
    for (const w of readyWaiters) w.reject(new Error('speech engine restarted')); readyWaiters.clear()
  }

  function ensure(): Promise<void> {
    // A model switch in Settings retires the worker: the old recognizer and
    // its weights stay loaded otherwise.
    if (worker && loadedModelId !== asrModelId.value) {
      killWorker(); engineStatus.value = 'idle'
      // A take on the retired engine cannot finish — release it cleanly.
      if (owner.value) { owner.value = null; teardownAudio() }
    }
    if (worker) {
      return engineStatus.value === 'downloading' || engineStatus.value === 'loading'
        ? new Promise((resolve, reject) => { readyWaiters.add({ resolve, reject }) })
        : Promise.resolve()
    }
    engineStatus.value = 'downloading'
    loadedModelId = asrModelId.value
    const model = ASR_MODELS[loadedModelId!]!
    worker = new Worker(`/workers/asr-worker.js?v=${WORKER_V}`)
    worker.onmessage = onMsg
    worker.onerror = (e) => {
      error.value = e.message || 'worker failed'
      owner.value = null
      teardownAudio(); killWorker(); engineStatus.value = 'error'
    }
    worker.postMessage({ t: 'load', wasmBase: '/wasm/', modelBase: model.base, kind: model.kind, files: model.files, providers: model.providers, cache: true })
    return new Promise((resolve, reject) => { readyWaiters.add({ resolve, reject }) })
  }

  // Each start gets a number; stop/cancel/dispose/a newer start bumps it, and
  // an in-flight start that wakes up stale drops what it grabbed instead of
  // recording into a dead component or leaking a second stream.
  let micGen = 0

  function claim(me: Facade) {
    if (me.dead) throw new Error('disposed')
    if (owner.value && owner.value !== me) throw new Error('The microphone is busy in another pane')
    owner.value = me
  }

  async function startMic(me: Facade, ctxText?: string) {
    claim(me)
    const gen = ++micGen
    try {
      await ensure()
      // Stale by now: a newer call re-claimed the take (owner stays me),
      // or cancel/dispose released it. Never touch owner here.
      if (gen !== micGen || me.dead || owner.value !== me) return
      // Dictation, not a call: hardware echo cancellation and noise suppression
      // are tuned to kill anything that isn't a loud near-field voice — on
      // Android they gate/distort quiet speech badly enough to break ASR.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      if (gen !== micGen || me.dead || owner.value !== me) { stream.getTracks().forEach(t => t.stop()); return }
      media = stream
      ctx = new AudioContext({ sampleRate: 16000 })
      if (ctx.state === 'suspended') await ctx.resume()
      if (gen !== micGen || me.dead || owner.value !== me) { teardownAudio(); return }
      src = ctx.createMediaStreamSource(media)
      node = ctx.createScriptProcessor(4096, 1, 1)
      // Not every device honors the requested context rate — resample the
      // captured rate rather than feeding the engine a wrong-speed stream.
      const inRate = ctx.sampleRate
      const resample = createResampler(inRate)
      pendingCtx = ctxText || ''
      takeDead = false
      me.levels.value = []
      me.recMs.value = 0
      node.onaudioprocess = (e) => {
        const raw = e.inputBuffer.getChannelData(0)
        const buf = resample(raw)
        worker?.postMessage({ t: 'push', pcm: buf.buffer }, [buf.buffer])
        // Two RMS bars per buffer feed the composer's live wave.
        const half = raw.length >> 1
        for (let h = 0; h < 2; h++) {
          let sum = 0
          for (let i = h * half; i < (h + 1) * half; i++) sum += raw[i]! * raw[i]!
          me.levels.value.push(Math.sqrt(sum / half))
        }
        me.recMs.value += Math.round(raw.length / inRate * 1000)
        if (me.levels.value.length > LEVELS_MAX) me.levels.value.splice(0, me.levels.value.length - LEVELS_MAX)
      }
      src.connect(node)
      // The script processor only fires onaudioprocess while it is pulled —
      // but wiring it straight to the output plays the mic back through the
      // speaker, and that echo is re-captured into the take (howling ruins
      // recognition). Route through silence instead.
      const mute = ctx.createGain()
      mute.gain.value = 0
      node.connect(mute)
      mute.connect(ctx.destination)
      me.partial.value = ''
      me.finalText.value = ''
      me.segments.value = []
      engineStatus.value = 'recording'
      capTimer = setTimeout(() => stopMic(me), MAX_RECORD_MS)
    } catch (err) {
      // A failed start (denied mic, dead AudioContext) must not leak the
      // stream it already grabbed or keep the take ownership.
      if (owner.value === me) owner.value = null
      teardownAudio()
      throw err
    }
  }

  // Detach the mic and audio graph without waiting for the worker — used by
  // stop, cancel and error paths so the system mic indicator drops at once.
  function teardownAudio() {
    if (capTimer) { clearTimeout(capTimer); capTimer = null }
    node?.disconnect(); src?.disconnect()
    node = null; src = null
    media?.getTracks().forEach(t => t.stop()); media = null
    ctx?.close(); ctx = null
  }

  function stopMic(me: Facade) {
    if (owner.value !== me) return
    micGen++
    const wasRecording = engineStatus.value === 'recording'
    teardownAudio()
    if (worker && wasRecording) {
      engineStatus.value = 'flushing'
      worker.postMessage({ t: 'flush', ctx: pendingCtx })
      armFlushTimer()
    } else { owner.value = null; engineStatus.value = 'ready' }
  }

  function armFlushTimer() {
    if (flushTimer) clearTimeout(flushTimer)
    // The worker always answers a flush, but a wedged decode must never
    // leave the composer stuck on "Recognizing…".
    flushTimer = setTimeout(() => {
      if (engineStatus.value === 'flushing') { owner.value = null; engineStatus.value = 'ready' }
    }, FLUSH_TIMEOUT_MS)
  }

  // Cancel = drop the audio and the result immediately; no tail decode.
  function cancelMic(me: Facade) {
    clearTake(me)
    if (owner.value !== me) return
    micGen++
    takeDead = true
    teardownAudio()
    worker?.postMessage({ t: 'reset' })
    owner.value = null
    engineStatus.value = 'ready'
  }

  function reset(me: Facade) {
    clearTake(me)
    // Another facade's take must not be disturbed.
    if (!owner.value || owner.value === me) worker?.postMessage({ t: 'reset' })
  }

  async function decodeBlob(me: Facade, blob: Blob, ctxText?: string) {
    claim(me)
    const gen = ++micGen
    try {
      await ensure()
      if (gen !== micGen || me.dead || owner.value !== me) return
      const ac = new OfflineAudioContext(1, 1, 16000)
      const decoded = await ac.decodeAudioData(await blob.arrayBuffer())
      if (gen !== micGen || me.dead || owner.value !== me) return
      const out = resampleTo16k(decoded.getChannelData(0), decoded.sampleRate)
      clearTake(me)
      takeDead = false
      engineStatus.value = 'flushing'
      const CH = 1600 // 100 ms
      for (let at = 0; at < out.length; at += CH) {
        const slice = out.slice(at, at + CH)
        worker?.postMessage({ t: 'push', pcm: slice.buffer }, [slice.buffer])
      }
      worker?.postMessage({ t: 'flush', ctx: ctxText || '' })
      armFlushTimer()
    } catch (err) {
      if (owner.value === me) { owner.value = null; if (engineStatus.value === 'flushing') engineStatus.value = 'ready' }
      throw err
    }
  }

  // The facade goes away: its own take (if it owns one) is dropped so
  // nothing lands in another draft — the shared engine and anyone else's
  // wait are untouched.
  function dispose(me: Facade) {
    me.dead = true
    clearTake(me)
    me.take.value = null; me.decodeMs.value = null
    if (owner.value !== me) return
    micGen++
    takeDead = true
    teardownAudio()
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    const midTake = engineStatus.value === 'recording' || engineStatus.value === 'flushing'
    if (midTake) worker?.postMessage({ t: 'reset' })
    owner.value = null
    if (midTake) engineStatus.value = worker ? 'ready' : 'idle'
  }

  function attach() {
    const me: Facade = {
      dead: false,
      finalText: ref(''),
      partial: ref(''),
      segments: ref<string[]>([]),
      levels: ref<number[]>([]),
      recMs: ref(0),
      take: ref<TakeStats | null>(null),
      decodeMs: ref<number | null>(null),
      lastCtx: ref(''),
    }
    const status = computed<SpeechStatus>(() => owner.value && owner.value !== me ? 'busy' : engineStatus.value)
    return {
      status, error, phase, dl, loadMs,
      partial: me.partial, segments: me.segments, finalText: me.finalText,
      decodeMs: me.decodeMs, take: me.take, levels: me.levels, recMs: me.recMs, lastCtx: me.lastCtx,
      installed: asrInstalled,
      ensure,
      startMic: (ctxText?: string) => startMic(me, ctxText),
      stopMic: () => stopMic(me),
      cancelMic: () => cancelMic(me),
      reset: () => reset(me),
      decodeBlob: (blob: Blob, ctxText?: string) => decodeBlob(me, blob, ctxText),
      dispose: () => dispose(me),
    }
  }

  return { attach }
}
