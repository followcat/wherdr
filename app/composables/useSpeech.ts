// On-device ASR: a Web Worker running sherpa-onnx WASM (offline models —
// SenseVoice-small or Qwen3-ASR, picked in Settings). The worker downloads
// the model into Cache Storage on first use, reports progress, then buffers
// Float32 PCM frames (16 kHz mono) and decodes the whole take in one shot on
// flush — neither model streams partials.
export type SpeechStatus = 'idle' | 'downloading' | 'loading' | 'ready' | 'recording' | 'flushing' | 'error'

interface DlProgress { file: string; got: number; total: number }

// A single take is capped — the buffered take is decoded at once on stop,
// and a forgotten recording should still end somewhere on a phone.
const MAX_RECORD_MS = 120_000
// Decode can take tens of seconds on a big model (Qwen3 on a phone); the
// flushing UI must not flip back to ready early.
const FLUSH_TIMEOUT_MS = 90_000

export function useSpeech() {
  const status = ref<SpeechStatus>('idle')
  const error = ref('')
  const phase = ref('')
  const dl = ref<DlProgress | null>(null)
  const partial = ref('')
  const segments = ref<string[]>([])
  const finalText = ref('')
  const loadMs = ref(0)
  const decodeMs = ref<number | null>(null)
  const take = ref<{ secs: number, rms: number, peak: number } | null>(null)

  let worker: Worker | null = null
  let loadedModelId: string | null = null
  let readyWaiter: { resolve: () => void, reject: (e: Error) => void } | null = null
  let ctx: AudioContext | null = null
  let node: ScriptProcessorNode | null = null
  let src: MediaStreamAudioSourceNode | null = null
  let media: MediaStream | null = null
  let capTimer: ReturnType<typeof setTimeout> | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function onMsg(e: MessageEvent) {
    const m = e.data
    if (m.t === 'phase') phase.value = m.phase
    else if (m.t === 'dl') dl.value = { file: m.file, got: m.got, total: m.total }
    else if (m.t === 'ready') {
      loadMs.value = m.loadMs
      if (status.value !== 'recording' && status.value !== 'flushing') status.value = 'ready'
      readyWaiter?.resolve(); readyWaiter = null
    }
    else if (m.t === 'partial') partial.value = m.text
    else if (m.t === 'segment') { if (m.text) segments.value.push(m.text); partial.value = '' }
    else if (m.t === 'final') {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      finalText.value = m.text; decodeMs.value = m.decodeMs; take.value = m.take || null; status.value = 'ready'
    }
    else if (m.t === 'error') {
      error.value = m.error
      teardownAudio()
      // A failed load leaves the worker permanently useless (no recognizer
      // and no stream) — kill it so the next mic press retries from scratch.
      // A runtime error mid-session is isolated by the worker's own try/catch,
      // so the engine stays usable.
      if (status.value === 'downloading' || status.value === 'loading') killWorker()
      readyWaiter?.reject(new Error(m.error)); readyWaiter = null
      status.value = 'error'
    }
  }

  function killWorker() {
    worker?.terminate(); worker = null
  }

  function ensure(): Promise<void> {
    // A model switch in Settings retires the worker: the old recognizer and
    // its weights stay loaded otherwise.
    if (worker && loadedModelId !== asrModelId.value) { killWorker(); status.value = 'idle' }
    if (worker) {
      return status.value === 'downloading' || status.value === 'loading'
        ? new Promise((resolve, reject) => { readyWaiter = { resolve, reject } })
        : Promise.resolve()
    }
    status.value = 'downloading'
    loadedModelId = asrModelId.value
    const model = ASR_MODELS[loadedModelId!]!
    worker = new Worker('/workers/asr-worker.js')
    worker.onmessage = onMsg
    worker.onerror = (e) => {
      error.value = e.message || 'worker failed'
      teardownAudio(); killWorker(); status.value = 'error'
    }
    worker.postMessage({ t: 'load', wasmBase: '/wasm/', modelBase: model.base, kind: model.kind, files: model.files, providers: model.providers, cache: true })
    return new Promise((resolve, reject) => { readyWaiter = { resolve, reject } })
  }

  async function startMic() {
    await ensure()
    // Dictation, not a call: hardware echo cancellation and noise suppression
    // are tuned to kill anything that isn't a loud near-field voice — on
    // Android they gate/distort quiet speech badly enough to break ASR.
    media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    ctx = new AudioContext({ sampleRate: 16000 })
    if (ctx.state === 'suspended') await ctx.resume()
    src = ctx.createMediaStreamSource(media)
    node = ctx.createScriptProcessor(4096, 1, 1)
    // Not every device honors the requested context rate — resample the
    // captured rate rather than feeding the engine a wrong-speed stream.
    const inRate = ctx.sampleRate
    node.onaudioprocess = (e) => {
      const buf = resampleTo16k(e.inputBuffer.getChannelData(0).slice(0), inRate)
      worker?.postMessage({ t: 'push', pcm: buf.buffer }, [buf.buffer])
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
    partial.value = ''
    finalText.value = ''
    segments.value = []
    status.value = 'recording'
    capTimer = setTimeout(() => stopMic(), MAX_RECORD_MS)
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

  function stopMic() {
    const wasRecording = status.value === 'recording'
    teardownAudio()
    if (worker && wasRecording) {
      status.value = 'flushing'
      worker.postMessage({ t: 'flush' })
      // The worker always answers a flush, but a wedged decode must never
      // leave the composer stuck on "Recognizing…".
      flushTimer = setTimeout(() => { if (status.value === 'flushing') status.value = 'ready' }, FLUSH_TIMEOUT_MS)
    } else status.value = 'ready'
  }

  // Cancel = drop the audio and the result immediately; no tail decode.
  function cancelMic() {
    teardownAudio()
    worker?.postMessage({ t: 'reset' })
    partial.value = ''; finalText.value = ''; segments.value = []
    status.value = 'ready'
  }

  function reset() {
    worker?.postMessage({ t: 'reset' })
    partial.value = ''; finalText.value = ''; segments.value = []
  }

  async function decodeBlob(blob: Blob) {
    await ensure()
    const ac = new OfflineAudioContext(1, 1, 16000)
    const decoded = await ac.decodeAudioData(await blob.arrayBuffer())
    const out = resampleTo16k(decoded.getChannelData(0), decoded.sampleRate)
    reset()
    status.value = 'flushing'
    const CH = 1600 // 100 ms
    for (let at = 0; at < out.length; at += CH) {
      const slice = out.slice(at, at + CH)
      worker?.postMessage({ t: 'push', pcm: slice.buffer }, [slice.buffer])
    }
    worker?.postMessage({ t: 'flush' })
  }

  function dispose() {
    teardownAudio()
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    worker?.terminate(); worker = null
    readyWaiter?.reject(new Error('disposed')); readyWaiter = null
    status.value = 'idle'
  }

  return { status, error, phase, dl, partial, segments, finalText, loadMs, decodeMs, take, installed: asrInstalled, ensure, startMic, stopMic, cancelMic, reset, decodeBlob, dispose }
}
