// Settings › Dictation › Online: the key goes to the server and never comes
// back to the page (only its last 4 characters); options stay on the device.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import DictationCloudSettings from '~/components/DictationCloudSettings.vue'
import { CLOUD_OPTIONS_KEY } from '~/utils/dictation/cloudOptions'

const KEY = 'sk-or-test-key-0000'
let saved = ''
const status = () => saved ? { set: true, last4: saved.slice(-4) } : { set: false }
registerEndpoint('/api/dictation/status', () => status())
registerEndpoint('/api/dictation/key', { method: 'POST', handler: async (e) => {
  const { readBody } = await import('h3')
  saved = String((await readBody<{ key: string }>(e)).key)
  return status()
} })
registerEndpoint('/api/dictation/key', { method: 'DELETE', handler: () => { saved = ''; return status() } })
let modelCalls = 0
registerEndpoint('/api/dictation/models', () => {
  modelCalls++
  return { live: true, models: [
    { id: 'openai/whisper-large-v3-turbo', name: 'OpenAI: Whisper Large V3 Turbo', perMinute: 0.0002 },
    { id: 'qwen/qwen3-asr-1.7b', name: 'Qwen: Qwen3 ASR 1.7B', perMinute: 0.00045 },
    { id: 'deepgram/nova-3', name: 'Deepgram: Nova-3', perMinute: 0.0043 },
    { id: 'openai/gpt-4o-transcribe', name: 'OpenAI: GPT-4o Transcribe' },
  ] }
})

beforeEach(() => { saved = ''; modelCalls = 0; localStorage.removeItem(CLOUD_OPTIONS_KEY) })

describe('DictationCloudSettings', () => {
  it('saves the key, then shows only its last 4 characters and can remove it', async () => {
    const w = await mountSuspended(DictationCloudSettings)
    await flushPromises()
    expect(w.find('[data-testid="dictation-test"]').attributes('disabled')).toBeDefined()
    await w.find('input[type="password"]').setValue(KEY)
    await w.find('form').trigger('submit')
    await vi.waitFor(() => expect(saved).toBe(KEY))
    await vi.waitFor(() => expect(w.find('[data-testid="dictation-key-mask"]').text()).toBe('••••••••0000'))
    expect(w.html()).not.toContain(KEY)
    expect(w.find('[data-testid="dictation-test"]').attributes('disabled')).toBeUndefined()
    await w.findAll('button').find(b => b.text() === 'Remove')!.trigger('click')
    await vi.waitFor(() => expect(w.find('input[type="password"]').exists()).toBe(true))
    expect(saved).toBe('')
  })

  it('keeps ZDR on and pane terms off by default, saved on this device', async () => {
    const w = await mountSuspended(DictationCloudSettings)
    await flushPromises()
    const switches = w.findAll('[role="switch"]')
    expect(switches.map(s => s.attributes('aria-checked'))).toEqual(['true', 'false'])
    await switches[1]!.trigger('click')
    await flushPromises()
    expect(JSON.parse(localStorage.getItem(CLOUD_OPTIONS_KEY)!)).toMatchObject({ zdr: true, terms: true, model: 'openai/whisper-large-v3-turbo' })
  })

  it('loads the server list once the key is saved, and searches it by name or id', async () => {
    saved = KEY
    const w = await mountSuspended(DictationCloudSettings, { attachTo: document.body })
    await vi.waitFor(() => expect(modelCalls).toBe(1))
    await w.find('[data-testid="dictation-model"]').trigger('click')
    const search = await vi.waitFor(() => {
      const el = document.body.querySelector<HTMLInputElement>('[role="listbox"]')?.closest('[data-slot="content"]')?.querySelector('input')
      expect(el).toBeTruthy()
      return el!
    })
    const options = () => [...document.body.querySelectorAll('[role="option"]')].map(o => o.textContent!.replace(/\s+/g, ' ').trim())
    await vi.waitFor(() => expect(options()).toHaveLength(4))
    expect(options()[0]).toContain('$0.0002 / min')
    // Billed per token: no per-minute price, a link to its OpenRouter page.
    expect(options()[3]).toContain('Price: see OpenRouter')
    expect(document.body.querySelectorAll('[role="option"]')[3]!.querySelector('a')!.getAttribute('href')).toBe('https://openrouter.ai/openai/gpt-4o-transcribe')
    search.value = 'qwen'
    search.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(options()).toEqual([expect.stringContaining('Qwen: Qwen3 ASR 1.7B')]))
    search.value = 'deepgram/'
    search.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(options()).toEqual([expect.stringContaining('$0.0043 / min')]))
    ;(document.body.querySelector('[role="option"]') as HTMLElement).click()
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(CLOUD_OPTIONS_KEY)!).model).toBe('deepgram/nova-3'))
    w.unmount()
  })

  it('does not ask for the list before a key is saved', async () => {
    await mountSuspended(DictationCloudSettings)
    await flushPromises()
    expect(modelCalls).toBe(0)
  })
})
