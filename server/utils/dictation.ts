// Dictation through OpenRouter (Settings › Conversation › Dictation › Online).
// The key lives on this server only: OPENROUTER_API_KEY, else
// DATA_DIR/openrouter.json (mode 0600). It is never sent back to a browser
// (status gives its last 4 characters) and never written to a log; upstream
// error text is scrubbed of it too. The browser sends a 16 kHz WAV, the server
// relays it as base64 to OpenRouter's transcription endpoint.
import fs from 'node:fs'
import path from 'node:path'
import { HerdrError } from './herdr'
import { createRateLimit } from './rateLimit'
import { DEFAULT_CLOUD_MODEL, FALLBACK_CLOUD_MODELS, cheapestTextModel, sttModels, textModels, type DictationModel, type TextModel } from '../../shared/dictationModels'
import { REWRITE_TEXT_MAX, rewriteAnswer, rewriteMessages } from '../../shared/dictationRewrite'

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/audio/transcriptions'
// Only the transcription models (the filter is checked again in sttModels).
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=transcription'
// The optional rewrite: a chat model, from the text models.
export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
export const OPENROUTER_TEXT_MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=text'
export const REWRITE_TIMEOUT_MS = 30_000
// The model list is kept 6 hours; after a failed fetch, retried after a minute.
export const MODELS_TTL_MS = 6 * 3600_000
export const MODELS_RETRY_MS = 60_000
export const DICTATION_MAX = 8 * 1024 * 1024 // a 120 s take is 3.8 MB
export const DICTATION_TIMEOUT_MS = 60_000
// Takes relayed to OpenRouter at once (all clients), and per client per minute.
export const DICTATION_CONCURRENT = 2
export const DICTATION_PER_MINUTE = 10
const KEY_RE = /^[\x21-\x7E]{16,256}$/
const MODEL_RE = /^[\w.-]+\/[\w.:-]+$/
const LANG_RE = /^[a-z]{2}$/

export interface DictationStatus { set: boolean, last4?: string, env?: boolean }
export interface ModelList { models: DictationModel[], live: boolean }
export interface TextModelList { models: TextModel[], live: boolean, default?: string }
export interface TranscribeParams { model?: string, language?: string, terms?: string, zdr?: string }
export interface RewriteParams { text?: unknown, model?: unknown, prompt?: unknown, dictionary?: unknown, zdr?: unknown }

