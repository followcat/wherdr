// useDictation: one take at a time, owned by the composer that started it;
// the mic opens on press and the take survives a slow engine.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { createFakeEngine } from './fakeDictationEngine'
import type { FakeEngine } from './fakeDictationEngine'
import { ENGINES, disposeEngines } from '../app/utils/dictation/registry'
import { MAX_TAKE_MS, TRANSCRIBE_TIMEOUT_MS, useDictation } from '../app/composables/useDictation'

const RATE = 48000

class FakeAudioContext {
  static last: FakeAudioContext
  state = 'running'
  sampleRate = RATE
  destination = {}
  closed = false
  processor: { onaudioprocess: ((e: unknown) => void) | null } | null = null
  constructor() { FakeAudioContext.last = this }
  async resume() {}
  async close() { this.closed = true }
  createMediaStreamSource() { return { connect() {}, disconnect() {} } }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
  createScriptProcessor() {
    this.processor = { onaudioprocess: null, connect() {}, disconnect() {} } as never
    return this.processor
  }

  // One 4096-sample buffer of a 0.5 amplitude square wave.
  feed(buffers = 1) {
    for (let i = 0; i < buffers; i++) {
      const data = Float32Array.from({ length: 4096 }, (_, j) => j % 2 ? 0.5 : -0.5)
      this.processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => data } })
    }
  }
}

function fakeStream() {
  const tracks = [{ stopped: false, stop() { this.stopped = true } }]
  return { tracks, getTracks: () => tracks }
}

let engine: FakeEngine
let getUserMedia: ReturnType<typeof vi.fn>
const tick = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  engine = createFakeEngine({ text: ' hello pane ' })
  ENGINES.device = async () => engine
  vi.stubGlobal('AudioContext', FakeAudioContext)
  getUserMedia = vi.fn(async () => fakeStream())
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
})

