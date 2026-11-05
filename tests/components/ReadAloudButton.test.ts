// The Play button under an agent reply: reads the plain text with the chosen
// device voice, turns into Stop, one reply at a time, hidden when turned off.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'

const fake = vi.hoisted(() => {
  class Utterance { text: string; voice: unknown = null; lang = ''; onend?: () => void; onerror?: (e: { error: string }) => void; constructor(t: string) { this.text = t } }
  const synth = {
    queue: [] as Utterance[], speaking: false, pending: false,
    speak(u: Utterance) { this.queue.push(u); this.speaking = true },
    cancel: vi.fn(function (this: { queue: Utterance[], speaking: boolean }) { this.queue = []; this.speaking = false }),
    resume() {},
    getVoices: () => [{ name: 'Amélie', lang: 'fr-CA', voiceURI: 'voice-amelie', localService: true }, { name: 'Daniel', lang: 'en-GB', voiceURI: 'voice-daniel', localService: true }],
    addEventListener() {},
  }
  Object.assign(globalThis, { speechSynthesis: synth, SpeechSynthesisUtterance: Utterance })
  return synth
})

const { readAloudEngine, readAloudVoice, speakingId } = await import('~/composables/useReadAloud')
const ReadAloudButton = (await import('~/components/ReadAloudButton.vue')).default

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

  it('is hidden when read aloud is off', async () => {
    readAloudEngine.value = 'off'
    const w = await mountSuspended(ReadAloudButton, { props: { id: 'p1:a1', text: 'Hi' } })
    expect(w.find('[data-testid="read-aloud"]').exists()).toBe(false)
  })
})
