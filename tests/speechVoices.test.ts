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
  it('has the chosen voices: Siwis for French, Cori for English, MLS as the French fallback', () => {
    expect(VOICES.voices.map(v => v.id)).toEqual(['siwis-medium', 'cori-medium', 'mls-medium'])
    const defaults = VOICES.voices.filter(v => 'default' in v && v.default).map(v => [v.lang, v.id])
    expect(defaults).toEqual([['fr', 'siwis-medium'], ['en', 'cori-medium']])
  })

  it('gives each voice its model, tokens and espeak-ng data trimmed to French and English', () => {
    for (const v of VOICES.voices) {
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

  it('lets the server prepare a voice by its id, distinct from the dictation models', async () => {
    const ids = [...CATALOG.models, ...VOICES.voices].map(m => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'hw-voices-'))
    try {
      const files = createServerFiles({ modelsDir: dir })
      expect(await files.prepare('siwis-medium', false)).toEqual({ state: 'missing' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
