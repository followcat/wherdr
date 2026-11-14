// Settings › Read aloud voice picker: the user's languages and no low-quality
// voices by default, a language filter, and the chosen voice always listed.
// The voice of wherdr: install, cancel and delete each language voice, and
// the download time shown once installed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { macChromiumVoices } from '../fixtures/voices'
import { fakeCaches, rangeServer } from '../fakeModelCache'
import type { DeviceModel } from '~/utils/dictation/deviceModels'

vi.hoisted(() => {
  Object.defineProperty(navigator, 'languages', { value: ['fr-FR', 'en-US'], configurable: true })
  // The voices are set on deviceVoices before each test.
  const synth = { speaking: false, pending: false, speak() {}, cancel() {}, resume() {}, getVoices: () => [], addEventListener() {} }
  // The neural voice exists where the browser has workers and WebAudio.
  Object.assign(globalThis, { speechSynthesis: synth, SpeechSynthesisUtterance: class {}, Worker: class {}, AudioContext: class {} })
})

// iOS (utils/format.ts, read from the user agent at load) is switched here per test.
const device = vi.hoisted(() => ({ ios: false }))
vi.mock('~/utils/format', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/utils/format')>()
  return { ...real, get isIOS() { return device.ios } }
})

const { deviceVoices, readAloudEngine, readAloudHideLow, readAloudVoice, readAloudVoiceLang } = await import('~/composables/useReadAloud')
const ReadAloudSettings = (await import('~/components/ReadAloudSettings.vue')).default

beforeEach(() => {
  device.ios = false
  deviceVoices.value = [...macChromiumVoices]
  readAloudEngine.value = 'device'
  readAloudVoice.value = ''
  readAloudVoiceLang.value = 'mine'
  readAloudHideLow.value = true
  document.body.innerHTML = ''
})

async function openVoices() {
  const w = await mountSuspended(ReadAloudSettings, { attachTo: document.body })
  await w.find('[data-testid="read-aloud-voice"]').trigger('click')
  await vi.waitFor(() => expect(document.body.querySelectorAll('[role="option"]').length).toBeGreaterThan(0))
  return w
}
const options = () => [...document.body.querySelectorAll('[role="option"]')].map(o => o.textContent!.replace(/\s+/g, ' ').trim())
const sections = () => [...document.body.querySelectorAll('.read-aloud-section')].map(o => o.textContent!.trim())

describe('ReadAloudSettings voice picker', () => {
  it('lists the user’s languages without low-quality voices, best first', async () => {
    const w = await openVoices()
    expect(sections()).toEqual(['Premium', 'Enhanced', 'Standard', 'Online · sends the text to its vendor'])
    const o = options()
    expect(o[0]).toContain('System default')
    expect(o[1]).toContain('Ava (Premium)')
    expect(o.join('|')).not.toMatch(/Albert|Eddy|Grandma|Anna|Kyoko|Google Deutsch/)
    expect(o.join('|')).toMatch(/Thomas.*Amélie.*Google US English/)
    expect(w.find('[role="checkbox"]').attributes('aria-checked')).toBe('true')
    expect(w.find('[data-testid="read-aloud-lang"]').text()).toContain('My languages (French, English)')
    w.unmount()
  })

  it('filters one language, or shows the low-quality voices once unchecked', async () => {
    readAloudVoiceLang.value = 'de'
    const w = await openVoices()
    expect(options().slice(1)).toEqual([expect.stringContaining('Anna'), expect.stringContaining('Google Deutsch')])
    w.unmount()
    readAloudVoiceLang.value = 'all'
    readAloudHideLow.value = false
    const w2 = await openVoices()
    expect(sections().at(-1)).toBe('Low quality')
    expect(options().join('|')).toMatch(/Zarvox.*Eddy \(French \(France\)\)/)
    w2.unmount()
  })

  it('keeps the chosen voice listed even when a filter hides it', async () => {
    readAloudVoice.value = 'Eddy (English (United Kingdom))'
    readAloudVoiceLang.value = 'de'
    const w = await openVoices()
    expect(options().join('|')).toContain('Eddy (English (United Kingdom))')
    expect(options().join('|')).not.toContain('Eddy (French (France))')
    expect(sections()).toContain('Low quality')
    w.unmount()
  })

  it('says on iOS only that Premium and Enhanced voices are kept for native apps', async () => {
    const note = '[data-testid="read-aloud-ios-note"]'
    const w = await mountSuspended(ReadAloudSettings)
    expect(w.find(note).exists()).toBe(false)
    w.unmount()
    device.ios = true
    const w2 = await mountSuspended(ReadAloudSettings)
    expect(w2.find(note).text()).toContain('web apps like wherdr only get the standard ones')
    w2.unmount()
  })
})