afterEach(() => {
  disposeEngines()
  delete ENGINES.device
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function setup() {
  const texts: string[] = []
  const d = useDictation()
  const start = (terms?: string[]) => d.start({ engine: 'device', language: 'fr', terms, onText: t => texts.push(t) })
  return { d, texts, start }
}

describe('useDictation', () => {
  it('records a take at 16 kHz and hands its text to the composer', async () => {
    const { d, texts, start } = setup()
    await start(['wherdr'])
    expect(d.status.value).toBe('recording')
    const ctx = FakeAudioContext.last
    const stream = await getUserMedia.mock.results[0]!.value
    ctx.feed(3)
    expect(d.levels.value).toHaveLength(6)
    expect(d.levels.value[0]).toBeCloseTo(0.5)
    expect(d.recMs.value).toBe(256)
    const stopping = d.stop()
    // The mic drops at once, before the engine answers.
    expect(stream.tracks[0].stopped).toBe(true)
    expect(ctx.closed).toBe(true)
    expect(d.status.value).toBe('transcribing')
    await stopping
    expect(engine.takes[0]!.pcm.length).toBe(4096)
    expect(engine.calls[0]).toMatchObject({ language: 'fr', terms: ['wherdr'] })
    expect(texts).toEqual(['hello pane'])
    expect(d.status.value).toBe('idle')
  })

  it('runs the optional rewrite after the transcript, and cancel drops it', async () => {
    const { d, texts } = setup()
    let release: (v: string) => void = () => {}
    const rewrite = vi.fn((_t: string, _s: AbortSignal) => new Promise<string>((r) => { release = r }))
    const go = () => d.start({ engine: 'device', onText: t => texts.push(t), rewrite })
    await go()
    FakeAudioContext.last.feed()
    let stopping = d.stop()
    await vi.waitFor(() => expect(d.status.value).toBe('rewriting'))
    expect(rewrite.mock.calls[0]![0]).toBe('hello pane')
    release('Hello, pane.')
    await stopping
    expect(texts).toEqual(['Hello, pane.'])
    expect(d.status.value).toBe('idle')

    await go()
    FakeAudioContext.last.feed()
    stopping = d.stop()
    await vi.waitFor(() => expect(d.status.value).toBe('rewriting'))
    d.cancel()
    expect(rewrite.mock.calls[1]![1].aborted).toBe(true)
    release('late')
    await stopping
    expect(texts).toEqual(['Hello, pane.'])
  })

  it('keeps the PCM while the engine prepares and transcribes it after', async () => {
    const open = engine.holdPrepare()
    const { d, texts, start } = setup()
    await start()
    // The mic is live before the engine is ready.
    expect(d.status.value).toBe('recording')
    FakeAudioContext.last.feed(6)
    const stopping = d.stop()
    await tick()
    expect(d.status.value).toBe('transcribing')
    expect(engine.takes).toHaveLength(0)
    open()
    await stopping
    expect(engine.takes[0]!.pcm.length).toBe(8192)
    expect(texts).toEqual(['hello pane'])
  })

  it('cancel drops the take while recording and while transcribing', async () => {
    engine = createFakeEngine({ delayMs: 1000 })
    const { d, texts, start } = setup()
    await start()
    FakeAudioContext.last.feed()
    d.cancel()
    expect(d.status.value).toBe('idle')
    expect(d.levels.value).toEqual([])
    expect(FakeAudioContext.last.closed).toBe(true)

    await start()
    FakeAudioContext.last.feed()
    const stopping = d.stop()
    await tick()
    expect(d.status.value).toBe('transcribing')
    d.cancel()
    await stopping
    expect(engine.calls[0]!.signal.aborted).toBe(true)
    expect(texts).toEqual([])
    expect(d.status.value).toBe('idle')
  })

  it('belongs to one composer: the other reads busy and its unmount changes nothing', async () => {
    const a = setup()
    const scope = effectScope()
    const b = scope.run(setup)!
    await a.start()
    expect(b.d.status.value).toBe('busy')
    await expect(b.start()).rejects.toThrow('busy')
    scope.stop() // b's composer unmounts
    expect(a.d.status.value).toBe('recording')
    FakeAudioContext.last.feed()
    await a.d.stop()
    expect(a.texts).toEqual(['hello pane'])
    expect(b.texts).toEqual([])

    const c = setup()
    await c.start()
    expect(a.d.status.value).toBe('busy')
    c.d.dispose()
    expect(a.d.status.value).toBe('idle')
  })

  it('a start that wakes up after release gives the mic back', async () => {
    let grant!: (s: ReturnType<typeof fakeStream>) => void
    getUserMedia.mockImplementationOnce(() => new Promise(r => { grant = r }))
    const { d, texts, start } = setup()
    const starting = start()
    expect(d.status.value).toBe('preparing')
    await d.stop() // released before the permission prompt answered
    expect(d.status.value).toBe('idle')
    const stream = fakeStream()
    grant(stream)
    await starting
    expect(stream.tracks[0].stopped).toBe(true)
    expect(FakeAudioContext.last.closed).toBe(true)
    expect(d.status.value).toBe('idle')
    expect(engine.takes).toHaveLength(0)
    expect(texts).toEqual([])
  })

  it('ends a forgotten take at the cap', async () => {
    vi.useFakeTimers()
    const { d, texts, start } = setup()
    await start()
    FakeAudioContext.last.feed()
    await vi.advanceTimersByTimeAsync(MAX_TAKE_MS)
    await vi.advanceTimersByTimeAsync(10) // the engine answers
    expect(texts).toEqual(['hello pane'])
    expect(d.status.value).toBe('idle')
  })

  it('gives up after 90 s without news, but not while partial results keep coming', async () => {
    vi.useFakeTimers()
    // Partial results at 60 s and 120 s, the text at 170 s.
    engine.transcribe = (_take, opts) => new Promise((resolve) => {
      setTimeout(() => opts.onPartial?.('a'), 60_000)
      setTimeout(() => opts.onPartial?.('a b'), 120_000)
      setTimeout(() => resolve({ text: 'a b c', ms: 170_000 }), 170_000)
    })
    const slow = setup()
    await slow.start()
    FakeAudioContext.last.feed()
    void slow.d.stop()
    await vi.advanceTimersByTimeAsync(170_000)
    expect(slow.texts).toEqual(['a b c'])
    slow.d.dispose()

    engine = createFakeEngine({ delayMs: TRANSCRIBE_TIMEOUT_MS + 1000 })
    disposeEngines()
    const stuck = setup()
    await stuck.start()
    FakeAudioContext.last.feed()
    void stuck.d.stop()
    await vi.advanceTimersByTimeAsync(TRANSCRIBE_TIMEOUT_MS)
    expect(stuck.d.error.value).toEqual({ reason: 'timeout' })
    expect(stuck.texts).toEqual([])
  })

  it('reports an engine that is not ready and drops the mic', async () => {
    engine = createFakeEngine({ readiness: { ready: false, reason: 'no-key' } })
    const { d, start } = setup()
    await start()
    await tick()
    expect(d.status.value).toBe('error')
    expect(d.error.value).toEqual({ reason: 'no-key', detail: undefined })
    expect(FakeAudioContext.last.closed).toBe(true)
  })

  it('reports a denied mic', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('denied'))
    const { d, start } = setup()
    await start()
    expect(d.error.value).toEqual({ reason: 'mic', detail: 'denied' })
    d.cancel()
    expect(d.status.value).toBe('idle')
  })
})
