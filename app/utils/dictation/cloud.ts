// The online engine: the take as a WAV to the wherdr server, which relays it
// to OpenRouter with the key it keeps (server/utils/dictation.ts). The browser
// never sees the key.
import { abortError } from './engine'
import type { DictationEngine, Readiness, Take, TranscribeOptions } from './engine'
import { encodeWav } from './wav'
import { readCloudOptions, type CloudOptions } from './cloudOptions'
import { dictionaryOf } from './rewrite'

// The terms ride in the query string: kept well under a URL's limits.
const TERMS_MAX = 4000

export interface CloudResult { text: string, ms: number, cost?: number }

export async function cloudTranscribe(take: Take, opts: TranscribeOptions, o: CloudOptions = readCloudOptions()): Promise<CloudResult> {
  const { signal } = opts
  if (signal.aborted) throw abortError()
  const q = new URLSearchParams({ model: o.model, zdr: o.zdr ? '1' : '0' })
  if (opts.language) q.set('language', opts.language)
  // The personal dictionary always, the pane terms when asked.
  const terms = [...new Set([...dictionaryOf(), ...(o.terms ? opts.terms : [])])]
  while (terms.join('\n').length > TERMS_MAX) terms.pop()
  if (terms.length) q.set('terms', terms.join('\n'))
  const t0 = performance.now()
  // The engine answers × at once, whatever fetch does with its signal.
  const cancelled = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true }))
  const run = (async () => {
    const r = await fetch(`/api/dictation/transcribe?${q}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: encodeWav(take.pcm), signal })
    const data = await r.json().catch(() => ({})) as { text?: string, cost?: number, error?: string }
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
    return { text: data.text || '', ms: Math.round(performance.now() - t0), cost: data.cost }
  })()
  return Promise.race([run, cancelled])
}

export function createCloudEngine(): DictationEngine {
  return {
    id: 'cloud',
    caps: { terms: true, languages: 'many', offline: false },
    async readiness(): Promise<Readiness> {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ready: false, reason: 'offline' }
      try {
        const r = await fetch('/api/dictation/status')
        const s = await r.json() as { set?: boolean }
        return s.set ? { ready: true } : { ready: false, reason: 'no-key' }
      } catch (e) {
        return { ready: false, reason: 'offline', detail: e instanceof Error ? e.message : String(e) }
      }
    },
    async prepare() {},
    transcribe: (take, opts) => cloudTranscribe(take, opts),
    dispose() {},
  }
}
