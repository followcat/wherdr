// The Play button under an agent reply: reads the plain text with the chosen
// device voice, turns into Stop, one reply at a time, hidden when turned off.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { setToaster } from '~/composables/useHerdr'

const fake = vi.hoisted(() => {
  class Utterance { text: string; voice: unknown = null; lang = ''; onstart?: () => void; onend?: () => void; onerror?: (e: { error: string }) => void; constructor(t: string) { this.text = t } }
  const synth = {
    queue: [] as Utterance[], speaking: false, pending: false, drop: false,
    // `drop`: the iOS silent no-op — the utterance is queued, pending stays
    // true, and no start/end/error event ever comes.
    speak(u: Utterance) { this.queue.push(u); if (this.drop) { this.pending = true } else { this.speaking = true } },
    cancel: vi.fn(function (this: { queue: Utterance[], speaking: boolean, pending: boolean }) { this.queue = []; this.speaking = false; this.pending = false }),
    resume() {},
    getVoices: () => [{ name: 'Amélie', lang: 'fr-CA', voiceURI: 'voice-amelie', localService: true }, { name: 'Daniel', lang: 'en-GB', voiceURI: 'voice-daniel', localService: true }],
    addEventListener() {},
  }
  Object.assign(globalThis, { speechSynthesis: synth, SpeechSynthesisUtterance: Utterance })
  return synth
})

const { initialEngine, readAloudEngine, readAloudVoice, speakingId } = await import('~/composables/useReadAloud')
const ReadAloudButton = (await import('~/components/ReadAloudButton.vue')).default
// Loaded with nothing saved: read aloud starts off.
const engineAtLoad = readAloudEngine.value

beforeEach(() => {
  fake.cancel()
  speakingId.value = null
  readAloudEngine.value = 'device'
  readAloudVoice.value = ''
})

describe('ReadAloudButton', () => {
  it('reads the reply without its code, with the chosen voice, then shows Stop', async () => {
    readAloudVoice.value = 'voice-daniel'
    const w = await mountSuspended(ReadAloudButton, { props: { id: 'p1:a1', text: '**Done.** Run:\n\n```sh\nnpm test\n```' } })
    expect(w.text()).toContain('Play')
    await w.find('button').trigger('click')
    expect(fake.queue.map(u => u.text)).toEqual(['Done. Run:', 'Code block.'])
    expect(fake.queue[0]!.lang).toBe('en-GB')
    expect(w.text()).toContain('Stop')
    expect(w.find('button').attributes('aria-pressed')).toBe('true')
    fake.queue.at(-1)!.onend!()
    await nextTick()
    expect(w.text()).toContain('Play')
  })

  it('Stop cancels speech; a second reply takes over from the first', async () => {
    const a = await mountSuspended(ReadAloudButton, { props: { id: 'p1:a1', text: 'First reply.' } })
    const b = await mountSuspended(ReadAloudButton, { props: { id: 'p1:a2', text: 'Second reply.' } })
    await a.find('button').trigger('click')
    await b.find('button').trigger('click')
    expect(fake.queue.map(u => u.text)).toEqual(['Second reply.'])
    expect(a.text()).toContain('Play')
    expect(b.text()).toContain('Stop')
    fake.cancel.mockClear()
    await b.find('button').trigger('click')
    expect(fake.cancel).toHaveBeenCalled()
    expect(b.text()).toContain('Play')
  })

  it('is off with no saved choice, so no Play shows; a saved voice stays on', async () => {
    expect(engineAtLoad).toBe('off')
    expect(initialEngine(null, true, true)).toBe('off')
    expect(initialEngine('device', true, true)).toBe('device')
    expect(initialEngine('wherdr', true, true)).toBe('wherdr')
    expect(initialEngine('device', false, true)).toBe('off')
    readAloudEngine.value = engineAtLoad
    const w = await mountSuspended(ReadAloudButton, { props: { id: 'p1:a1', text: 'Hi' } })
    expect(w.find('[data-testid="read-aloud"]').exists()).toBe(false)
  })

  it('says why a Cantonese reply stays silent when no voice can read it', async () => {
    // The wherdr engine is chosen but no voice is installed (the staging bug:
    // only the GPU voice is, or nothing is), and the device has no Chinese
    // voice to fall back to — the refusal must show, not stay silent.
    const toasts: string[] = []
    setToaster({ clear() {}, add: (t: { title: string }) => { toasts.push(t.title) } } as unknown as Parameters<typeof setToaster>[0])
    try {
      readAloudEngine.value = 'wherdr'
      const w = await mountSuspended(ReadAloudButton, { props: { id: 'p1:a1', text: '今日天氣幾好。' } })
      await w.find('button').trigger('click')
      expect(toasts.join(' ')).toContain('Could not read aloud')
      // The device's voices were still asked, whatever they can say.
      expect(fake.queue.length).toBeGreaterThan(0)
    }
    finally { setToaster(null as unknown as Parameters<typeof setToaster>[0]) }
  })

  it('says so when the device voice never starts', async () => {
    // The phone symptom: Play flips to Stop, no sound, no error. iOS queues
    // an utterance it cannot speak (a listed but not-downloaded voice, a
    // queue lost right after cancel()) pending forever — no event ever
    // comes, and pending never clears either.
    const toasts: string[] = []
    setToaster({ clear() {}, add: (t: { title: string }) => { toasts.push(t.title) } } as unknown as Parameters<typeof setToaster>[0])
    fake.drop = true
    vi.useFakeTimers()
    try {
      readAloudEngine.value = 'device'
      const w = await mountSuspended(ReadAloudButton, { props: { id: 'p1:a1', text: '今日天氣幾好。' } })
      await w.find('button').trigger('click')
      expect(w.text()).toContain('Stop')
      // A first tick inside the grace: no verdict yet.
      vi.advanceTimersByTime(1600)
      expect(toasts).toEqual([])
      vi.advanceTimersByTime(2000)
      await nextTick()
      expect(toasts.join(' ')).toContain('the device voice did not start')
      expect(w.text()).toContain('Play')
    }
    finally {
      vi.useRealTimers()
      fake.drop = false
      setToaster(null as unknown as Parameters<typeof setToaster>[0])
    }
  })
})
