// Byte-level BPE for the Qwen3-ASR models, driven by the model's own
// tokenizer.json: encode tokenizes the context string spliced into the
// prompt's system turn (prompt.js), decode turns generated ids back to
// text. The file's declared normalizer and pre-tokenizer are checked, not
// approximated: a different split or Unicode normalization changes the
// embedding ids.
// Ported from @followcat's public/workers/asr-worker.js
// (github.com/followcat/wherdr, branch mobile, MIT): q4Tokenizer.
//
//   wherdrQwen3.tokenizer(tokenizerJson) -> { encode(str)->number[],
//                                             decode(ids)->string }

'use strict'

;(() => {
// The GPT-2 byte<->unicode table: every byte maps to one printable char, so
// any UTF-8 sequence tokenizes (byte fallback) and detokenizes exactly.
function bytesToUnicode() {
  const bs = []
  for (let b = 0x21; b <= 0x7e; b++) bs.push(b)
  for (let b = 0xa1; b <= 0xac; b++) bs.push(b)
  for (let b = 0xae; b <= 0xff; b++) bs.push(b)
  const cs = bs.slice()
  let n = 0
  for (let b = 0; b < 256; b++) { if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++ } }
  const m = new Map()
  for (let i = 0; i < bs.length; i++) m.set(String.fromCharCode(cs[i]), bs[i])
  return m
}

function tokenizer(tj) {
  // Use this export's tokenizer contract, not a hand-written approximation:
  // a different split or Unicode normalization changes the embedding ids.
  const [split, bytes] = tj.pre_tokenizer?.pretokenizers || []
  const form = tj.normalizer?.type
  if (tj.pre_tokenizer?.type !== 'Sequence' || tj.pre_tokenizer.pretokenizers?.length !== 2
    || split?.type !== 'Split' || split.behavior !== 'Isolated' || split.invert
    || typeof split.pattern?.Regex !== 'string' || bytes?.type !== 'ByteLevel'
    || bytes.add_prefix_space || bytes.use_regex
    || (form && !['NFC', 'NFD', 'NFKC', 'NFKD'].includes(form))) {
    throw new Error('Unsupported speech model tokenizer configuration')
  }
  const idTo = [], vocab = new Map()
  for (const [t, id] of Object.entries(tj.model.vocab)) { idTo[id] = t; vocab.set(t, id) }
  const sp = new Map()
  for (const t of tj.added_tokens || []) sp.set(t.id, t.content)
  const c2b = bytesToUnicode(), td = new TextDecoder('utf-8'), te = new TextEncoder()
  // Inverse of c2b: byte -> the mapped char vocab strings are written in.
  const b2c = new Map()
  for (const [ch, b] of c2b) b2c.set(b, ch)
  const merges = new Map()
  for (let i = 0; i < (tj.model.merges || []).length; i++) {
    const e = tj.model.merges[i]
    merges.set(typeof e === 'string' ? e : e.join(' '), i)
  }
  let PRE
  try { PRE = new RegExp(split.pattern.Regex, 'gu') } catch {
    throw new Error('Unsupported speech model tokenizer configuration')
  }
  // Never match added/special tokens in pane terms: even <|im_end|> must
  // stay ordinary bytes, so terminal-controlled text cannot close the system turn.
  function encode(str) {
    const out = []
    const text = form ? String(str).normalize(form) : String(str)
    for (const m of text.matchAll(PRE)) {
      let word = ''
      for (const byte of te.encode(m[0])) word += b2c.get(byte)
      const parts = [...word]
      for (;;) {
        let best = -1, bi = -1
        for (let i = 0; i + 1 < parts.length; i++) {
          const r = merges.get(parts[i] + ' ' + parts[i + 1])
          if (r !== undefined && (best < 0 || r < best)) { best = r; bi = i }
        }
        if (bi < 0) break
        parts.splice(bi, 2, parts[bi] + parts[bi + 1])
      }
      for (const p of parts) {
        const id = vocab.get(p)
        if (id === undefined) throw new Error('Missing speech model tokenizer piece')
        out.push(id)
      }
    }
    return out
  }
  return {
    encode,
    decode(ids) {
      const bytes = []
      let out = ''
      const flush = () => { if (bytes.length) { out += td.decode(new Uint8Array(bytes)); bytes.length = 0 } }
      for (const id of ids) {
        if (sp.has(id)) { flush(); continue }
        const tok = idTo[id]
        if (tok === undefined) { flush(); continue }
        for (const ch of tok) {
          const b = c2b.get(ch)
          if (b === undefined) { flush(); out += ch } else bytes.push(b)
        }
      }
      flush()
      return out
    },
  }
}

const Q = self.wherdrQwen3 = self.wherdrQwen3 || {}
Q.tokenizer = tokenizer
})()
