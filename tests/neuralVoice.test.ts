// The neural read-aloud engine (app/utils/speech/neuralVoice.ts) against a
// worker that speaks the TTS worker's protocol and a fake WebAudio clock.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEVICE_CACHE } from '../app/utils/dictation/deviceModels'
import { CANTO_WORKER_URL, LOOKAHEAD, NEURAL_INSTALLED_KEY, VOICES, createNeuralVoice, defaultVoice, heapEstimate, heapNeeded, replyLanguage } from '../app/utils/speech/neuralVoice'
import { fakeCaches } from './fakeModelCache'

const siwis = VOICES.find(v => v.id === 'siwis-medium')!
const canto = VOICES.find(v => v.id === 'canto-nano-int8')!
const cantoGpu = VOICES.find(v => v.id === 'canto-nano-fp16-gpu')!

class FakeWorker {
  static made: FakeWorker[] = []
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: { message: string }) => void) | null = null
  got: { t: string, id?: string, text?: string }[] = []
  terminated = false
  constructor(public auto = true) { FakeWorker.made.push(this) }
  postMessage(m: { t: string, id?: string }) {
    this.got.push(m)
    if (m.t === 'load' && this.auto) this.send({ t: 'ready', heap: 1, ms: 800, sampleRate: 10 })
  }
  send(data: unknown) { if (!this.terminated) this.onmessage?.({ data }) }
  // The audio of a sentence asked for: `n` samples at 10 Hz.
  answer(id: string, n = 10, ms = 0, heap = 0) { this.send({ t: 'audio', id, pcm: new Float32Array(n).buffer, sampleRate: 10, ms, heap }) }
  asked() { return this.got.filter(m => m.t === 'speak').map(m => m.id!) }
  terminate() { this.terminated = true }
}

class FakeSource {
  buffer: { duration: number } | null = null
  at = -1
  stopped = false
  onended: (() => void) | null = null
  connect() {}
  start(at: number) { this.at = at }
  stop() { this.stopped = true }
}

class FakeAudio {
  static made: FakeAudio[] = []
  state = 'running'
  currentTime = 0
  sources: FakeSource[] = []
  destination = {}
  constructor() { FakeAudio.made.push(this) }
  resume = async () => {}
  close = async () => { this.state = 'closed' }
  createBuffer(_c: number, length: number, rate: number) { return { duration: length / rate, getChannelData: () => new Float32Array(length) } }
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s }
}

const tick = () => new Promise(r => setTimeout(r, 0))

async function make(o: { installed?: boolean, budget?: number | null, idleMs?: number, suspendMs?: number } = {}) {
  const caches = fakeCaches()
  if (o.installed !== false) {
    const cache = await caches.open(DEVICE_CACHE)
    for (const m of siwis.members) await cache.put(`/models/${siwis.dir}/${m.path}`, new Response(''))
  }
  const voice = createNeuralVoice({
    caches,
    budget: o.budget ?? null,
    idleMs: o.idleMs ?? 60_000,
    suspendMs: o.suspendMs,
    worker: () => new FakeWorker() as unknown as Worker,
    audio: () => new FakeAudio() as unknown as AudioContext,
  })
  await voice.refresh()
  return voice
}

// An in-memory localStorage: the "installed once" record and the crash marks.
function fakeStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) },
  })
  return data
}

function reply(chunks: string[]) {
  const seen: string[] = []
  return { seen, opts: { voice: siwis, chunks, onEnd: () => seen.push('end'), onError: (e: Error) => seen.push(`error: ${e.message}`) } }
}

afterEach(() => {
  FakeWorker.made = []
  FakeAudio.made = []
  vi.unstubAllGlobals()
})

