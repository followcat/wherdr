// The neural read-aloud engine (app/utils/speech/neuralVoice.ts) against a
// worker that speaks the TTS worker's protocol and a fake WebAudio clock.
import { afterEach, describe, expect, it } from 'vitest'
import { DEVICE_CACHE } from '../app/utils/dictation/deviceModels'
import { LOOKAHEAD, VOICES, createNeuralVoice, defaultVoice, heapEstimate, heapNeeded, replyLanguage } from '../app/utils/speech/neuralVoice'
import { fakeCaches } from './fakeModelCache'

const siwis = VOICES.find(v => v.id === 'siwis-medium')!

class FakeWorker {
  static made: FakeWorker[] = []
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: { message: string }) => void) | null = null
  got: { t: string, id?: string, text?: string }[] = []
  terminated = false
  constructor() { FakeWorker.made.push(this) }
  postMessage(m: { t: string, id?: string }) {
    this.got.push(m)
    if (m.t === 'load') this.send({ t: 'ready', heap: 1, ms: 800, sampleRate: 10 })
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

async function make(o: { installed?: boolean, budget?: number | null, idleMs?: number } = {}) {
  const caches = fakeCaches()
  if (o.installed !== false) {
    const cache = await caches.open(DEVICE_CACHE)
    for (const m of siwis.members) await cache.put(`/models/${siwis.dir}/${m.path}`, new Response(''))
  }
  const voice = createNeuralVoice({
    caches,
    budget: o.budget ?? null,
    idleMs: o.idleMs ?? 60_000,
    worker: () => new FakeWorker() as unknown as Worker,
    audio: () => new FakeAudio() as unknown as AudioContext,
  })
  await voice.refresh()
  return voice
}

function reply(chunks: string[]) {
  const seen: string[] = []
  return { seen, opts: { voice: siwis, chunks, onEnd: () => seen.push('end'), onError: (e: Error) => seen.push(`error: ${e.message}`) } }
}

afterEach(() => {
  FakeWorker.made = []
  FakeAudio.made = []
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
    expect(replyLanguage('Le build est passé, je relance les tests.')).toBe('fr')
    expect(replyLanguage('The build passed; I rerun the tests and push the fix.')).toBe('en')
  })
})
