// Settings › Dictation › On this device: the catalog's models with languages,
// size and ratings; GPU models only with WebGPU; install, progress, delete,
// space used; the chosen model saved on this device.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import DictationDeviceSettings from '~/components/DictationDeviceSettings.vue'
import { DEVICE_MODEL_KEY } from '~/utils/dictation/deviceModels'
import type { DeviceModel } from '~/utils/dictation/deviceModels'
import { fakeCaches, rangeServer } from '../fakeModelCache'

// One more model, for the GPU only.
vi.mock('~/utils/dictation/models.json', async (real) => {
  const { default: catalog } = await real<{ default: { models: DeviceModel[] } }>()
  const gpu = { ...catalog.models.find(m => m.id === 'sensevoice')!, id: 'gpu-model', name: 'GPU model', requires: ['webgpu', 'shader-f16'], quality: [], speed: undefined }
  return { default: { ...catalog, models: [...catalog.models, gpu] } }
})

const rows = (w: Awaited<ReturnType<typeof mountSuspended>>) => w.findAll('.dictation-model')
const rating = (r: ReturnType<Awaited<ReturnType<typeof mountSuspended>>['find']>) => r.findAll('.dictation-model-rating span, .dictation-model-rating i').map(e => e.text())
const row = (w: Awaited<ReturnType<typeof mountSuspended>>, id: string) => w.find(`[data-model="${id}"]`)
const senseVoice = async () => (await import('~/utils/dictation/deviceModels')).DEVICE_MODELS.find(m => m.id === 'sensevoice')!

beforeEach(() => {
  localStorage.removeItem(DEVICE_MODEL_KEY)
  localStorage.removeItem('dictationTooLarge')
  vi.stubGlobal('caches', fakeCaches())
})
afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'gpu')
})

describe('DictationDeviceSettings', () => {
  it('lists each model with its languages, size, quality and speed, and no GPU model without WebGPU', async () => {
    const w = await mountSuspended(DictationDeviceSettings)
    await flushPromises()
    expect(rows(w).map(r => r.find('b').text())).toEqual(['Parakeet v3', 'Canary 180M', 'SenseVoice'])
    const parakeet = row(w, 'parakeet-v3')
    expect(parakeet.find('.dictation-model-meta').text()).toBe('FR · EN · +23 · 670 MB')
    expect(rating(parakeet)).toEqual(['Quality', 'FR ■■■■□', 'EN ■■■■■', 'Speed', '■■■□□ est.'])
    expect(parakeet.find('[role="radio"]').attributes('aria-checked')).toBe('true')
    const sense = row(w, 'sensevoice')
    expect(sense.find('.dictation-model-meta').text()).toBe('EN · +4 · 237 MB')
    expect(rating(sense)).toEqual(['Quality', 'FR —', 'EN ■■□□□', 'Speed', '■■■■■ est.'])
    expect(sense.find('button:not([role])').text()).toBe('Install · 237 MB')
    const canary = row(w, 'canary-180m')
    expect(canary.find('.dictation-model-meta').text()).toBe('FR · EN · +2 · 207 MB')
    expect(canary.find('[data-testid="model-language"]').text()).toMatch(/^No language detection: writes [A-Z]{2}, this device’s language$/)
    expect(w.find('[data-testid="model-too-large"]').exists()).toBe(false)
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

  it('shows a GPU model when the device has WebGPU with f16, unknown figures as unknown', async () => {
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } })
    const w = await mountSuspended(DictationDeviceSettings)
    await flushPromises()
    expect(rows(w)).toHaveLength(4)
    expect(rating(row(w, 'gpu-model'))).toEqual(['Quality', 'FR —', 'EN unknown', 'Speed', 'unknown'])
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
