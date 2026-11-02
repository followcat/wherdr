// Background for context-capable ASR engines. Preserve the app's actual
// source text: extracting ASCII words and filtering an English dictionary
// discards names, numbers and entire languages before the model sees them.
export interface AsrContextInput {
  agent?: string | null
  machine?: string | null
  name?: string | null
  title?: string | null
  cwd?: string | null
  draft?: string
  files?: (string | null | undefined)[]
  recent?: string[]
}

// Match the worker's mobile prompt budget. Bound each source too, so one
// long paste cannot crowd out the pane identity and recent conversation.
const MAX_CONTEXT = 400
const MAX_SOURCE = 160
function tail(text: string, limit: number): string {
  const out = text.slice(-limit)
  // A UTF-16 budget must not leave half of a supplementary character.
  return out.replace(/^[\uDC00-\uDFFF]/, '')
}

export function buildAsrContext(o: AsrContextInput): string {
  const cwd = (o.cwd || '').split('/').filter(Boolean).slice(-2).join('/')
  const identity = [o.agent, o.machine, o.name, o.title, cwd].filter(Boolean).join('\n')
  const sources = [o.draft, identity, ...(o.recent || []).slice(-3).reverse(), ...(o.files || [])]
  const seen = new Set<string>()
  let context = ''
  for (const value of sources) {
    const text = String(value || '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    const remaining = MAX_CONTEXT - context.length - (context ? 1 : 0)
    if (remaining <= 0) break
    const excerpt = tail(text, Math.min(MAX_SOURCE, remaining))
    if (excerpt) context += (context ? '\n' : '') + excerpt
  }
  return context
}
