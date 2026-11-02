import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

// Exercise the actual worker without loading an engine or model weights.
const scope = vm.createContext({ self: {}, TextEncoder, TextDecoder, console, postMessage() {}, setTimeout })
vm.runInContext(readFileSync(new URL('../public/workers/asr-worker.js', import.meta.url), 'utf8'), scope)
const tokenizer = vm.runInContext('q4Tokenizer', scope)

// Synthetic byte-level BPE vocabulary. The split/normalizer contract comes
// from the model's tokenizer.json, not a language-specific word list.
const spec = {
  normalizer: { type: 'NFC' },
  pre_tokenizer: { type: 'Sequence', pretokenizers: [
    { type: 'Split', pattern: { Regex: "(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+" }, behavior: 'Isolated', invert: false },
    { type: 'ByteLevel', add_prefix_space: false, use_regex: false },
  ] },
  model: { type: 'BPE', vocab: { W: 0, E: 1, "'": 2, R: 3, "'R": 4, "'RE": 5, c: 6, a: 7, f: 8, 'Ã': 9, '©': 10, e: 11, 'Ì': 12, 'ģ': 13, '1': 14, '2': 15, '12': 16 }, merges: ["' R", "'R E", '1 2'] },
}

describe('ASR context tokenizer', () => {
  it('uses the model-defined case-insensitive splits', () => {
    expect([...tokenizer(spec).encode("WE'RE")]).toEqual([0, 1, 5])
  })
  it('applies the Unicode normalization declared by the model', () => {
    expect([...tokenizer(spec).encode('cafe\u0301')]).toEqual([...tokenizer(spec).encode('café')])
  })
  it('does not merge across model-defined digit boundaries', () => {
    expect([...tokenizer(spec).encode('12')]).toEqual([14, 15])
  })
})
