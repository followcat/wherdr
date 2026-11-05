// OpenRouter's speech-to-text models, for Settings › Dictation › Online. The
// server fetches the list (server/utils/dictation.ts); the browser gets only
// these trimmed entries. The fallback stands in while no key is saved or
// OpenRouter cannot be reached.
export interface DictationModel { id: string, name: string, perMinute?: number }
// A chat model for the optional rewrite: dollars per million tokens, in and
// out, when OpenRouter gives a plain token price.
export interface TextModel { id: string, name: string, perM?: { in: number, out: number } }

// Where a model's price is shown when it is not a plain one here.
export const openRouterPage = (id: string) => `https://openrouter.ai/${id}`

export const DEFAULT_CLOUD_MODEL = 'openai/whisper-large-v3-turbo'
export const FALLBACK_CLOUD_MODELS: DictationModel[] = [
  { id: DEFAULT_CLOUD_MODEL, name: 'Whisper Large V3 Turbo', perMinute: 0.0002 },
  { id: 'mistralai/voxtral-mini-transcribe', name: 'Voxtral Mini Transcribe', perMinute: 0.003 },
  { id: 'openai/gpt-4o-mini-transcribe', name: 'GPT-4o Mini Transcribe' },
]

const TRANSCRIPTIONS = '/api/v1/audio/transcriptions'
const MODEL_RE = /^[\w.-]+\/[\w.:-]+$/
// Above $0.60 a minute the price is not per second (a provider quoting per
// hour, say): showing it would mislead, so it is left out.
const MAX_PER_SECOND = 0.01

interface RawModel {
  id?: unknown
  name?: unknown
  architecture?: { input_modalities?: unknown, output_modalities?: unknown }
  pricing?: { prompt?: unknown, completion?: unknown }
  endpoints?: unknown
}

const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []

/**
 * The speech-to-text models of a `GET /api/v1/models` answer. A model is kept
 * when it takes audio in and gives a transcription out (its architecture's
 * modalities), and, when the answer lists its endpoints, when one of them is
 * `/api/v1/audio/transcriptions`, the one the relay calls. Chat models that
 * merely accept audio (output `text`) are left out: they do not answer there.
 *
 * Price per minute: a transcription model priced by duration bills
 * `pricing.prompt` dollars per second of audio and nothing for the output. A
 * model that also bills output tokens is priced per token, so no per-minute
 * price is given for it.
 */
export function sttModels(answer: unknown): DictationModel[] {
  const data = (answer as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  const out: DictationModel[] = []
  const seen = new Set<string>()
  for (const m of data as RawModel[]) {
    if (typeof m?.id !== 'string' || !MODEL_RE.test(m.id) || seen.has(m.id)) continue
    if (!list(m.architecture?.input_modalities).includes('audio')) continue
    if (!list(m.architecture?.output_modalities).includes('transcription')) continue
    if (Array.isArray(m.endpoints) && !list(m.endpoints).includes(TRANSCRIPTIONS)) continue
    seen.add(m.id)
    const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 120) : m.id
    const perSecond = Number(m.pricing?.prompt)
    const output = Number(m.pricing?.completion ?? 0)
    const perMinute = Number.isFinite(perSecond) && perSecond > 0 && perSecond <= MAX_PER_SECOND && output === 0
      ? Number((perSecond * 60).toPrecision(3))
      : undefined
    out.push({ id: m.id, name, ...(perMinute !== undefined ? { perMinute } : {}) })
  }
  // The default first, then by price (unknown last), then by name.
  return out.sort((a, b) => Number(b.id === DEFAULT_CLOUD_MODEL) - Number(a.id === DEFAULT_CLOUD_MODEL)
    || (a.perMinute ?? Infinity) - (b.perMinute ?? Infinity)
    || a.name.localeCompare(b.name))
}

const price = (v: unknown): number | undefined => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : Number.NaN
  return Number.isFinite(n) && n >= 0 && v !== '' ? n : undefined
}

/**
 * The chat models of a `GET /api/v1/models?output_modalities=text` answer:
 * text in, text out. A price is given only when both token prices are plain
 * numbers ≥ 0 (routers say -1: no price, the page links to OpenRouter).
 */
export function textModels(answer: unknown): TextModel[] {
  const data = (answer as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  const out: TextModel[] = []
  const seen = new Set<string>()
  for (const m of data as RawModel[]) {
    if (typeof m?.id !== 'string' || !MODEL_RE.test(m.id) || seen.has(m.id)) continue
    if (!list(m.architecture?.input_modalities).includes('text')) continue
    if (!list(m.architecture?.output_modalities).includes('text')) continue
    seen.add(m.id)
    const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 120) : m.id
    const pin = price(m.pricing?.prompt)
    const pout = price(m.pricing?.completion)
    const perM = pin !== undefined && pout !== undefined
      ? { in: Number((pin * 1e6).toPrecision(3)), out: Number((pout * 1e6).toPrecision(3)) }
      : undefined
    out.push({ id: m.id, name, ...(perM ? { perM } : {}) })
  }
  // By price (in + out; unknown last), then by name.
  const cost = (m: TextModel) => m.perM ? m.perM.in + m.perM.out : Infinity
  return out.sort((a, b) => cost(a) - cost(b) || a.name.localeCompare(b.name))
}

/**
 * The rewrite's default: the cheapest paid chat model of the live list (in +
 * out per token). It must bill both input and output, as chat models do (a
 * model with free output is a special tool: extraction, summaries). Free
 * models are left out (rate-limited, and their providers may keep the text),
 * so are batch variants (answers come late).
 */
export function cheapestTextModel(models: TextModel[]): string | undefined {
  let best: TextModel | undefined
  const cost = (m: TextModel) => m.perM!.in + m.perM!.out
  for (const m of models) {
    if (!m.perM || m.perM.in <= 0 || m.perM.out <= 0 || m.id.endsWith(':free') || m.id.endsWith(':batch')) continue
    if (!best || cost(m) < cost(best)) best = m
  }
  return best?.id
}
