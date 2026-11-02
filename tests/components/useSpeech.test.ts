// The shared ASR engine hands every useSpeech() caller its own facade:
// a take belongs to the pane that started it — its result lands only in
// that draft, other facades read 'busy', and an unrelated composer
// unmounting never tears it down.
import { beforeEach, describe, expect, it, vi } from 'vitest'

class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: { message: string }) => void) | null = null
  msgs: unknown[] = []
  terminated = false
  postMessage(m: { t: string }) {
    this.msgs.push(m)
    if (m.t === 'load') queueMicrotask(() => this.onmessage?.({ data: { t: 'ready', loadMs: 1 } }))
  }
  emit(m: unknown) { this.onmessage?.({ data: m }) }
  terminate() { this.terminated = true }
}

class FakeAudioContext {
  state = 'running'
  sampleRate = 16000
  destination = {}
  async resume() {}
  createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() } }
  createScriptProcessor() { return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null } }
  createGain() { return { gain: { value: 0 }, connect: vi.fn() } }
  async close() {}
}
class FakeOfflineAudioContext {
  constructor(_ch: number, _len: number, _rate: number) {}
  async decodeAudioData(_buf: ArrayBuffer) {
    return { getChannelData: () => new Float32Array(48000), sampleRate: 16000 }
  }
}

let worker: FakeWorker
let micStream: { getTracks: () => { stop: ReturnType<typeof vi.fn> }[] }
let micError: Error | null = null

async function freshSpeech() {
  vi.resetModules()
  const mod = await import('../../app/composables/useSpeech')
  return mod.useSpeech
}

beforeEach(() => {
  micError = null
  micStream = { getTracks: () => [{ stop: vi.fn() }, { stop: vi.fn() }] }
  vi.stubGlobal('Worker', class { constructor() { worker = new FakeWorker(); return worker } })
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext)
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => {
        if (micError) throw micError
        return micStream
      }),
    },
  })
})

const tick = () => new Promise(r => setTimeout(r, 0))

describe('useSpeech facades', () => {
  it('delivers the take only to the facade that started it', async () => {
    const useSpeech = await freshSpeech()
    const a = useSpeech(), b = useSpeech()
    await a.startMic('ctx')
    expect(a.status.value).toBe('recording')
    expect(b.status.value).toBe('busy')
    await expect(b.startMic()).rejects.toThrow('busy')
    worker.emit({ t: 'final', text: 'hello pane', decodeMs: 5, take: null, ctx: 'ctx' })
    expect(a.finalText.value).toBe('hello pane')
    expect(b.finalText.value).toBe('')
    expect(a.status.value).toBe('ready')
    expect(b.status.value).toBe('ready')
  })

  it('a bystander dispose never tears down someone else\'s take', async () => {
    const useSpeech = await freshSpeech()
    const a = useSpeech(), b = useSpeech()
    await a.startMic()
    b.dispose()
    expect(a.status.value).toBe('recording')
    expect(worker.msgs.every(m => (m as { t: string }).t !== 'reset')).toBe(true)
    worker.emit({ t: 'final', text: 'still mine', decodeMs: 1 })
    expect(a.finalText.value).toBe('still mine')
    expect(b.finalText.value).toBe('')
  })

  it('the owner dispose drops its take and frees the engine', async () => {
    const useSpeech = await freshSpeech()
    const a = useSpeech(), b = useSpeech()
    await a.startMic()
    a.dispose()
    expect(worker.msgs.some(m => (m as { t: string }).t === 'reset')).toBe(true)
    expect(b.status.value).toBe('ready')
    await b.startMic()
    expect(b.status.value).toBe('recording')
    b.dispose()
  })

  it('every caller waiting on engine load resolves, not just the first', async () => {
    const useSpeech = await freshSpeech()
    const a = useSpeech(), b = useSpeech()
    // Both callers wait through the same downloading window.
    const pa = a.ensure(), pb = b.ensure()
    await expect(Promise.all([pa, pb])).resolves.toEqual([undefined, undefined])
  })

  it('a failed mic grab releases ownership and leaks no stream', async () => {
    const useSpeech = await freshSpeech()
    const a = useSpeech(), b = useSpeech()
    micError = new Error('denied')
    await expect(a.startMic()).rejects.toThrow('denied')
    expect(a.status.value).not.toBe('recording')
    // The engine is free again — a second pane can still take the mic.
    micError = null
    await b.startMic()
    expect(b.status.value).toBe('recording')
    b.dispose()
  })

  it('decodeBlob arms the flush timeout like a mic take', async () => {
    vi.useFakeTimers()
    try {
      const useSpeech = await freshSpeech()
      const a = useSpeech()
      const p = a.decodeBlob(new Blob([new Uint8Array(96000)]))
      await vi.advanceTimersByTimeAsync(0)
      await p
      expect(a.status.value).toBe('flushing')
      // The worker never answers: the UI must still come back.
      await vi.advanceTimersByTimeAsync(91_000)
      expect(a.status.value).toBe('ready')
    } finally { vi.useRealTimers() }
  })
})
