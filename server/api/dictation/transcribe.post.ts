import { DICTATION_MAX } from '../../utils/dictation'

// One dictation take: the browser's WAV, relayed to OpenRouter (at most 2 at
// once, 10 per client per minute: server/utils/dictation.ts). The options
// come in the query (model, language, zdr, terms one per line).
export default defineApi((event, b) => {
  // The browser left before the answer (× or a closed tab): cut OpenRouter too.
  const gone = new AbortController()
  const res = event.node.res
  res.on('close', () => { if (!res.writableFinished) gone.abort() })
  const q = getQuery(event)
  const s = (v: unknown) => typeof v === 'string' ? v : undefined
  return dictation.transcribe(b.data, { model: s(q.model), language: s(q.language), terms: s(q.terms), zdr: s(q.zdr) }, gone.signal, clientKey(event))
}, { raw: /^audio\/(wav|x-wav)$/, max: DICTATION_MAX, tooLarge: 'Recording too large (8 MB max)' })
