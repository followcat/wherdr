// Settings › Dictation › Rewrite: off by default, kept on this device; the
// model list comes from the server with its cheapest paid default, and a
// model without a plain price links to its OpenRouter page.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import DictationRewriteSettings from '~/components/DictationRewriteSettings.vue'
import { REWRITE_OPTIONS_KEY } from '~/utils/dictation/rewrite'
import { DEFAULT_REWRITE_PROMPT } from '#shared/dictationRewrite'

let keySet = true
registerEndpoint('/api/dictation/status', () => keySet ? { set: true, last4: '0000' } : { set: false })
registerEndpoint('/api/dictation/text-models', () => ({ live: true, default: 'mistralai/mistral-nemo', models: [
  { id: 'mistralai/mistral-nemo', name: 'Mistral: Mistral Nemo', perM: { in: 0.029, out: 0.03 } },
  { id: 'openai/gpt-5-mini', name: 'OpenAI: GPT-5 Mini', perM: { in: 0.25, out: 2 } },
  { id: 'openrouter/auto', name: 'Auto Router' },
] }))

const saved = () => JSON.parse(localStorage.getItem(REWRITE_OPTIONS_KEY) || '{}')
beforeEach(() => { keySet = true; localStorage.removeItem(REWRITE_OPTIONS_KEY) })

describe('DictationRewriteSettings', () => {
  it('is off by default; turning it on shows the default model, the prompt and saves on this device', async () => {
    const w = await mountSuspended(DictationRewriteSettings)
    await flushPromises()
    const on = w.find('[data-testid="dictation-rewrite-on"]')
    expect(on.attributes('aria-checked')).toBe('false')
    expect(w.find('[data-testid="dictation-rewrite-model"]').exists()).toBe(false)
    expect(w.find('[data-testid="dictation-rewrite-dictionary"]').exists()).toBe(true)
    await on.trigger('click')
    await flushPromises()
    expect(saved()).toMatchObject({ on: true, model: '' })
    await vi.waitFor(() => expect(w.text()).toContain('Default: the cheapest paid model right now, Mistral: Mistral Nemo.'))
    expect(w.find('[data-testid="dictation-rewrite-model"]').text()).toContain('Mistral Nemo')
    const prompt = w.find<HTMLTextAreaElement>('textarea[data-testid="dictation-rewrite-prompt"]')
    expect(prompt.element.value).toBe(DEFAULT_REWRITE_PROMPT)
    await prompt.setValue('Only fix punctuation.')
    await w.find('textarea[data-testid="dictation-rewrite-dictionary"]').setValue('wherdr\nherdr-core')
    await flushPromises()
    expect(saved()).toMatchObject({ prompt: 'Only fix punctuation.', dictionary: 'wherdr\nherdr-core' })
    await w.findAll('button').find(b => b.text() === 'Reset to default')!.trigger('click')
    await flushPromises()
    expect(saved().prompt).toBe('')
  })

  it('shows prices per million tokens, and a link to OpenRouter for a model without one', async () => {
    // The list is virtualised: give its viewport a size, as a browser would.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(240)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(320)
    localStorage.setItem(REWRITE_OPTIONS_KEY, JSON.stringify({ on: true }))
    const w = await mountSuspended(DictationRewriteSettings, { attachTo: document.body })
    await flushPromises()
    await vi.waitFor(() => expect(w.text()).toContain('Mistral Nemo'))
    await w.find('[data-testid="dictation-rewrite-model"]').trigger('click')
    const options = () => [...document.body.querySelectorAll('[role="option"]')]
    await vi.waitFor(() => expect(options()).toHaveLength(3))
    const text = options().map(o => o.textContent!.replace(/\s+/g, ' '))
    expect(text[0]).toContain('Mistral Nemo') // the default first
    expect(text.find(t => t.includes('GPT-5 Mini'))).toContain('$0.25 in · $2 out / M')
    const link = options().find(o => o.textContent!.includes('Auto Router'))!.querySelector('a')!
    expect(link.textContent).toBe('Price: see OpenRouter')
    expect(link.getAttribute('href')).toBe('https://openrouter.ai/openrouter/auto')
    w.unmount()
    vi.restoreAllMocks()
  })

  it('says the rewrite needs an OpenRouter key when none is saved', async () => {
    keySet = false
    const w = await mountSuspended(DictationRewriteSettings)
    await vi.waitFor(() => expect(w.find('[data-testid="dictation-rewrite-nokey"]').exists()).toBe(true))
  })
})
