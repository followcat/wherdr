import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DICTATION_MAX, MODELS_RETRY_MS, MODELS_TTL_MS, OPENROUTER_CHAT_URL, OPENROUTER_MODELS_URL, OPENROUTER_TEXT_MODELS_URL, OPENROUTER_URL, createDictation } from '../server/utils/dictation'
import { FALLBACK_CLOUD_MODELS } from '../shared/dictationModels'

const KEY = 'sk-or-test-key-0000'
// A WAV header and 0.1 s of 16 kHz silence: all the relay checks is RIFF/WAVE.
const wav = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'), Buffer.alloc(3200)])
let dir: string
let logs: unknown[][]

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dictation-'))
  logs = []
  for (const m of ['log', 'error', 'warn'] as const) vi.spyOn(console, m).mockImplementation((...a) => { logs.push(a) })
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }))
const noKey = (v: unknown) => expect(JSON.stringify(v) + JSON.stringify(logs)).not.toContain(KEY)

describe('dictation key store', () => {
  it('saves the key 0600 and only ever shows its last 4 characters', () => {
    const d = createDictation({ dataDir: dir })
    expect(d.status()).toEqual({ set: false })
    const saved = d.saveKey(` ${KEY} `)
    expect(saved).toEqual({ set: true, last4: '0000' })
    noKey(saved)
    const file = path.join(dir, 'openrouter.json')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).key).toBe(KEY)
    expect(d.deleteKey()).toEqual({ set: false })
    expect(fs.existsSync(file)).toBe(false)
  })

  it('refuses what is not a key, and the environment key wins', () => {
    const d = createDictation({ dataDir: dir, envKey: 'sk-or-test-key-1111' })
    expect(() => d.saveKey('short')).toThrow('does not look like')
    expect(() => d.saveKey(42)).toThrow()
    expect(d.status()).toEqual({ set: true, last4: '1111', env: true })
  })
})

describe('dictation relay', () => {
  it('sends base64 WAV, language, terms and ZDR, and returns the text', async () => {
    const fetch = answer(200, { text: ' hello wherdr ', usage: { seconds: 0.1, cost: 0.0000003 } })
    const d = createDictation({ dataDir: dir, fetch })
    d.saveKey(KEY)
    const out = await d.transcribe(wav, { model: 'mistralai/voxtral-mini-transcribe', language: 'fr', terms: 'wherdr\nclaude\n\n' })
    expect(out).toEqual({ text: 'hello wherdr', seconds: 0.1, cost: 0.0000003 })
    noKey(out)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(OPENROUTER_URL)
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ model: 'mistralai/voxtral-mini-transcribe', language: 'fr', keyterms: ['wherdr', 'claude'], provider: { zdr: true, data_collection: 'deny' } })
    expect(Buffer.from(body.input_audio.data, 'base64').equals(wav)).toBe(true)
  })

  it('falls back to the default model, drops a bad language, and turns ZDR off only when asked', async () => {
    const fetch = answer(200, { text: 'ok' })
    const d = createDictation({ dataDir: dir, fetch })
    d.saveKey(KEY)
    await d.transcribe(wav, { model: 'not a model', language: 'french', zdr: '0' })
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body.model).toBe('openai/whisper-large-v3-turbo')
    expect(body.language).toBeUndefined()
    expect(body.keyterms).toBeUndefined()
    expect(body.provider).toEqual({ data_collection: 'deny' })
  })

  it('without a key, says so and calls nobody', async () => {
    const fetch = answer(200, {})
    await expect(createDictation({ dataDir: dir, fetch }).transcribe(wav, {})).rejects.toMatchObject({ code: 'no_key' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses more than 8 MB and what is not a WAV', async () => {
    const fetch = answer(200, {})
    const d = createDictation({ dataDir: dir, fetch })
    d.saveKey(KEY)
    const big = Buffer.concat([wav, Buffer.alloc(DICTATION_MAX)])
    await expect(d.transcribe(big, {})).rejects.toMatchObject({ code: 'too_large' })
    await expect(d.transcribe(Buffer.from('not audio at all'), {})).rejects.toMatchObject({ code: 'bad_audio' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never lets the key out through an upstream error', async () => {
    const d = createDictation({ dataDir: dir, fetch: answer(401, { error: { message: `Invalid key ${KEY}` } }) })
    d.saveKey(KEY)
    const err = await d.transcribe(wav, {}).catch(e => e)
    expect(err.code).toBe('bad_key')
    expect(err.message).toContain('Invalid key')
    noKey(err.message)
    const down = createDictation({ dataDir: dir, fetch: vi.fn(async () => { throw new Error(`socket closed for ${KEY}`) }) })
    noKey((await down.transcribe(wav, {}).catch(e => e)).message)
  })

  it('cuts the OpenRouter request when the browser leaves, and after the timeout', async () => {
    let seen: AbortSignal | undefined
    const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => {
      seen = init.signal!
      seen.addEventListener('abort', () => reject(seen!.reason))
    }))
    const d = createDictation({ dataDir: dir, fetch: hang as unknown as typeof fetch })
    d.saveKey(KEY)
    const gone = new AbortController()
    const run = d.transcribe(wav, {}, gone.signal)
    await vi.waitFor(() => expect(seen).toBeDefined())
    gone.abort()
    await expect(run).rejects.toMatchObject({ code: 'aborted' })
    expect(seen!.aborted).toBe(true)

    const slow = createDictation({ dataDir: dir, fetch: hang as unknown as typeof fetch, timeoutMs: 20 })
    await expect(slow.transcribe(wav, {})).rejects.toMatchObject({ code: 'upstream', message: 'OpenRouter took too long' })
    noKey(logs)
  })
})

