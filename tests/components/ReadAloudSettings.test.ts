// Settings › Read aloud voice picker: the user's languages and no low-quality
// voices by default, a language filter, and the chosen voice always listed.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { macChromiumVoices } from '../fixtures/voices'

vi.hoisted(() => {
  Object.defineProperty(navigator, 'languages', { value: ['fr-FR', 'en-US'], configurable: true })
  // The voices are set on deviceVoices before each test.
  const synth = { speaking: false, pending: false, speak() {}, cancel() {}, resume() {}, getVoices: () => [], addEventListener() {} }
  Object.assign(globalThis, { speechSynthesis: synth, SpeechSynthesisUtterance: class {} })
})

const { deviceVoices, readAloudEngine, readAloudHideLow, readAloudVoice, readAloudVoiceLang } = await import('~/composables/useReadAloud')
const ReadAloudSettings = (await import('~/components/ReadAloudSettings.vue')).default

beforeEach(() => {
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
})
