// Cantonese text front end shared by the Canto TTS worker: OpenCC s2t
// phrases and characters, the model's SentencePiece BPE (tokenizer.model),
// the added phoneme tokens, the Jyutping -> onset/rime/tone split, and
// word-aware chunking. A classic script loaded by
// public/workers/canto-tts-worker.js; pure functions on self.wherdrCantoText.
//
// The reference is canto-tts 0.1.4 (backends/onnx_backend.py
// _PhonemeEncoder, core/cantophon.py, backends/base.py safe_prepare_text).
'use strict'

;(() => {
// ── SentencePiece model ─────────────────────────────────────────────────────

function varint(buf, pos) {
  let value = 0
  let shift = 0
  for (;;) {
    const b = buf[pos++]
    value += (b & 0x7f) * 2 ** shift
    if (!(b & 0x80)) return [value, pos]
    shift += 7
    if (shift > 49) throw new Error('tokenizer.model: bad varint')
  }
}

function skipField(buf, pos, wire) {
  if (wire === 0) return varint(buf, pos)[1]
  if (wire === 1) return pos + 8
  if (wire === 2) { const [n, p] = varint(buf, pos); return p + n }
  if (wire === 5) return pos + 4
  throw new Error('tokenizer.model: unsupported wire type ' + wire)
}

function parseModel(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const dec = new TextDecoder()
  const pieces = []
  let pos = 0
  while (pos < buf.length) {
    const [tag, p1] = varint(buf, pos)
    pos = p1
    const field = tag >>> 3
    const wire = tag & 7
    if (field === 1 && wire === 2) {
      const [len, p2] = varint(buf, pos)
      pos = p2
      const end = pos + len
      let piece = ''
      let score = 0
      let type = 1
      while (pos < end) {
        const [t2, p3] = varint(buf, pos)
        pos = p3
        const f = t2 >>> 3
        const w = t2 & 7
        if (f === 1 && w === 2) {
          const [n, p4] = varint(buf, pos)
          pos = p4
          piece = dec.decode(buf.subarray(pos, pos + n))
          pos += n
        } else if (f === 2 && w === 5) {
          score = new DataView(buf.buffer, buf.byteOffset + pos, 4).getFloat32(0, true)
          pos += 4
        } else if (f === 3 && w === 0) {
          const [v, p4] = varint(buf, pos)
          type = v
          pos = p4
        } else {
          pos = skipField(buf, pos, w)
        }
      }
      pieces.push([piece, score, type])
    } else {
      pos = skipField(buf, pos, wire)
    }
  }
  const pieceToId = new Map()
  const scores = new Float32Array(pieces.length)
  for (let i = 0; i < pieces.length; i++) {
    scores[i] = pieces[i][1]
    if (!pieceToId.has(pieces[i][0])) pieceToId.set(pieces[i][0], i)
  }
  return { pieces, pieceToId, scores }
}

// ── nmt_nfkc subset + BPE ───────────────────────────────────────────────────

function normalizer() {
  const map = self.wherdrCantoNormalize || {}
  return (text) => {
    let out = ''
    for (const ch of text) {
      if (/\s/u.test(ch)) { out += ' '; continue }
      out += map[ch] ?? ch
    }
    out = out.normalize('NFC').replace(/ +/g, ' ').trim()
    if (!out) return ''
    return (' ' + out).replace(/ /g, '\u2581')
  }
}

function bytePiece(b) {
  return '<0x' + b.toString(16).toUpperCase().padStart(2, '0') + '>'
}

function encoder(modelBytes, addedTokens) {
  const model = parseModel(modelBytes)
  const { pieceToId, scores } = model
  const added = new Map(Object.entries(addedTokens).map(([k, v]) => [k, Number(v)]))
  const unk = pieceToId.get('<unk>') ?? 0
  const enc = new TextEncoder()
  const normalize = normalizer()

  function symbolsOf(text) {
    const out = []
    for (const ch of text) {
      const id = pieceToId.get(ch)
      if (id !== undefined) { out.push({ piece: ch, score: scores[id] }); continue }
      const bytes = enc.encode(ch)
      if (!bytes.length) continue
      for (const b of bytes) {
        const p = bytePiece(b)
        const bid = pieceToId.get(p)
        out.push({ piece: bid !== undefined ? p : '<unk>', score: bid !== undefined ? scores[bid] : 0 })
      }
    }
    return out
  }

  function encodeSegment(text) {
    const n = normalize(text)
    if (!n) return []
    const sym = symbolsOf(n)
    for (;;) {
      let best = -1
      let bestScore = -Infinity
      for (let i = 0; i + 1 < sym.length; i++) {
        const id = pieceToId.get(sym[i].piece + sym[i + 1].piece)
        if (id === undefined) continue
        const s = scores[id]
        if (s > bestScore) { bestScore = s; best = i }
      }
      if (best < 0) break
      sym[best] = { piece: sym[best].piece + sym[best + 1].piece, score: bestScore }
      sym.splice(best + 1, 1)
    }
    return sym.map(s => pieceToId.get(s.piece) ?? unk)
  }

  const keys = [...added.keys()].sort((a, b) => b.length - a.length)
  const pattern = keys.length ? new RegExp('(' + keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'g') : null

  function encodePhonemes(prepared) {
    if (!pattern) return [...encodeSegment(prepared)]
    const ids = []
    for (const part of prepared.split(pattern)) {
      if (!part) continue
      const direct = added.get(part)
      if (direct !== undefined) ids.push(direct)
      else ids.push(...encodeSegment(part))
    }
    return ids
  }

  return { encodePhonemes, encodeSegment, normalize, parseModel, pieceToId, scores, added }
}

// ── Jyutping -> the model's added phoneme tokens (cantophon.py) ──────────────

const ONSETS = ['b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'ng', 'h', 'gw', 'kw', 'w', 'z', 'c', 's', 'j']
  .sort((a, b) => b.length - a.length)
const RIMES = new Set(`
a aa aai aau aam aan aang aap aat aak
ai au am an ang ap at ak
e ei eu em eng ep et ek
i iu im in ing ip it ik
o oi ou om on ong op ot ok
oe oeng oet oek
eoi eon eot
u ui un ung ut uk
yu yun yut
m ng
`.trim().split(/\s+/))
const SYLLABIC = new Set(['m', 'ng'])
const SYL = /^[a-z]+[1-6]$/

function parseSyllable(syl) {
  if (SYLLABIC.has(syl)) return [null, syl]
  for (const on of ONSETS) {
    if (syl.startsWith(on)) {
      const rest = syl.slice(on.length)
      if (RIMES.has(rest)) return [on, rest]
    }
  }
  if (RIMES.has(syl)) return [null, syl]
  return null
}

function syllablePieces(jyut) {
  if (!SYL.test(jyut)) return [jyut]
  const tone = jyut[jyut.length - 1]
  const parsed = parseSyllable(jyut.slice(0, -1))
  if (!parsed) return [jyut]
  const [onset, rime] = parsed
  return [...(onset ? [`<o-${onset}>`] : []), `<r-${rime}>`, `<t${tone}>`]
}

function jyutpingToPieces(jyutping) {
  return String(jyutping).trim().split(/\s+/).filter(Boolean).flatMap(syllablePieces)
}

// ── safe_prepare_text (base.py) ─────────────────────────────────────────────

const SENTENCE_END = /[。！？.!?；;]$/

function safePrepare(text) {
  let t = String(text).trim().replace(/\r\n?|\n/g, ' ').replace(/  +/g, ' ')
  if (!t) return ''
  if (!SENTENCE_END.test(t)) t += '。'
  return t
}

// ── OpenCC s2t: phrases first (longest match), then characters ──────────────

function parseS2T(phrasesText, charsText) {
  function table(text, target) {
    for (const line of text.split('\n')) {
      if (!line || line[0] === '#') continue
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const key = line.slice(0, tab)
      const value = line.slice(tab + 1).trim().split(/\s+/)[0]
      if (key && value) target.set(key, value)
    }
    return target
  }
  const phrases = table(phrasesText, new Map())
  const chars = table(charsText, new Map())
  let max = 1
  for (const k of phrases.keys()) max = Math.max(max, k.length)
  function convert(text) {
    let out = ''
    for (let i = 0; i < text.length;) {
      let hit = false
      for (let len = Math.min(max, text.length - i); len >= 1; len--) {
        const v = phrases.get(text.slice(i, i + len))
        if (v !== undefined) { out += v; i += len; hit = true; break }
      }
      if (hit) continue
      const ch = text[i]
      out += chars.get(ch) ?? ch
      i++
    }
    return out
  }
  return { convert, phrases, chars, maxPhrase: max }
}

// ── Word-aware chunks ───────────────────────────────────────────────────────
//
// `words` is [{ token, jyutping, pieces }]. A word's pieces are atomic: a
// chunk never splits one. Punctuation ends a chunk; the first chunk is capped
// at half the main cap so its audio arrives sooner.
const PUNCT = /^[，,。.！!？?；;：:、]$/

function groupWords(words, { cap = 48, firstCap = 24 } = {}) {
  const groups = []
  let current = []
  let count = 0
  const flush = () => {
    if (current.length) groups.push({ words: current, pieces: current.flatMap(w => w.pieces) })
    current = []
    count = 0
  }
  for (const word of words) {
    if (!word.pieces.length) continue
    const limit = groups.length === 0 ? firstCap : cap
    if (current.length && count + word.pieces.length > limit) flush()
    current.push(word)
    count += word.pieces.length
    if (PUNCT.test(word.token)) flush()
  }
  flush()
  return groups
}

self.wherdrCantoText = {
  parseModel,
  encoder,
  jyutpingToPieces,
  safePrepare,
  parseS2T,
  groupWords,
  normalizer,
}
})()