describe('the neural voice', () => {
  it('asks a few sentences ahead, plays them in order back to back, and ends after the last', async () => {
    const voice = await make()
    const { seen, opts } = reply(['One.', 'Two.', 'Three.', 'Four.', 'Five.'])
    expect(voice.speak(opts)).toBe(true)
    const w = FakeWorker.made[0]!
    expect(w.got[0]).toMatchObject({ t: 'load', base: `/models/${siwis.dir}`, model: siwis.model, cache: DEVICE_CACHE })
    // The playing sentence and LOOKAHEAD more, no further.
    expect(w.asked()).toHaveLength(LOOKAHEAD + 1)
    expect(w.asked()).toEqual(['1.0', '1.1', '1.2'])
    expect(w.got.find(m => m.id === '1.0')?.text).toBe('One.')

    // Out of order from the worker: still played in order, gapless.
    w.answer('1.1', 20)
    const ctx = FakeAudio.made[0]!
    expect(ctx.sources).toHaveLength(0)
    w.answer('1.0', 10)
    expect(ctx.sources.map(s => s.at)).toEqual([0, 1])

    ctx.sources[0]!.onended!()
    expect(w.asked()).toContain('1.3') // one ended, one more asked for
    w.answer('1.2'); w.answer('1.3')
    ctx.sources[1]!.onended!(); ctx.sources[2]!.onended!()
    w.answer('1.4')
    ctx.sources[3]!.onended!()
    expect(seen).toEqual([])
    ctx.sources[4]!.onended!()
    expect(seen).toEqual(['end'])
  })

  it('ends a reply whose sentence came back with no part at all', async () => {
    const voice = await make()
    const { seen, opts } = reply(['🎉', 'Two.'])
    voice.speak(opts)
    const w = FakeWorker.made[0]!
    // The text front end gives an emoji-only sentence no word: parts: 0 and
    // no audio. The reply must not hang on it (silence + a stuck Stop).
    w.send({ t: 'parts', id: '1.0', count: 0 })
    w.answer('1.1')
    const ctx = FakeAudio.made[0]!
    ctx.sources[0]!.onended!()
    expect(seen).toEqual(['end'])
  })

  it('stops mid-reply, and drops the audio that comes back for it afterwards', async () => {
    const voice = await make()
    const first = reply(['One.', 'Two.', 'Three.'])
    voice.speak(first.opts)
    const w = FakeWorker.made[0]!
    const ctx = FakeAudio.made[0]!
    w.answer('1.0')
    voice.stop()
    expect(ctx.sources[0]!.stopped).toBe(true)

    const second = reply(['Next.'])
    voice.speak(second.opts)
    expect(FakeWorker.made).toHaveLength(1) // the loaded voice is kept
    w.answer('1.1') // late, from the stopped reply
    expect(ctx.sources).toHaveLength(1)
    w.answer('2.0')
    expect(ctx.sources).toHaveLength(2)
    ctx.sources[1]!.onended!()
    expect(first.seen).toEqual([])
    expect(second.seen).toEqual(['end'])
  })

  it('releases the worker and the audio after a while without speech, and loads again on the next tap', async () => {
    const voice = await make({ idleMs: 5 })
    const { seen, opts } = reply(['One.'])
    voice.speak(opts)
    FakeWorker.made[0]!.answer('1.0')
    FakeAudio.made[0]!.sources[0]!.onended!()
    expect(seen).toEqual(['end'])
    await new Promise(r => setTimeout(r, 20))
    expect(FakeWorker.made[0]!.terminated).toBe(true)
    expect(FakeAudio.made[0]!.state).toBe('closed')

    voice.speak(reply(['Again.']).opts)
    expect(FakeWorker.made).toHaveLength(2)
    expect(FakeAudio.made).toHaveLength(2)
  })

  it('leaves a voice not installed, or too large for this device, to the system voices', async () => {
    const missing = await make({ installed: false })
    expect(missing.speak(reply(['One.']).opts)).toBe(false)
    const small = await make({ budget: heapEstimate(siwis) - 1 })
    expect(small.speak(reply(['One.']).opts)).toBe(false)
    expect(FakeWorker.made).toHaveLength(0)
    expect(FakeAudio.made).toHaveLength(0)
  })

  it('measures the reply: load, first sentence, generation time against speech length, largest heap', async () => {
    const voice = await make()
    voice.speak(reply(['One.', 'Two.']).opts)
    const w = FakeWorker.made[0]!
    w.answer('1.0', 10, 200, 5) // 1 s of speech in 200 ms
    w.answer('1.1', 20, 300, 3)
    expect(voice.stats()).toMatchObject({ voice: siwis.id, loadMs: 800, genMs: 500, audioMs: 3000, heap: 5 })
    expect(voice.stats()!.firstMs).toBeGreaterThanOrEqual(0)
  })

  it('checks the budget against the measured heap when the catalog has one, else the estimate', () => {
    expect(heapNeeded(siwis)).toBe(siwis.memory ? Math.max(siwis.memory.heap, siwis.memory.speaking ?? 0) : heapEstimate(siwis))
    expect(heapNeeded({ ...siwis, memory: { heap: 100, speaking: 150, basis: 'test' } })).toBe(150)
  })

  it('stops the reply with the error when the worker fails', async () => {
    const voice = await make()
    const { seen, opts } = reply(['One.', 'Two.'])
    voice.speak(opts)
    FakeWorker.made[0]!.send({ t: 'error', id: '1.0', error: 'bad text' })
    await tick()
    expect(seen).toEqual(['error: bad text'])
    expect(FakeWorker.made[0]!.terminated).toBe(true)
  })

  it('picks the default voice of the first device language it speaks, else English, and guesses a reply’s language', () => {
    expect(defaultVoice(['de-DE', 'fr-FR']).id).toBe('siwis-medium')
    expect(defaultVoice(['de-DE']).id).toBe('cori-medium')
    expect(defaultVoice(['yue']).id).toBe('canto-nano-int8')
    expect(replyLanguage('Le build est passé, je relance les tests.')).toBe('fr')
    expect(replyLanguage('The build passed; I rerun the tests and push the fix.')).toBe('en')
    expect(replyLanguage('今日天氣幾好，我想出街行吓。')).toBe('yue')
    // Kana means Japanese: the Cantonese voice is not chosen.
    expect(replyLanguage('今日はいい天気ですね。')).not.toBe('yue')
  })

  it('accepts the GPU voice only with WebGPU and shader-f16', async () => {
    const make = async (features: string[]) => {
      vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ features: new Set(features) }) } })
      const voice = createNeuralVoice({
        caches: fakeCaches(),
        budget: null,
        worker: () => new FakeWorker() as unknown as Worker,
        audio: () => new FakeAudio() as unknown as AudioContext,
      })
      return { voice, ok: await voice.gpuCheck() }
    }
    const without = await make([])
    expect(without.ok).toBe(false)
    expect(without.voice.supports(cantoGpu)).toBe(false)
    expect(without.voice.supports(canto)).toBe(true)
    const withF16 = await make(['shader-f16'])
    expect(withF16.ok).toBe(true)
    expect(withF16.voice.supports(cantoGpu)).toBe(true)
  })

  const installFiles = async (caches: CacheStorage, v: typeof canto) => {
    const cache = await caches.open(DEVICE_CACHE)
    for (const m of v.members) await cache.put(`/models/${(m as { dir?: string }).dir ?? v.dir}/${m.path}`, new Response(''))
  }
  const gpu = (features: string[]) => vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ features: new Set(features) }) } })
  const engine = (caches: CacheStorage, budget: number | null = null) => createNeuralVoice({
    caches,
    budget,
    worker: () => new FakeWorker() as unknown as Worker,
    audio: () => new FakeAudio() as unknown as AudioContext,
  })

  it('reads a language with its other installed voice when the catalog default is not usable', async () => {
    // The staging case: only the GPU voice is installed on this device. A
    // Cantonese reply must be spoken by it, not routed to the absent INT8
    // default (which made Play fall back to a silent device voice).
    gpu(['shader-f16'])
    const caches = fakeCaches()
    await installFiles(caches, cantoGpu)
    const voice = engine(caches)
    await voice.gpuCheck()
    await voice.refresh()
    expect(voice.voiceFor('yue', '').id).toBe('canto-nano-fp16-gpu')
    const { opts } = reply(['今日天氣幾好。'])
    opts.voice = voice.voiceFor('yue', '')
    expect(voice.speak(opts)).toBe(true)
  })

  it('keeps the saved choice and the catalog default ahead of another usable voice', async () => {
    gpu(['shader-f16'])
    const caches = fakeCaches()
    await installFiles(caches, canto)
    await installFiles(caches, cantoGpu)
    const voice = engine(caches)
    await voice.gpuCheck()
    await voice.refresh()
    // No saved choice: the INT8 default still reads Cantonese.
    expect(voice.voiceFor('yue', '').id).toBe('canto-nano-int8')
    // The saved choice wins over the default, and a choice of another
    // language never leaks into this one.
    expect(voice.voiceFor('yue', 'canto-nano-fp16-gpu').id).toBe('canto-nano-fp16-gpu')
    expect(voice.voiceFor('yue', 'siwis-medium').id).toBe('canto-nano-int8')
    // A saved choice that can no longer run falls to the usable voice.
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ features: new Set() }) } })
    const noGpu = engine(caches)
    await noGpu.gpuCheck()
    await noGpu.refresh()
    expect(noGpu.voiceFor('yue', 'canto-nano-fp16-gpu').id).toBe('canto-nano-int8')
  })

  it('falls back to the catalog default when no voice of the language can run', async () => {
    gpu(['shader-f16'])
    const voice = engine(fakeCaches())
    await voice.gpuCheck()
    await voice.refresh()
    // Nothing installed: speak() refuses it and the caller uses the device's voices.
    expect(voice.voiceFor('yue', '').id).toBe('canto-nano-int8')
    expect(voice.speak({ voice: voice.voiceFor('yue', ''), chunks: ['今日。'], onEnd: () => {}, onError: () => {} })).toBe(false)
  })

  it('lets the worker be the gate while the GPU check is still pending', async () => {
    gpu(['shader-f16'])
    const caches = fakeCaches()
    await installFiles(caches, cantoGpu)
    const voice = engine(caches)
    // Synchronously after construction the adapter answer has not landed yet:
    // an installed WebGPU voice is not refused on a pending check (a tap right
    // after the page loads); the worker re-checks shader-f16 and fails loudly.
    expect(voice.supports(cantoGpu)).toBe(true)
    await voice.refresh()
    expect(voice.voiceFor('yue', '').id).toBe('canto-nano-fp16-gpu')
    const { opts } = reply(['今日。'])
    opts.voice = voice.voiceFor('yue', '')
    expect(voice.speak(opts)).toBe(true)
  })

  it('tries a voice the device held once, its files verified or not', async () => {
    // The record answered by install() keeps a voice usable past refresh()'s
    // answer and past the browser pruning Cache Storage (iOS does): the
    // worker streams what the cache lost or fails with a visible error,
    // never a silent pass to the device's voices.
    gpu(['shader-f16'])
    const data = fakeStorage({ [NEURAL_INSTALLED_KEY]: JSON.stringify(['canto-nano-fp16-gpu']) })
    const voice = engine(fakeCaches())
    await voice.gpuCheck()
    // No refresh() at all: the record answers for the tap.
    expect(voice.usable(cantoGpu)).toBe(true)
    expect(voice.voiceFor('yue', '').id).toBe('canto-nano-fp16-gpu')
    // Files verified gone (the browser pruned them): still tried.
    await voice.refresh()
    expect(voice.usable(cantoGpu)).toBe(true)
    // The record dropped (as remove() does): the device fallback is back.
    data.delete(NEURAL_INSTALLED_KEY)
    expect(voice.usable(cantoGpu)).toBe(false)
  })

  it('names why a voice refused a reply', async () => {
    gpu(['shader-f16'])
    const data = fakeStorage()
    const voice = engine(fakeCaches())
    await voice.gpuCheck()
    await voice.refresh()
    expect(voice.whyNot(canto)).toBe('not-installed')
    expect(voice.whyNot(cantoGpu)).toBe('not-installed')
    // A crash mark stays until Try again clears it.
    data.set('dictationTooLarge', JSON.stringify({ 'canto-nano-int8': 'oom' }))
    expect(voice.whyNot(canto)).toBe('marked')
    data.delete('dictationTooLarge')
    // WebGPU absent or without shader-f16.
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ features: new Set() }) } })
    const noF16 = engine(fakeCaches())
    await noF16.gpuCheck()
    expect(noF16.whyNot(cantoGpu)).toBe('unsupported')
    // A device too small for the voice.
    const small = engine(fakeCaches(), 1)
    expect(small.whyNot(canto)).toBe('budget')
    // An installed, fitting, supported voice: no refusal.
    const caches = fakeCaches()
    await installFiles(caches, canto)
    const ok = engine(caches)
    await ok.gpuCheck()
    await ok.refresh()
    expect(ok.whyNot(canto)).toBeNull()
  })

  it('says so when the voice stops answering', async () => {
    // A worker killed silently or a download that stalls never posts ready:
    // an error, not a silent reply stuck on Stop.
    const caches = fakeCaches()
    const cache = await caches.open(DEVICE_CACHE)
    for (const m of siwis.members) await cache.put(`/models/${siwis.dir}/${m.path}`, new Response(''))
    const voice = createNeuralVoice({
      caches,
      budget: null,
      stallMs: 40,
      worker: () => new FakeWorker(false) as unknown as Worker,
      audio: () => new FakeAudio() as unknown as AudioContext,
    })
    await voice.refresh()
    const { seen, opts } = reply(['One.'])
    expect(voice.speak(opts)).toBe(true)
    await new Promise(r => setTimeout(r, 80))
    expect(seen).toEqual(['error: the voice stopped answering'])
  })

  it('says so when the voice worker cannot even start', async () => {
    // A platform that refuses the Worker itself: an error, not a silent
    // pass to the device's voices.
    const caches = fakeCaches()
    const cache = await caches.open(DEVICE_CACHE)
    for (const m of siwis.members) await cache.put(`/models/${siwis.dir}/${m.path}`, new Response(''))
    const voice = createNeuralVoice({
      caches,
      budget: null,
      worker: () => { throw new Error('worker refused') },
      audio: () => new FakeAudio() as unknown as AudioContext,
    })
    await voice.refresh()
    const { seen, opts } = reply(['One.'])
    expect(voice.speak(opts)).toBe(true)
    await new Promise(r => setTimeout(r, 10))
    expect(seen).toEqual(['error: worker refused'])
  })

  it('says so when a part the audio graph refuses arrives', async () => {
    // A throw inside the message dispatch — scheduling a malformed part, say —
    // is an error, not a stall waited out.
    const caches = fakeCaches()
    const cache = await caches.open(DEVICE_CACHE)
    for (const m of siwis.members) await cache.put(`/models/${siwis.dir}/${m.path}`, new Response(''))
    const broken = new FakeAudio()
    broken.createBuffer = () => { throw new Error('the audio part was malformed') }
    const voice = createNeuralVoice({
      caches,
      budget: null,
      worker: () => new FakeWorker() as unknown as Worker,
      audio: () => broken as unknown as AudioContext,
    })
    await voice.refresh()
    const { seen, opts } = reply(['One.'])
    expect(voice.speak(opts)).toBe(true)
    const w = FakeWorker.made.at(-1)!
    w.answer(w.asked()[0]!, 10)
    expect(seen).toEqual(['error: the audio part was malformed'])
  })

  it('says so when the audio output never resumes', async () => {
    // iOS keeps the AudioContext suspended when an interruption owns the
    // audio session: the worker answers, nothing plays, no source ever ends.
    // The refusal is an error, not a silent reply stuck on Stop.
    const voice = await make({ suspendMs: 40 })
    const { seen, opts } = reply(['One.'])
    expect(voice.speak(opts)).toBe(true)
    FakeAudio.made[0]!.state = 'suspended'
    await new Promise(r => setTimeout(r, 80))
    expect(seen).toEqual(['error: the audio output stayed suspended'])
  })

  it('selects the Canto worker with its kind and runtime', async () => {
    const caches = fakeCaches()
    const cache = await caches.open(DEVICE_CACHE)
    for (const m of canto.members) await cache.put(`/models/${(m as { dir?: string }).dir ?? canto.dir}/${m.path}`, new Response(''))
    let url = ''
    const voice = createNeuralVoice({
      caches,
      budget: null,
      worker: (u) => { url = u; return new FakeWorker() as unknown as Worker },
      audio: () => new FakeAudio() as unknown as AudioContext,
    })
    await voice.refresh()
    const { opts } = reply(['One.'])
    opts.voice = canto
    expect(voice.speak(opts)).toBe(true)
    expect(url).toBe(CANTO_WORKER_URL)
    expect(FakeWorker.made[0]!.got[0]).toMatchObject({
      t: 'load',
      kind: 'cantoNano',
      runtime: '/models/runtime/onnxruntime-web-1.23.2/',
      base: `/models/${canto.dir}`,
    })
  })
})
