// Settings › Dictation › On this device: the catalog's models with languages,
// size and ratings; GPU models only with WebGPU; install, progress, delete,
// space used; the chosen model saved on this device.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DictationDeviceSettings from '~/components/DictationDeviceSettings.vue'
import { DEVICE_MODEL_KEY, forgetUnsupported, markUnsupported, unsupportedModels } from '~/utils/dictation/deviceModels'
import { fakeCaches, rangeServer } from '../fakeModelCache'

const rows = (w: Awaited<ReturnType<typeof mountSuspended>>) => w.findAll('.dictation-model')
const rating = (r: ReturnType<Awaited<ReturnType<typeof mountSuspended>>['find']>) => r.findAll('.dictation-model-rating span, .dictation-model-rating i').map(e => e.text())
const row = (w: Awaited<ReturnType<typeof mountSuspended>>, id: string) => w.find(`[data-model="${id}"]`)
const senseVoice = async () => (await import('~/utils/dictation/deviceModels')).DEVICE_MODELS.find(m => m.id === 'sensevoice')!
const qwenId = 'qwen3-asr-0.6b-q4f16'

beforeEach(() => {
  localStorage.removeItem(DEVICE_MODEL_KEY)
  localStorage.removeItem('dictationTooLarge')
  for (const id of unsupportedModels()) forgetUnsupported(id)
  vi.stubGlobal('caches', fakeCaches())
})
afterEach(() => {
  for (const id of unsupportedModels()) forgetUnsupported(id)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'gpu')
  Reflect.deleteProperty(navigator, 'deviceMemory')
})

