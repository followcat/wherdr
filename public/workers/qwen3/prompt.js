// The Qwen3-ASR prompt, from the pinned prompt_config.json (layout_version 2):
//
//   <|im_start|>system\n <context> <|im_end|>\n<|im_start|>user\n<|audio_start|>
//   <audio_pad> x nAudio  <|audio_end|><|im_end|>\n<|im_start|>assistant\n
//   [language <asr_text>]
//
// prefix_ids is the first line: the pane-terms context goes inside the system
// turn, after 'system\n' and before the turn's <|im_end|>. Then one audio_pad
// per encoder output frame, then suffix_ids. A forced language appends
// language_prefix_ids[lang] (it ends in <asr_text>, so generation starts on
// the transcript); with no forced language the model writes the header
// itself and parseOutput strips it.
// Ported from @followcat's public/workers/asr-worker.js
// (github.com/followcat/wherdr, branch mobile, MIT): the prompt part of
// decodeQ4F16.
//
//   wherdrQwen3.prompt.contextOf(terms) -> string
//   wherdrQwen3.prompt.buildPrompt(config, contextIds, nAudio, language?)
//     -> { ids, audioStart, maxNewTokens }
//   wherdrQwen3.prompt.parseOutput(config, generatedIds, decode)
//     -> { text, language?, truncated }
//   wherdrQwen3.prompt.languages(config) -> string[]

'use strict'

;(() => {
// The context string is capped at 400 Unicode code points, separators
// included, cut between terms: dictationTerms() bounds the source list,
// this bounds what reaches the model.
const CONTEXT_MAX = 400
const SEPARATOR = '\n'
const points = s => [...s].length

// terms -> one context string: trimmed, deduplicated, order kept, and the
// longest leading run of whole terms that fits the budget (never a term
// cut in half).
function contextOf(terms) {
  const seen = new Set()
  let context = ''
  for (const t of terms || []) {
    const term = String(t == null ? '' : t).trim()
    if (!term || seen.has(term)) continue
    seen.add(term)
    const next = context ? context + SEPARATOR + term : term
    if (points(next) > CONTEXT_MAX) break
    context = next
  }
  return context
}

// The system turn ends at the first <|im_end|> of prefix_ids — an eos id in
// this layout. Anything else means the pinned file changed; fail loudly
// rather than splice the context in the wrong place.
function contextIndex(prompt) {
  const eos = new Set(prompt.eos_ids)
  const at = prompt.prefix_ids.findIndex(id => eos.has(id))
  if (at <= 0) throw new Error('unexpected prompt layout')
  return at
}

// The full input id list. language is TranscribeOptions.language (ISO
// 639-1, plus 'yue'); an unknown or absent one leaves the model on
// automatic language detection.
function buildPrompt(config, contextIds, nAudio, language) {
  const p = config.prompt
  const ids = p.prefix_ids.slice()
  ids.splice(contextIndex(p), 0, ...(contextIds || []))
  const audioStart = ids.length
  for (let i = 0; i < nAudio; i++) ids.push(p.audio_pad_id)
  ids.push(...p.suffix_ids)
  const lang = (config.language_prefix_ids || {})[language]
  if (lang) ids.push(...lang)
  return { ids, audioStart, maxNewTokens: p.max_new_tokens }
}

// Generated ids -> text: stop at the first eos, then strip an automatic
// 'language X<asr_text>' header (nothing is stripped when the language was
// forced: the model starts on the transcript). truncated is true only
// when the ids end without an eos after the full max_new_tokens budget —
// a short answer with no eos is just missing its stop mark.
function parseOutput(config, generated, decode) {
  const p = config.prompt
  const eos = new Set(p.eos_ids)
  const end = generated.findIndex(id => eos.has(id))
  const body = end < 0 ? generated : generated.slice(0, end)
  const cut = body.indexOf(p.asr_text_id)
  const head = cut < 0 ? [] : body.slice(0, cut)
  const ids = cut < 0 ? body : body.slice(cut + 1)
  let language
  for (const [lang, pre] of Object.entries(config.language_prefix_ids || {})) {
    if (pre.length - 1 === head.length && pre.slice(0, -1).every((v, i) => v === head[i])) language = lang
  }
  return { text: decode(ids), language, truncated: end < 0 && generated.length >= p.max_new_tokens }
}

const Q = self.wherdrQwen3 = self.wherdrQwen3 || {}
Q.prompt = {
  CONTEXT_MAX,
  contextOf,
  buildPrompt,
  parseOutput,
  languages: config => Object.keys(config.language_prefix_ids || {}),
}
})()