describe('ReadAloudSettings voice of wherdr', () => {
  const row = (w: Awaited<ReturnType<typeof mountSuspended>>, id: string) => w.find(`[data-voice="${id}"]`)
  const state = (w: Awaited<ReturnType<typeof mountSuspended>>, id: string) => row(w, id).find('[data-testid="voice-state"]').text()
  beforeEach(() => { vi.stubGlobal('caches', fakeCaches()) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('is a third choice kept on this device, one row per language with its attribution', async () => {
    const w = await mountSuspended(ReadAloudSettings)
    expect(w.text()).toContain('Voice of wherdr (on this device)')
    await w.find('[role="radio"][value="wherdr"]').trigger('click')
    await flushPromises()
    expect(localStorage.getItem('readAloud')).toBe('wherdr')
    expect(w.findAll('[data-voice] b').map(b => b.text())).toEqual(['Siwis · French', 'Cori · English'])
    expect(row(w, 'siwis-medium').find('[data-testid="voice-attribution"]').text()).toContain('SIWIS French Speech Synthesis Database')
    expect(state(w, 'siwis-medium')).toMatch(/^Install · \d+ MB$/)
    w.unmount()
  })

  it('installs with progress, cancels, and deletes a voice', async () => {
    readAloudEngine.value = 'wherdr'
    const { VOICES, asStored } = await import('~/utils/speech/neuralVoice')
    const cori = asStored(VOICES.find(v => v.id === 'cori-medium')!) as DeviceModel
    const w = await mountSuspended(ReadAloudSettings)
    await flushPromises()
    // A download that waits until it is cancelled.
    vi.stubGlobal('fetch', (_: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.aborted ? reject(init.signal!.reason) : init.signal!.addEventListener('abort', () => reject(init.signal!.reason))))
    await row(w, 'cori-medium').find('[data-testid="voice-install"]').trigger('click')
    expect(row(w, 'cori-medium').find('progress').exists()).toBe(true)
    await row(w, 'cori-medium').find('[data-testid="voice-cancel"]').trigger('click')
    await vi.waitFor(() => expect(state(w, 'cori-medium')).toMatch(/^Install · \d+ MB$/))

    vi.stubGlobal('fetch', rangeServer(cori).fetch)
    await row(w, 'cori-medium').find('[data-testid="voice-install"]').trigger('click')
    await vi.waitFor(() => expect(state(w, 'cori-medium')).toContain('Installed'), { timeout: 5000 })
    expect(row(w, 'cori-medium').find('[data-testid="voice-test"]').exists()).toBe(true)
    // What the download took on this device, for the catalog's figures.
    expect(row(w, 'cori-medium').find('[data-testid="voice-measure"]').text()).toMatch(/^Download \d+\.\d s$/)
    await row(w, 'cori-medium').find('[data-testid="voice-delete"]').trigger('click')
    await vi.waitFor(() => expect(state(w, 'cori-medium')).toMatch(/^Install · \d+ MB$/))
    w.unmount()
  })
})