describe('dictation terms a model refuses', () => {
  it('sends the take again without keyterms when the model does not take them', async () => {
    const fetch = vi.fn(async (_u: string, init: RequestInit) => JSON.parse(String(init.body)).keyterms
      ? new Response(JSON.stringify({ error: { message: 'The selected model does not support keyterms' } }), { status: 400 })
      : new Response(JSON.stringify({ text: 'hello wherdr' }), { status: 200 }))
    const d = createDictation({ dataDir: dir, envKey: KEY, fetch })
    expect((await d.transcribe(wav, { terms: 'wherdr\nherdr-core' })).text).toBe('hello wherdr')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body)).keyterms).toBeUndefined()
  })

  it('does not retry other errors', async () => {
    const fetch = answer(400, { error: { message: 'Bad audio' } })
    const d = createDictation({ dataDir: dir, envKey: KEY, fetch })
    await expect(d.transcribe(wav, { terms: 'wherdr' })).rejects.toThrow('Bad audio')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('dictation limits', () => {
  it('relays at most 2 takes at once, then 10 per client per minute', async () => {
    const pending: (() => void)[] = []
    const fetch = vi.fn(() => new Promise<Response>(r => pending.push(() => r(new Response('{"text":"ok"}')))))
    const d = createDictation({ dataDir: dir, envKey: KEY, fetch })
    const a = d.transcribe(wav, {}, undefined, 'a')
    const b = d.transcribe(wav, {}, undefined, 'b')
    await expect(d.transcribe(wav, {}, undefined, 'c')).rejects.toMatchObject({ code: 'rate_limited' })
    expect(fetch).toHaveBeenCalledTimes(2)
    pending.splice(0).forEach(f => f())
    await Promise.all([a, b])
    // A failed take frees its place too.
    fetch.mockRejectedValueOnce(new Error('down'))
    await expect(d.transcribe(wav, {}, undefined, 'a')).rejects.toMatchObject({ code: 'upstream' })
    fetch.mockImplementation(async () => new Response('{"text":"ok"}'))
    for (let i = 0; i < 8; i++) await d.transcribe(wav, {}, undefined, 'a')
    await expect(d.transcribe(wav, {}, undefined, 'a')).rejects.toMatchObject({ code: 'rate_limited' })
    await expect(d.transcribe(wav, {}, undefined, 'b')).resolves.toMatchObject({ text: 'ok' })
  })
})

describe('dictation model list', () => {
  const STT = { input_modalities: ['audio'], output_modalities: ['transcription'] }
  const list = { data: [{ id: 'qwen/qwen3-asr-0.6b', name: 'Qwen3 ASR', architecture: STT, pricing: { prompt: '0.00000333', completion: '0' } }] }
  const live = { models: [{ id: 'qwen/qwen3-asr-0.6b', name: 'Qwen3 ASR', perMinute: 0.0002 }], live: true }

  it('fetches nothing without a key', async () => {
    const fetch = answer(200, list)
    const d = createDictation({ dataDir: dir, fetch })
    expect(await d.models()).toEqual({ models: FALLBACK_CLOUD_MODELS, live: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fetches once with the key, keeps the list 6 hours, and never shows the key', async () => {
    let t = 0
    const fetch = answer(200, list)
    const d = createDictation({ dataDir: dir, envKey: KEY, fetch, now: () => t })
    const [a, b] = await Promise.all([d.models(), d.models()])
    expect(a).toEqual(live)
    expect(b).toEqual(live)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(OPENROUTER_MODELS_URL)
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`)
    noKey(a)
    t = MODELS_TTL_MS - 1
    await d.models()
    expect(fetch).toHaveBeenCalledTimes(1)
    t = MODELS_TTL_MS
    await d.models()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('serves the last good list while OpenRouter fails, retrying after a minute', async () => {
    let t = 0
    let fail = false
    const fetch = vi.fn(async () => {
      if (fail) throw new Error(`down ${KEY}`)
      return new Response(JSON.stringify(list))
    })
    const d = createDictation({ dataDir: dir, envKey: KEY, fetch, now: () => t })
    await d.models()
    fail = true
    t = MODELS_TTL_MS
    expect(await d.models()).toEqual(live)
    expect(fetch).toHaveBeenCalledTimes(2)
    t += MODELS_RETRY_MS - 1
    await d.models()
    expect(fetch).toHaveBeenCalledTimes(2)
    fail = false
    t += 1
    expect(await d.models()).toEqual(live)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('falls back to the built-in list on an error or an empty answer', async () => {
    const d1 = createDictation({ dataDir: dir, envKey: KEY, fetch: answer(401, { error: { message: 'bad key' } }) })
    expect(await d1.models()).toEqual({ models: FALLBACK_CLOUD_MODELS, live: false })
    const d2 = createDictation({ dataDir: dir, envKey: KEY, fetch: answer(200, { data: [] }) })
    expect(await d2.models()).toEqual({ models: FALLBACK_CLOUD_MODELS, live: false })
  })
})

describe('dictation rewrite relay', () => {
  const TEXT = { input_modalities: ['text'], output_modalities: ['text'] }
  const texts = { data: [
    { id: 'openai/gpt-5-mini', name: 'GPT-5 Mini', architecture: TEXT, pricing: { prompt: '0.00000025', completion: '0.000002' } },
    { id: 'mistralai/mistral-nemo', name: 'Mistral Nemo', architecture: TEXT, pricing: { prompt: '0.000000029', completion: '0.00000003' } },
  ] }
  // The model list for GET /models, the chat answer for the completion.
  const upstream = (chat: { status: number, body: unknown }) => vi.fn(async (url: string) => url === OPENROUTER_TEXT_MODELS_URL
    ? new Response(JSON.stringify(texts), { status: 200 })
    : new Response(JSON.stringify(chat.body), { status: chat.status }))

  it('sends the prompt with the dictionary and the text to the cheapest model by default, with ZDR', async () => {
    const fetch = upstream({ status: 200, body: { choices: [{ message: { content: 'So wherdr is ready.' } }], usage: { cost: 0.00001 } } })
    const d = createDictation({ dataDir: dir, envKey: KEY, fetch })
    expect(await d.texts()).toMatchObject({ live: true, default: 'mistralai/mistral-nemo' })
    const r = await d.rewrite({ text: ' so uh wherdr is ready ', dictionary: ['wherdr'] })
    expect(r).toEqual({ text: 'So wherdr is ready.', cost: 0.00001 })
    const call = fetch.mock.calls.find(c => c[0] === OPENROUTER_CHAT_URL) as unknown as [string, RequestInit]
    const body = JSON.parse(String(call[1].body))
    expect(body.model).toBe('mistralai/mistral-nemo')
    expect(body.provider).toEqual({ zdr: true, data_collection: 'deny' })
    expect(body.messages[0].content).toContain('- wherdr')
    expect(body.messages[1].content).toContain('so uh wherdr is ready')
    noKey(body)
  })

  it('uses the chosen model, turns ZDR off only when asked, and scrubs the key from errors', async () => {
    const fetch = upstream({ status: 502, body: { error: { message: `bad ${KEY}` } } })
    const d = createDictation({ dataDir: dir, envKey: KEY, fetch })
    const err = await d.rewrite({ text: 'hi', model: 'openai/gpt-5-mini', zdr: false }).catch(e => e)
    expect(err.message).toContain('OpenRouter: bad')
    noKey(err.message)
    const body = JSON.parse(String((fetch.mock.calls.find(c => c[0] === OPENROUTER_CHAT_URL) as unknown as [string, RequestInit])[1].body))
    expect(body.model).toBe('openai/gpt-5-mini')
    expect(body.provider).toEqual({ data_collection: 'deny' })
  })

  it('refuses without a key or text, and an empty answer', async () => {
    const fetch = upstream({ status: 200, body: { choices: [{ message: { content: '' } }] } })
    await expect(createDictation({ dataDir: dir, fetch }).rewrite({ text: 'hi' })).rejects.toThrow('No OpenRouter key')
    const d = createDictation({ dataDir: dir, envKey: KEY, fetch })
    await expect(d.rewrite({ text: '  ' })).rejects.toThrow('Nothing to rewrite')
    await expect(d.rewrite({ text: 'hi', model: 'openai/gpt-5-mini' })).rejects.toThrow('empty rewrite')
  })
})