export function createDictation(o: { dataDir: string, envKey?: string, fetch?: typeof fetch, timeoutMs?: number, now?: () => number }) {
  const now = o.now || Date.now
  const perMinute = createRateLimit(DICTATION_PER_MINUTE, 60_000)
  const rewritesPerMinute = createRateLimit(DICTATION_PER_MINUTE, 60_000)
  let running = 0
  let rewriting = 0
  const file = path.join(o.dataDir, 'openrouter.json')
  const fileKey = (): string => {
    try {
      const k = JSON.parse(fs.readFileSync(file, 'utf8'))?.key
      return typeof k === 'string' ? k : ''
    } catch { return '' }
  }
  const key = () => o.envKey || fileKey()
  const scrub = (s: string) => { const k = key(); return k ? s.split(k).join('…') : s }

  function status(): DictationStatus {
    const k = key()
    return k ? { set: true, last4: k.slice(-4), ...(o.envKey ? { env: true } : {}) } : { set: false }
  }

  function saveKey(raw: unknown): DictationStatus {
    const k = typeof raw === 'string' ? raw.trim() : ''
    if (!KEY_RE.test(k)) throw new HerdrError('bad_key', 'This does not look like an OpenRouter key')
    fs.mkdirSync(o.dataDir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify({ key: k })}\n`, { mode: 0o600 })
    fs.renameSync(tmp, file)
    fs.chmodSync(file, 0o600)
    return status()
  }

  function deleteKey(): DictationStatus {
    fs.rmSync(file, { force: true })
    return status()
  }

  // `signal`: the browser went away (× or a closed tab): OpenRouter is cut too.
  // `client`: who sent the take (clientKey), for the per-minute limit.
  async function transcribe(wav: Buffer, p: TranscribeParams, signal?: AbortSignal, client = ''): Promise<{ text: string, seconds?: number, cost?: number }> {
    if (running >= DICTATION_CONCURRENT) throw new HerdrError('rate_limited', 'Too many dictations at once, try again in a moment')
    if (!perMinute.take(client)) throw new HerdrError('rate_limited', 'Too many dictations, wait a minute')
    running++
    try { return await relay(wav, p, signal) }
    finally { running-- }
  }

  async function relay(wav: Buffer, p: TranscribeParams, signal?: AbortSignal): Promise<{ text: string, seconds?: number, cost?: number }> {
    const k = key()
    if (!k) throw new HerdrError('no_key', 'No OpenRouter key on this server')
    if (wav.length > DICTATION_MAX) throw new HerdrError('too_large', 'Recording too large (8 MB max)')
    if (wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE') throw new HerdrError('bad_audio', 'Not a WAV recording')
    const model = p.model && MODEL_RE.test(p.model) ? p.model : DEFAULT_CLOUD_MODEL
    const keyterms = (p.terms || '').split('\n').map(s => s.trim().slice(0, 100)).filter(Boolean).slice(0, 1000)
    const body = {
      model,
      input_audio: { data: wav.toString('base64'), format: 'wav' },
      ...(p.language && LANG_RE.test(p.language) ? { language: p.language } : {}),
      ...(keyterms.length ? { keyterms } : {}),
      // ZDR unless the browser turned it off: only providers that keep nothing.
      provider: p.zdr === '0' ? { data_collection: 'deny' } : { zdr: true, data_collection: 'deny' },
    }
    type Answer = { text?: unknown, usage?: { seconds?: unknown, cost?: unknown } }
    const ms = o.timeoutMs ?? DICTATION_TIMEOUT_MS
    let data: Answer
    try { data = await post(OPENROUTER_URL, body, signal, ms) as Answer }
    catch (e) {
      // Terms are a hint: a model that refuses them (Whisper does, and the
      // model list does not say which) gets the take again without them.
      if (!keyterms.length || !(e instanceof HerdrError) || !/keyterm/i.test(e.message)) throw e
      const { keyterms: _dropped, ...plain } = body
      data = await post(OPENROUTER_URL, plain, signal, ms) as Answer
    }
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined
    return { text: typeof data.text === 'string' ? data.text.trim() : '', seconds: num(data.usage?.seconds), cost: num(data.usage?.cost) }
  }

  // One call to OpenRouter with the key; its error text never carries the key.
  async function post(url: string, body: unknown, signal: AbortSignal | undefined, ms: number): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(ms)
    let r: Response
    try {
      r = await (o.fetch || fetch)(url, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${key()}`, 'content-type': 'application/json', 'x-title': 'wherdr' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch (e) {
      if (signal?.aborted) throw new HerdrError('aborted', 'Dictation cancelled')
      if (timeout.aborted) throw new HerdrError('upstream', 'OpenRouter took too long')
      throw new HerdrError('upstream', scrub(`OpenRouter unreachable: ${(e as Error)?.message || e}`))
    }
    const data = await r.json().catch(() => ({})) as { error?: { message?: unknown } }
    if (!r.ok) {
      const msg = typeof data.error?.message === 'string' ? data.error.message.slice(0, 300) : `HTTP ${r.status}`
      throw new HerdrError(r.status === 401 ? 'bad_key' : 'upstream', scrub(`OpenRouter: ${msg}`))
    }
    return data
  }

  // The optional rewrite of a take's text by a chat model (shared/dictationRewrite.ts).
  async function rewrite(p: RewriteParams, signal?: AbortSignal, client = ''): Promise<{ text: string, cost?: number }> {
    if (!key()) throw new HerdrError('no_key', 'No OpenRouter key on this server')
    const text = typeof p.text === 'string' ? p.text.trim() : ''
    if (!text) throw new HerdrError('bad_text', 'Nothing to rewrite')
    if (text.length > REWRITE_TEXT_MAX) throw new HerdrError('too_large', 'Text too long to rewrite')
    if (rewriting >= DICTATION_CONCURRENT) throw new HerdrError('rate_limited', 'Too many rewrites at once, try again in a moment')
    if (!rewritesPerMinute.take(client)) throw new HerdrError('rate_limited', 'Too many rewrites, wait a minute')
    rewriting++
    try {
      const model = typeof p.model === 'string' && MODEL_RE.test(p.model) ? p.model : (await texts()).default
      if (!model) throw new HerdrError('upstream', 'No rewrite model available')
      const data = await post(OPENROUTER_CHAT_URL, {
        model,
        messages: rewriteMessages(text, typeof p.prompt === 'string' ? p.prompt : '', Array.isArray(p.dictionary) ? p.dictionary.map(String) : []),
        temperature: 0,
        max_tokens: 4096,
        provider: p.zdr === false ? { data_collection: 'deny' } : { zdr: true, data_collection: 'deny' },
      }, signal, o.timeoutMs ?? REWRITE_TIMEOUT_MS) as { choices?: { message?: { content?: unknown } }[], usage?: { cost?: unknown } }
      const out = rewriteAnswer(data.choices?.[0]?.message?.content, text)
      if (!out) throw new HerdrError('upstream', 'OpenRouter: empty rewrite')
      const cost = data.usage?.cost
      return { text: out, ...(typeof cost === 'number' && Number.isFinite(cost) ? { cost } : {}) }
    } finally { rewriting-- }
  }

  // OpenRouter's speech-to-text models, once a key is saved (nothing leaves
  // this server before). One fetch at a time; the last good list is kept
  // 6 hours and served stale while OpenRouter fails; with none, the fallback.
  function cachedList<T>(url: string, parse: (answer: unknown) => T[], fallback: T[]) {
    let cache: { models: T[], at: number } | null = null
    let failedAt = -Infinity
    let pending: Promise<{ models: T[], live: boolean }> | null = null
    return async (): Promise<{ models: T[], live: boolean }> => {
      const k = key()
      if (!k) return { models: fallback, live: false }
      const t = now()
      if (cache && t - cache.at < MODELS_TTL_MS) return { models: cache.models, live: true }
      const stale = () => cache ? { models: cache.models, live: true } : { models: fallback, live: false }
      if (t - failedAt < MODELS_RETRY_MS) return stale()
      pending ||= (async () => {
        try {
          const r = await (o.fetch || fetch)(url, {
            headers: { 'authorization': `Bearer ${k}`, 'x-title': 'wherdr' },
            signal: AbortSignal.timeout(o.timeoutMs ?? DICTATION_TIMEOUT_MS),
          })
          const list = r.ok ? parse(await r.json().catch(() => null)) : []
          if (!list.length) throw new Error(`HTTP ${r.status}`)
          cache = { models: list, at: now() }
          return { models: list, live: true }
        } catch {
          failedAt = now()
          return stale()
        }
      })().finally(() => { pending = null })
      return pending
    }
  }
  const models: () => Promise<ModelList> = cachedList<DictationModel>(OPENROUTER_MODELS_URL, sttModels, FALLBACK_CLOUD_MODELS)
  // The rewrite's chat models, with the cheapest paid one as the default.
  const textList = cachedList<TextModel>(OPENROUTER_TEXT_MODELS_URL, textModels, [])
  async function texts(): Promise<TextModelList> {
    const l = await textList()
    const d = cheapestTextModel(l.models)
    return { ...l, ...(d ? { default: d } : {}) }
  }

  return { status, saveKey, deleteKey, transcribe, models, rewrite, texts }
}
