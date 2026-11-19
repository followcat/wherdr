// The Cantonese text front end: OpenCC s2t, the model's SentencePiece BPE,
// the added phoneme tokens, Jyutping -> onset/rime/tone, and word-aware
// chunks. public/workers/canto/text.js is a classic script; it is loaded here
// the way the worker loads it. The ids fixture (1040 strings) comes from the
// Python canto-tts 0.1.4 reference and tokenizer.model (both needed; skipped
// when the dev model folder is absent, as in CI).
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { sentenceChunks } from '../app/utils/speech/plainText'
import spm from './fixtures/cantoSpm.json'

const root = process.cwd()
const modelDir = path.join(root, 'data/models/canto-tts-nano-int8-01f53d9')
const textDir = path.join(root, 'data/models/canto-text-2.6.1')
const present = existsSync(path.join(modelDir, 'tokenizer.model')) && existsSync(path.join(textDir, 's2t/STPhrases.txt'))

function loadText() {
  const ctx = { console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, Map, Set, Number, Object, String, RegExp, Math, Error, JSON, Promise }
  ctx.self = ctx
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(readFileSync(path.join(root, 'public/workers/canto/normalize.js'), 'utf8'), ctx)
  vm.runInContext(readFileSync(path.join(root, 'public/workers/canto/text.js'), 'utf8'), ctx)
  return ctx.self.wherdrCantoText
}

describe('the Cantonese text front end', () => {
  it('encodes the reference strings exactly as SentencePiece does', () => {
    if (!present) return // CI has no tokenizer.model; the fixture is the reference.
    const text = loadText()
    const encoder = text.encoder(
      new Uint8Array(readFileSync(path.join(modelDir, 'tokenizer.model'))),
      JSON.parse(readFileSync(path.join(modelDir, 'added_tokens.json'), 'utf8')),
    )
    let bad = 0
    for (const c of spm.cases) {
      if (JSON.stringify(encoder.encodeSegment(c.text)) !== JSON.stringify(c.ids)) bad++
    }
    expect(spm.cases.length).toBeGreaterThanOrEqual(300)
    expect(bad).toBe(0)
  })

  it('splits Jyutping into the model’s onset/rime/tone tokens', () => {
    const text = loadText()
    expect(text.jyutpingToPieces('ngo5')).toEqual(['<o-ng>', '<r-o>', '<t5>'])
    expect(text.jyutpingToPieces('hou2 ge3')).toEqual(['<o-h>', '<r-ou>', '<t2>', '<o-g>', '<r-e>', '<t3>'])
    expect(text.jyutpingToPieces('，')).toEqual(['，'])
    expect(text.safePrepare('<o-g> <r-am> <t1>')).toBe('<o-g> <r-am> <t1>。')
    expect(text.safePrepare('<o-g> <r-am> <t1> 。')).toBe('<o-g> <r-am> <t1> 。')
  })

  it('converts simplified characters and phrases for the G2P', () => {
    if (!present) return
    const text = loadText()
    const s2t = text.parseS2T(
      readFileSync(path.join(textDir, 's2t/STPhrases.txt'), 'utf8'),
      readFileSync(path.join(textDir, 's2t/STCharacters.txt'), 'utf8'),
    )
    const cases: [string, string][] = [
      ['一只猫', '一隻貓'],
      ['这里', '這裏'],
      ['干净', '乾淨'],
      ['干部', '幹部'],
      ['几点', '幾點'],
      ['头发', '頭髮'],
      ['后来', '後來'],
      ['面条', '麪條'],
    ]
    for (const [from, to] of cases) expect(s2t.convert(from)).toBe(to)
  })

  it('groups words without ever splitting one, and keeps the first chunk short', () => {
    const text = loadText()
    const words = [
      { token: '今', jyutping: 'gam1', pieces: text.jyutpingToPieces('gam1') },
      { token: '日', jyutping: 'jat6', pieces: text.jyutpingToPieces('jat6') },
      { token: '，', jyutping: '，', pieces: text.jyutpingToPieces('，') },
      { token: '我', jyutping: 'ngo5', pieces: text.jyutpingToPieces('ngo5') },
    ]
    const groups = text.groupWords(words, { cap: 5, firstCap: 3 })
    expect(groups.map(g => g.words.map(w => w.token))).toEqual([['今'], ['日', '，'], ['我']])
    for (const g of groups) {
      for (const w of g.words) expect(g.pieces).toEqual(expect.arrayContaining(w.pieces))
    }
  })

  it('splits a reply into sentences at its punctuation', () => {
    expect(sentenceChunks('今日天氣幾好。我想出街行吓！你食咗飯未呀？')).toEqual([
      '今日天氣幾好。', '我想出街行吓！', '你食咗飯未呀？',
    ])
    expect(sentenceChunks('one. two? three')).toEqual(['one.', 'two?', 'three'])
  })
})
