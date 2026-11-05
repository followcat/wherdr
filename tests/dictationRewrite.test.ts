// The optional rewrite: the messages sent to the chat model, and the browser
// side that keeps the raw transcript whenever the rewrite fails.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_REWRITE_PROMPT, rewriteAnswer, rewriteMessages } from '../shared/dictationRewrite'
import { REWRITE_DEFAULTS, rewriteText } from '../app/utils/dictation/rewrite'

afterEach(() => { vi.unstubAllGlobals() })

describe('rewriteMessages', () => {
  it('puts the prompt and the dictionary in the system message, the text in the user one', () => {
    const [system, user] = rewriteMessages('euh so wherdr is uh ready', '', [' wherdr ', 'herdr-core', 'wherdr', ''])
    expect(system!.content.startsWith(DEFAULT_REWRITE_PROMPT)).toBe(true)
    expect(system!.content).toContain('Personal dictionary')
    expect(system!.content).toContain('- wherdr\n- herdr-core')
    expect(system!.content.match(/- wherdr/g)).toHaveLength(1)
    expect(user).toEqual({ role: 'user', content: '<transcript>\neuh so wherdr is uh ready\n</transcript>' })
  })

  it('uses the edited prompt, and no dictionary block without terms', () => {
    const [system] = rewriteMessages('hi', 'Only fix punctuation.')
    expect(system!.content.startsWith('Only fix punctuation.')).toBe(true)
    expect(system!.content).not.toContain('Personal dictionary')
  })

  it('drops echoed tags from the answer', () => {
    expect(rewriteAnswer('<transcript>\nHi.\n</transcript>')).toBe('Hi.')
    expect(rewriteAnswer(null)).toBe('')
  })

  it('drops quotes wrapped around the whole answer, unless the speaker quoted it', () => {
    // Mistral Nemo, real answer (2026-11-05).
    const raw = 'um so uh I I think we should uh merge the the werder branch into herder core you know before friday'
    expect(rewriteAnswer('"So, I think we should merge the Werder branch into Herder Core before Friday."', raw)).toBe('So, I think we should merge the Werder branch into Herder Core before Friday.')
    expect(rewriteAnswer('« Bon, on fusionne vendredi. »', 'euh bon on fusionne vendredi')).toBe('Bon, on fusionne vendredi.')
    expect(rewriteAnswer('"Ship it," he said, "now."', 'ship it he said now')).toBe('"Ship it," he said, "now."')
    expect(rewriteAnswer('"Ready."', '"ready"')).toBe('"Ready."')
  })
})

describe('rewriteText', () => {
  const opts = { ...REWRITE_DEFAULTS, on: true, model: 'mistralai/mistral-nemo', dictionary: 'wherdr\nherdr-core' }

  it('posts the text, model and dictionary, and returns the rewrite', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ text: ' So wherdr is ready. ' }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    expect(await rewriteText('so wherdr is uh ready', new AbortController().signal, opts)).toEqual({ text: 'So wherdr is ready.' })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/dictation/rewrite')
    expect(JSON.parse(String(init.body))).toMatchObject({ text: 'so wherdr is uh ready', model: 'mistralai/mistral-nemo', dictionary: ['wherdr', 'herdr-core'], zdr: true })
  })

  it('keeps the raw text when the server fails, answers nothing, or cannot be reached', async () => {
    const raw = 'so uh ready'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'OpenRouter: no ZDR provider' }), { status: 502 })))
    expect(await rewriteText(raw, new AbortController().signal, opts)).toEqual({ text: raw, error: 'OpenRouter: no ZDR provider' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ text: '' }), { status: 200 })))
    expect((await rewriteText(raw, new AbortController().signal, opts)).text).toBe(raw)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await rewriteText(raw, new AbortController().signal, opts)).toEqual({ text: raw, error: 'Failed to fetch' })
  })

  it('rejects when the take is cancelled', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })))
    const ac = new AbortController()
    const p = rewriteText('hi', ac.signal, opts)
    ac.abort()
    await expect(p).rejects.toThrow('Aborted')
  })
})
