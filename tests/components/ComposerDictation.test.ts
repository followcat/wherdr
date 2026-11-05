// The composer's mic (useComposerDictation): hidden while dictation is off,
// hold or tap to record, the text lands in the draft and nothing is sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import Composer from '~/components/Composer.vue'
import { dictationEngine, eventsOpen } from '~/composables/useHerdr'
import { ENGINES, disposeEngines } from '~/utils/dictation/registry'
import { HOLD_MS } from '~/composables/useComposerDictation'
import type { Pane } from '#shared/types'
import { createFakeEngine, type FakeEngine } from '../fakeDictationEngine'

const pane = (id: string): Pane => ({
  id, workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'pi', name: null, label: null, status: 'idle', title: null, cwd: '/home/user/demo', agentSession: null,
})

// Nothing may reach the agent on its own.
const sent: string[] = []
registerEndpoint('/api/prompt', { method: 'POST', handler: () => { sent.push('prompt'); return { ok: true } } })
registerEndpoint('/api/input', { method: 'POST', handler: () => { sent.push('input'); return { ok: true } } })

class FakeAudioContext {
  static last: FakeAudioContext
  state = 'running'
  sampleRate = 16000
  destination = {}
  processor: { onaudioprocess: ((e: unknown) => void) | null } | null = null
  constructor() { FakeAudioContext.last = this }
  async resume() {}
  async close() {}
  createMediaStreamSource() { return { connect() {}, disconnect() {} } }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
  createScriptProcessor() {
    this.processor = { onaudioprocess: null, connect() {}, disconnect() {} } as never
    return this.processor
  }

  feed() {
    const data = Float32Array.from({ length: 4096 }, (_, j) => j % 2 ? 0.2 : -0.2)
    this.processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => data } })
  }
}

let engine: FakeEngine
let now = 0

beforeEach(() => {
  eventsOpen.value = true
  engine = createFakeEngine({ text: 'fix the cache' })
  ENGINES.device = async () => engine
  dictationEngine.value = 'device'
  sent.length = 0
  vi.stubGlobal('AudioContext', FakeAudioContext)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
  })
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})

afterEach(() => {
  eventsOpen.value = false
  dictationEngine.value = 'off'
  disposeEngines()
  delete ENGINES.device
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mount(id: string, draft = '') {
  const w = await mountSuspended(Composer, { props: { pane: pane(id), paneId: id, sendKeys: async () => {} } })
  const field = w.find('textarea')
  if (draft) await field.setValue(draft)
  return { w, field, mic: () => w.find('[data-testid="dictation-mic"]') }
}

describe('Composer dictation', () => {
  it('has no mic while dictation is off', async () => {
    dictationEngine.value = 'off'
    const { w, mic } = await mount('w9:p1')
    expect(mic().exists()).toBe(false)
    w.unmount()
  })

  it('hold, talk, release: the text joins the draft and is not sent', async () => {
    const { w, field, mic } = await mount('w9:p2', 'Please')
    now = 1000
    await mic().trigger('pointerdown', { pointerType: 'touch' })
    await vi.waitFor(() => expect(mic().attributes('aria-pressed')).toBe('true'))
    FakeAudioContext.last.feed()
    await flushPromises()
    const take = w.find('[data-testid="dictation-take"]')
    expect(take.exists()).toBe(true)
    expect(take.find('.dictation-wave').text()).toMatch(/^[▁-█]+$/u)
    expect(take.find('.dictation-clock').text()).toBe('0:00')
    now += HOLD_MS
    await mic().trigger('pointerup', { pointerType: 'touch' })
    await vi.waitFor(() => expect((field.element as HTMLTextAreaElement).value).toBe('Please fix the cache'))
    expect(w.find('[data-testid="dictation-take"]').exists()).toBe(false)
    expect(sent).toEqual([])
    w.unmount()
  })

  it('a tap keeps recording until the next tap', async () => {
    const { w, field, mic } = await mount('w9:p3')
    now = 1000
    await mic().trigger('pointerdown', { pointerType: 'touch' })
    await flushPromises()
    now += 100
    await mic().trigger('pointerup', { pointerType: 'touch' })
    await vi.waitFor(() => expect(mic().attributes('aria-pressed')).toBe('true'))
    FakeAudioContext.last.feed()
    await mic().trigger('pointerdown', { pointerType: 'touch' })
    await mic().trigger('pointerup', { pointerType: 'touch' })
    await vi.waitFor(() => expect((field.element as HTMLTextAreaElement).value).toBe('fix the cache'))
    expect(sent).toEqual([])
    w.unmount()
  })

  it('× drops the take and writes nothing', async () => {
    const { w, field, mic } = await mount('w9:p4', 'Keep this')
    now = 1000
    await mic().trigger('pointerdown', { pointerType: 'touch' })
    await vi.waitFor(() => expect(mic().attributes('aria-pressed')).toBe('true'))
    FakeAudioContext.last.feed()
    await flushPromises()
    await w.find('[data-testid="dictation-take"] .notice-btn').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="dictation-take"]').exists()).toBe(false)
    expect(engine.takes).toHaveLength(0)
    expect((field.element as HTMLTextAreaElement).value).toBe('Keep this')
    expect(sent).toEqual([])
    w.unmount()
  })

  it('after "too large", the next press loads a fresh engine (the model that fits), without a reload', async () => {
    const tooLarge = createFakeEngine({ readiness: { ready: false, reason: 'too-large', detail: 'Canary 180M' } })
    const made: FakeEngine[] = []
    ENGINES.device = async () => { const e = made.length ? engine : tooLarge; made.push(e); return e }
    const { w, field, mic } = await mount('w9:p5')
    now = 1000
    await mic().trigger('pointerdown', { pointerType: 'touch' })
    await mic().trigger('pointerup', { pointerType: 'touch' })
    await vi.waitFor(() => expect(made).toHaveLength(1))
    await vi.waitFor(() => expect(mic().attributes('aria-pressed')).toBe('false'))
    await flushPromises()
    now = 5000
    await mic().trigger('pointerdown', { pointerType: 'touch' })
    await vi.waitFor(() => expect(mic().attributes('aria-pressed')).toBe('true'))
    FakeAudioContext.last.feed()
    now += HOLD_MS
    await mic().trigger('pointerup', { pointerType: 'touch' })
    await vi.waitFor(() => expect((field.element as HTMLTextAreaElement).value).toBe('fix the cache'))
    expect(made).toEqual([tooLarge, engine])
    w.unmount()
  })
})
