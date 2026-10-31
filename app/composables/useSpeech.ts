// On-device ASR: a Web Worker running sherpa-onnx WASM (streaming zipformer).
// The worker downloads the model into Cache Storage on first use, reports
// progress, then accepts Float32 PCM frames (16 kHz mono).
export type SpeechStatus = 'idle' | 'downloading' | 'loading' | 'ready' | 'recording' | 'flushing' | 'error'

interface DlProgress { file: string; got: number; total: number }

const MODEL = {
  base: '/models/asr-zipformer-zh-en',
  files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', joiner: 'joiner.int8.onnx', tokens: 'tokens.txt' },
}

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

  let worker: Worker | null = null
  let ctx: AudioContext | null = null
  let node: ScriptProcessorNode | null = null
  let src: MediaStreamAudioSourceNode | null = null
  let media: MediaStream | null = null

  function onMsg(e: MessageEvent) {
    const m = e.data
    if (m.t === 'phase') phase.value = m.phase
    else if (m.t === 'dl') dl.value = { file: m.file, got: m.got, total: m.total }
    else if (m.t === 'ready') { loadMs.value = m.loadMs; status.value = 'ready' }
    else if (m.t === 'partial') partial.value = m.text
    else if (m.t === 'segment') { if (m.text) segments.value.push(m.text); partial.value = '' }
    else if (m.t === 'final') { finalText.value = m.text; decodeMs.value = m.decodeMs; status.value = 'ready' }
    else if (m.t === 'error') { error.value = m.error; status.value = 'error' }
  }

  async function ensure() {
    if (worker) return
    status.value = 'downloading'
    worker = new Worker('/workers/asr-worker.js')
    worker.onmessage = onMsg
    worker.onerror = (e) => { error.value = e.message || 'worker failed'; status.value = 'error' }
    worker.postMessage({ t: 'load', wasmBase: '/wasm/', modelBase: MODEL.base, files: MODEL.files, cache: true })
  }

  async function startMic() {
    await ensure()
    media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    ctx = new AudioContext({ sampleRate: 16000 })
    src = ctx.createMediaStreamSource(media)
    node = ctx.createScriptProcessor(4096, 1, 1)
    node.onaudioprocess = (e) => {
      const buf = e.inputBuffer.getChannelData(0).slice(0)
      worker?.postMessage({ t: 'push', pcm: buf.buffer }, [buf.buffer])
    }
    src.connect(node)
    node.connect(ctx.destination)
    partial.value = ''
    finalText.value = ''
    segments.value = []
    status.value = 'recording'
  }

  function stopMic() {
    node?.disconnect(); src?.disconnect()
    node = null; src = null
    media?.getTracks().forEach(t => t.stop()); media = null
    ctx?.close(); ctx = null
    if (worker) { status.value = 'flushing'; worker.postMessage({ t: 'flush' }) }
    else status.value = 'ready'
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
    stopMic()
    worker?.terminate(); worker = null
    status.value = 'idle'
  }

  return { status, error, phase, dl, partial, segments, finalText, loadMs, decodeMs, ensure, startMic, stopMic, reset, decodeBlob, dispose }
}
