// app/utils/speech/voices.json: the read-aloud voices the server fetches into
// DATA_DIR/models (scripts/dictation-files.mjs) and serves at /models/**.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CATALOG, SETS } from '../scripts/dictation-files.mjs'
import VOICES from '../app/utils/speech/voices.json'
import { createServerFiles } from '../server/utils/dictationServerFiles'

const sha256 = /^[0-9a-f]{64}$/
const voice = (id: string) => VOICES.voices.find(v => v.id === id)!

describe('the voice catalog', () => {
  it('has the chosen voices: Siwis for French, Cori for English, MLS as the French fallback, Canto for Cantonese', () => {
    expect(VOICES.voices.map(v => v.id)).toEqual(['siwis-medium', 'cori-medium', 'mls-medium', 'canto-nano-int8', 'canto-nano-fp16-gpu'])
    const defaults = VOICES.voices.filter(v => 'default' in v && v.default).map(v => [v.lang, v.id])
    expect(defaults).toEqual([['fr', 'siwis-medium'], ['en', 'cori-medium'], ['yue', 'canto-nano-int8']])
  })

  it('gives each voice its model, tokens and espeak-ng data trimmed to French and English', () => {
    for (const v of VOICES.voices) {
      if ((v as { kind?: string }).kind === 'cantoNano') {
        const paths = v.members.map(m => m.path)
        expect(paths).toContain('MOSS-TTS-Nano-cantophon-ONNX/moss_tts_prefill.onnx')
        expect(paths).toContain('MOSS-Audio-Tokenizer-Nano-ONNX/moss_audio_tokenizer_decode_full.onnx')
        expect(paths).toContain('g2p/data/word.bin')
        expect(paths).toContain('s2t/STPhrases.txt')
        for (const m of v.members) {
          expect(path.posix.normalize(m.path)).toBe(m.path)
          expect(m.path.startsWith('..') || path.isAbsolute(m.path)).toBe(false)
          expect(m.bytes).toBeGreaterThan(0)
        }
        continue
      }
      const paths = v.members.map(m => m.path)
      expect(paths.slice(0, 2)).toEqual([v.model, 'tokens.txt'])
      expect(paths.filter(p => p.endsWith('_dict')).sort()).toEqual(['espeak-ng-data/en_dict', 'espeak-ng-data/fr_dict'])
      for (const p of ['phontab', 'phonindex', 'phondata', 'intonations', 'lang/roa/fr', 'lang/gmw/en']) expect(paths).toContain(`espeak-ng-data/${p}`)
      for (const m of v.members) {
        expect(path.posix.normalize(m.path)).toBe(m.path)
        expect(m.path.startsWith('..') || path.isAbsolute(m.path)).toBe(false)
        expect(m.bytes).toBeGreaterThan(0)
      }
    }
  })

  it('pins every source: an archive by its sha256, loose files each by theirs', () => {
    for (const v of VOICES.voices) {
      if ('url' in v.source) {
        expect(v.source.url).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/tts-models\/.+\.tar\.bz2$/)
        expect(v.source.sha256).toMatch(sha256)
      } else {
        // A fixed revision, never a branch.
        expect(v.source.base).toMatch(/^https:\/\/.+\/resolve\/[0-9a-f]{40}\/$/)
        for (const m of v.members) expect('sha256' in m && m.sha256).toMatch(sha256)
        // Extra archives/single files (the G2P sdist, the OpenCC tables) are pinned too.
        const extras = (v.source as { extras?: { url: string, sha256: string }[] }).extras ?? []
        for (const e of extras) {
          expect(e.url).toMatch(/^https:\/\//)
          expect(e.sha256).toMatch(sha256)
        }
      }
    }
  })

  it('names the licence and the attribution to show', () => {
    for (const v of VOICES.voices) {
      expect(v.license.id).toBeTruthy()
      expect(v.license.url).toMatch(/^https:\/\//)
      expect(v.attribution.length).toBeGreaterThan(20)
    }
    expect(voice('siwis-medium').attribution).toMatch(/SIWIS.*CC BY 4\.0/)
  })

  it('keeps Siwis at about 64 MB on the server', () => {
    const bytes = voice('siwis-medium').members.reduce((n, m) => n + m.bytes, 0)
    expect(bytes).toBeGreaterThan(63e6)
    expect(bytes).toBeLessThan(65e6)
  })
})

describe('the voice sets', () => {
  it('fetches each voice into its own folder, with the TTS binding in the runtime', () => {
    expect(SETS['tts-siwis-medium']).toEqual([expect.objectContaining({ dir: voice('siwis-medium').dir, members: voice('siwis-medium').members.map(m => m.path) })])
    const mls = voice('mls-medium')
    expect(SETS['tts-mls-medium']!.map(e => e.to)).toEqual(mls.members.map(m => `${mls.dir}/${m.path}`))
    expect(SETS.runtime!.map(e => e.to)).toContain('runtime/sherpa-onnx-679ff70/sherpa-onnx-tts.js')
  })

  it('fetches the Canto model, its G2P data, the OpenCC tables and the ORT runtime into the voice folder', () => {
    const text = 'canto-text-2.6.1'
    for (const id of ['canto-nano-int8', 'canto-nano-fp16-gpu']) {
      const canto = voice(id)
      const set = SETS[id === 'canto-nano-int8' ? 'tts-canto-nano-int8' : 'tts-canto-nano-fp16']!
      const loose = canto.members.filter(m => !('from' in m)).map(m => `${canto.dir}/${m.path}`)
      expect(set.filter(e => e.to).map(e => e.to)).toEqual(expect.arrayContaining(loose))
      expect(set.some(e => e.dir === `${text}/g2p` && e.strip === 3)).toBe(true)
      expect(set.map(e => e.to)).toEqual(expect.arrayContaining([
        `${text}/s2t/STPhrases.txt`,
        `${text}/s2t/STCharacters.txt`,
        'runtime/onnxruntime-web-1.23.2/ort.webgpu.min.js',
      ]))
    }
  })

  it('adds the GPU voice as an explicit WebGPU choice sharing the G2P and OpenCC files', () => {
    const int8 = voice('canto-nano-int8') as unknown as {
      textDir: string, members: { path: string, dir?: string, from?: string, sha256?: string }[]
    }
    const gpu = voice('canto-nano-fp16-gpu') as unknown as {
      default?: boolean, dir: string, textDir: string, requires: string[], runner: { dtype: string, providers: string[], external: Record<string, string> },
      members: { path: string, dir?: string, from?: string, sha256?: string }[]
    }
    expect(gpu.default ?? false).toBe(false)
    expect(gpu.dir).toBe('canto-tts-nano-fp16-e89ed00')
    expect(gpu.requires).toEqual(['webgpu', 'shader-f16'])
    expect(gpu.runner.dtype).toBe('float16')
    expect(gpu.runner.providers).toEqual(['webgpu'])
    expect(gpu.runner.external).toMatchObject({ tts: 'moss_tts_global_shared.data', local: 'moss_tts_local_shared.data', codec: 'moss_audio_tokenizer_decode_shared.data' })
    expect(gpu.textDir).toBe('canto-text-2.6.1')
    const shared = (v: { members: { path: string, dir?: string, from?: string, sha256?: string }[] }) => v.members.filter(m => m.from).map(m => [m.path, m.dir, m.sha256])
    expect(shared(gpu)).toEqual(shared(int8))
  })

  it('lets the server prepare a voice by its id, distinct from the dictation models', async () => {
    const ids = [...CATALOG.models, ...VOICES.voices].map(m => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'hw-voices-'))
    try {
      const files = createServerFiles({ modelsDir: dir })
      expect(await files.prepare('siwis-medium', false)).toEqual({ state: 'missing' })
      expect(await files.prepare('canto-nano-int8', false)).toEqual({ state: 'missing' })
      expect(await files.prepare('canto-nano-fp16-gpu', false)).toEqual({ state: 'missing' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