describe('DictationDeviceSettings', () => {
  it('lists each model with its languages, size, quality and speed, and no GPU model without WebGPU', async () => {
    const w = await mountSuspended(DictationDeviceSettings)
    await flushPromises()
    expect(rows(w).map(r => r.find('b').text())).toEqual(['Parakeet v3', 'Canary 180M', 'SenseVoice'])
    const parakeet = row(w, 'parakeet-v3')
    // Broadly multilingual: its two best languages, then Multi; the bars
    // follow them, then this device's language (English here), marked.
    expect(parakeet.find('.dictation-model-meta').text()).toBe('IT · ES · Multi (25) · 670 MB')
    expect(rating(parakeet)).toEqual(['Quality', 'IT ■■■■■', 'ES ■■■■■', 'EN ■■■■■ yours', 'Speed', '■■■□□ est.'])
    expect(parakeet.find('[role="radio"]').attributes('aria-checked')).toBe('true')
    const sense = row(w, 'sensevoice')
    expect(sense.find('.dictation-model-meta').text()).toBe('ZH · YUE · EN · +2 · 237 MB')
    expect(rating(sense)).toEqual(['Quality', 'ZH ■■□□□', 'YUE ■■■□□', 'EN ■■□□□ yours', 'Speed', '■■■■■ est.'])
    expect(sense.find('.dictation-model-rating i').attributes('title')).toBe('10.78 % character errors on CV (https://arxiv.org/html/2407.04051v3)')
    expect(sense.find('button:not([role])').text()).toBe('Install · 237 MB')
    const canary = row(w, 'canary-180m')
    expect(canary.find('.dictation-model-meta').text()).toBe('ES · DE · FR · +1 · 207 MB')
    expect(canary.find('[data-testid="model-language"]').text()).toMatch(/^No language detection: writes [A-Z]{2}, this device’s language$/)
    expect(w.find('[data-testid="model-too-large"]').exists()).toBe(false)
  })

  it('marks the device language among the best ones, and never shows one the model does not speak', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['es-ES', 'en'])
    const w = await mountSuspended(DictationDeviceSettings)
    await flushPromises()
    expect(rating(row(w, 'parakeet-v3'))).toEqual(['Quality', 'IT ■■■■■', 'ES ■■■■■ yours', 'Speed', '■■■□□ est.'])
    expect(rating(row(w, 'sensevoice'))).toEqual(['Quality', 'ZH ■■□□□', 'YUE ■■■□□', 'Speed', '■■■■■ est.'])
    vi.restoreAllMocks()
  })

  it('on an iPhone, marks Parakeet too large, never chooses it, and defaults to Canary', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')
    localStorage.setItem(DEVICE_MODEL_KEY, 'parakeet-v3')
    const w = await mountSuspended(DictationDeviceSettings)
    await flushPromises()
    const parakeet = row(w, 'parakeet-v3')
    expect(parakeet.find('[data-testid="model-too-large"]').text()).toBe('Too large for this device · it needs about 858 MB of memory once loaded, more than this browser safely gives a page.')
    expect(parakeet.find('button:not([role])').exists()).toBe(false) // no Install
    expect(row(w, 'canary-180m').find('[role="radio"]').attributes('aria-checked')).toBe('true')
    await parakeet.find('[role="radio"]').trigger('click')
    expect(parakeet.find('[role="radio"]').attributes('aria-checked')).toBe('false')
    expect(localStorage.getItem(DEVICE_MODEL_KEY)).toBe('parakeet-v3') // untouched
    vi.restoreAllMocks()
  })

  it('says why a model was marked too large, and Try again clears the mark', async () => {
    localStorage.setItem('dictationTooLarge', JSON.stringify({ 'canary-180m': 'oom', 'sensevoice': 'killed' }))
    localStorage.setItem(DEVICE_MODEL_KEY, 'canary-180m')
    const w = await mountSuspended(DictationDeviceSettings)
    await flushPromises()
    const canary = () => row(w, 'canary-180m')
    expect(canary().find('[data-testid="model-too-large"]').text()).toBe('Too large for this device · it ran out of memory on this device.')
    expect(row(w, 'sensevoice').find('[data-testid="model-too-large"]').text()).toBe('Too large for this device · the page stopped while loading it, out of memory.')
    expect(row(w, 'parakeet-v3').find('[role="radio"]').attributes('aria-checked')).toBe('true') // the fallback
    await canary().find('[data-testid="model-retry"]').trigger('click')
    expect(canary().find('[data-testid="model-too-large"]').exists()).toBe(false)
    expect(canary().find('[role="radio"]').attributes('aria-checked')).toBe('true') // the saved choice again
    expect(JSON.parse(localStorage.getItem('dictationTooLarge')!)).toEqual({ sensevoice: 'killed' })
  })

  it('hides Qwen without WebGPU + shader-f16 and falls back if Qwen was saved, then offers Qwen opt-in with its size and Cancel when supported', async () => {
    localStorage.setItem(DEVICE_MODEL_KEY, qwenId)
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set() }) } })
    const noF16 = await mountSuspended(DictationDeviceSettings)
    await flushPromises()
    expect(rows(noF16).map(r => r.find('b').text())).toEqual(['Parakeet v3', 'Canary 180M', 'SenseVoice'])
    expect(row(noF16, 'parakeet-v3').find('[role="radio"]').attributes('aria-checked')).toBe('true')
    noF16.unmount()

    localStorage.removeItem(DEVICE_MODEL_KEY)
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } })
    const w = await mountSuspended(DictationDeviceSettings)
    await flushPromises()
    expect(rows(w).map(r => r.find('b').text())).toEqual(['Parakeet v3', 'Canary 180M', 'SenseVoice', 'Qwen3-ASR 0.6B'])
    const qwen = () => row(w, qwenId)
    expect(qwen().find('[role="radio"]').attributes('aria-checked')).toBe('false')
    expect(row(w, 'parakeet-v3').find('[role="radio"]').attributes('aria-checked')).toBe('true')
    expect(qwen().find('.dictation-model-meta').text()).toBe('ZH · EN · Multi (16) · 889 MB')
    expect(qwen().find('[data-testid="model-gpu"]').text()).toBe('Uses the GPU')
    expect(rating(qwen())).toEqual(['Quality', 'ZH ■■■■■', 'EN ■■■■■ yours', 'Speed', '■■■□□ est.'])
    expect(qwen().find('button:not([role])').text()).toBe('Install · 889 MB')

    // Cancelling while the server is still fetching the 889 MB files stops cleanly.
    vi.stubGlobal('fetch', async () => Response.json({ state: 'preparing', phase: 'fetch', got: 100_000_000, total: 889_384_852 }))
    await qwen().find('button:not([role])').trigger('click')
    await vi.waitFor(() => expect(qwen().find('[data-testid="model-server"]').text()).toBe('Preparing on the server… 11 %'))
    await qwen().findAll('button').find(b => b.text() === 'Cancel')!.trigger('click')
    await vi.waitFor(() => expect(qwen().find('[data-testid="model-state"]').text()).toBe('Install · 889 MB'))
    expect(qwen().find('.dictation-model-error').exists()).toBe(false)
    w.unmount()

    // Saved Qwen is honoured when WebGPU + shader-f16 are available.
    localStorage.setItem(DEVICE_MODEL_KEY, qwenId)
    const saved = await mountSuspended(DictationDeviceSettings)
    await flushPromises()
    expect(row(saved, qwenId).find('[role="radio"]').attributes('aria-checked')).toBe('true')
    saved.unmount()
  })

  it('marks Qwen over budget on iPhone and 2 GB devices, and keeps it selectable on 4 GB and 8 GB', async () => {
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } })
    localStorage.setItem(DEVICE_MODEL_KEY, qwenId)

    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')
    const ios = await mountSuspended(DictationDeviceSettings)
    await flushPromises()
    expect(row(ios, qwenId).find('[data-testid="model-too-large"]').text()).toBe('Too large for this device · it needs about 1.0 GB of memory once loaded, more than this browser safely gives a page.')
    expect(row(ios, qwenId).find('[role="radio"]').attributes('aria-disabled')).toBe('true')
    expect(row(ios, 'canary-180m').find('[role="radio"]').attributes('aria-checked')).toBe('true')
    ios.unmount()
    ua.mockRestore()

    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 2 })
    const mem2 = await mountSuspended(DictationDeviceSettings)
    await flushPromises()
    expect(row(mem2, qwenId).find('[data-testid="model-too-large"]').text()).toContain('it needs about 1.0 GB of memory once loaded')
    expect(row(mem2, qwenId).find('[role="radio"]').attributes('aria-disabled')).toBe('true')
    expect(row(mem2, 'canary-180m').find('[role="radio"]').attributes('aria-checked')).toBe('true')
    mem2.unmount()

    for (const gb of [4, 8]) {
      localStorage.removeItem(DEVICE_MODEL_KEY)
      Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: gb })
      const ok = await mountSuspended(DictationDeviceSettings)
      await flushPromises()
      const qwen = row(ok, qwenId)
      expect(qwen.find('[data-testid="model-too-large"]').exists()).toBe(false)
      expect(qwen.find('[role="radio"]').attributes('aria-disabled')).toBe('false')
      expect(qwen.find('button:not([role])').text()).toBe('Install · 889 MB')
      await qwen.find('[role="radio"]').trigger('click')
      expect(qwen.find('[role="radio"]').attributes('aria-checked')).toBe('true')
      ok.unmount()
    }
  })

  it('shows Qwen as unsupported for the page, falls back to Parakeet, and Try again restores Qwen', async () => {
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } })
    localStorage.setItem(DEVICE_MODEL_KEY, qwenId)
    markUnsupported(qwenId)
    const w = await mountSuspended(DictationDeviceSettings)
    await flushPromises()
    const qwen = () => row(w, qwenId)
    expect(qwen().find('[data-testid="model-unsupported"]').text()).toBe('Not working on this device right now · the GPU could not run this model.')
    expect(qwen().find('[data-testid="model-too-large"]').exists()).toBe(false)
    expect(qwen().find('[role="radio"]').attributes('aria-disabled')).toBe('true')
    expect(row(w, 'parakeet-v3').find('[role="radio"]').attributes('aria-checked')).toBe('true')

    await qwen().find('[data-testid="model-retry"]').trigger('click')
    expect(qwen().find('[data-testid="model-unsupported"]').exists()).toBe(false)
    expect(qwen().find('[role="radio"]').attributes('aria-checked')).toBe('true')
    expect(qwen().find('button:not([role])').text()).toBe('Install · 889 MB')
    expect(unsupportedModels().has(qwenId)).toBe(false)
    w.unmount()
  })

  it('installs with progress, counts the space used, deletes, and saves the chosen model', async () => {
    const w = await mountSuspended(DictationDeviceSettings)
    await flushPromises()
    const sense = () => row(w, 'sensevoice')
    vi.stubGlobal('fetch', rangeServer(await senseVoice()).fetch)
    await sense().find('button:not([role])').trigger('click')
    expect(sense().find('progress').exists()).toBe(true)
    await vi.waitFor(() => expect(sense().find('[data-testid="model-state"]').text()).toContain('Installed'), { timeout: 5000 })
    expect(w.find('[data-testid="dictation-storage"]').text()).toContain('237 MB used on this device')

    await sense().findAll('button').find(b => b.text() === 'Delete')!.trigger('click')
    await vi.waitFor(() => expect(sense().find('[data-testid="model-state"]').text()).toBe('Install · 237 MB'))
    expect(w.find('[data-testid="dictation-storage"]').text()).toContain('0 B used on this device')

    await sense().find('[role="radio"]').trigger('click')
    expect(localStorage.getItem(DEVICE_MODEL_KEY)).toBe('sensevoice')
    expect(sense().find('[role="radio"]').attributes('aria-checked')).toBe('true')
  })

  it('shows the server preparing the files, then the download to this device', async () => {
    const w = await mountSuspended(DictationDeviceSettings)
    await flushPromises()
    const files = rangeServer(await senseVoice())
    let release = () => {}
    const ready = new Promise<void>((r) => { release = r })
    let polls = 0
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url !== '/api/dictation/prepare') return files.fetch(url, init)
      if (polls++) await ready
      return Response.json(polls > 1 ? { state: 'ready' } : { state: 'preparing', phase: 'fetch', got: 40, total: 100 })
    })
    const sense = () => row(w, 'sensevoice')
    await sense().find('button:not([role])').trigger('click')
    await vi.waitFor(() => expect(sense().find('[data-testid="model-server"]').text()).toBe('Preparing on the server… 40 %'))
    expect(w.find('[data-testid="dictation-storage"]').text()).toContain('0 B used on this device')
    release()
    await vi.waitFor(() => expect(sense().find('[data-testid="model-state"]').text()).toContain('Installed'), { timeout: 5000 })
  })

  it('says the server is missing the model files on a 404, with the fetch command', async () => {
    const w = await mountSuspended(DictationDeviceSettings)
    await flushPromises()
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }))
    await row(w, 'sensevoice').find('button:not([role])').trigger('click')
    const msg = () => row(w, 'sensevoice').find('[data-testid="model-missing"]')
    await vi.waitFor(() => expect(msg().exists()).toBe(true))
    expect(msg().text()).toContain('The wherdr server does not have this model’s files')
    expect(msg().find('code').text()).toBe('node scripts/fetch-dictation-files.mjs runtime sensevoice')
    expect(msg().text()).toContain('docs/installation.md')
    expect(msg().text()).not.toContain('HTTP 404')
  })
})
