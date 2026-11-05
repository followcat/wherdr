// The optional rewrite (Settings › Dictation › Rewrite), for every engine: the
// take's text goes through the wherdr server to a cheap OpenRouter chat model
// (POST /api/dictation/rewrite, shared/dictationRewrite.ts). Kept per device.
// When it fails, the raw text is kept: dictation never loses a take to it.
import { dictionaryTerms } from '../../../shared/dictationRewrite'
import { readCloudOptions } from './cloudOptions'

export interface RewriteOptions {
  on: boolean
  model: string // '' = the server's default, the cheapest paid model
  prompt: string // '' = DEFAULT_REWRITE_PROMPT
  dictionary: string // one term per line
}

export const REWRITE_OPTIONS_KEY = 'dictationRewrite'
export const REWRITE_DEFAULTS: RewriteOptions = { on: false, model: '', prompt: '', dictionary: '' }
export const REWRITE_TIMEOUT_MS = 30_000

export function readRewriteOptions(): RewriteOptions {
  try {
    const o = JSON.parse(localStorage.getItem(REWRITE_OPTIONS_KEY) || '{}')
    const str = (v: unknown) => typeof v === 'string' ? v : ''
    return { on: o.on === true, model: str(o.model), prompt: str(o.prompt), dictionary: str(o.dictionary) }
  } catch { return { ...REWRITE_DEFAULTS } }
}

export function writeRewriteOptions(o: RewriteOptions): void {
  try { localStorage.setItem(REWRITE_OPTIONS_KEY, JSON.stringify(o)) }
  catch { /* storage unavailable */ }
}

/** The personal dictionary, also sent as transcription terms where the engine takes them. */
export const dictionaryOf = (o: RewriteOptions = readRewriteOptions()) => dictionaryTerms(o.dictionary)

export interface RewriteResult { text: string, error?: string }

/**
 * The rewritten text, or the raw one with the reason it failed. Rejects only
 * with an AbortError, when `signal` aborts (the take was cancelled).
 */
export async function rewriteText(raw: string, signal: AbortSignal, o: RewriteOptions = readRewriteOptions()): Promise<RewriteResult> {
  const timeout = AbortSignal.timeout(REWRITE_TIMEOUT_MS)
  try {
    const r = await fetch('/api/dictation/rewrite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: raw, model: o.model || undefined, prompt: o.prompt || undefined, dictionary: dictionaryOf(o), zdr: readCloudOptions().zdr }),
      signal: AbortSignal.any([signal, timeout]),
    })
    const data = await r.json().catch(() => ({})) as { text?: unknown, error?: string }
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
    const text = typeof data.text === 'string' ? data.text.trim() : ''
    if (!text) throw new Error('Empty answer')
    return { text }
  } catch (e) {
    if (signal.aborted) throw e
    return { text: raw, error: timeout.aborted ? 'Timed out' : (e as Error)?.message || String(e) }
  }
}
