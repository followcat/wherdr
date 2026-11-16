// Leak check: reading the patterns, exceptions, masking of the values found.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error JS module without declarations
import { globToRegExp, loadPatterns, parsePatterns, redact, scanText } from '../scripts/check-leaks.mjs'

describe('check-leaks', () => {
  it('finds a pattern with file, line and truncated value', () => {
    const p = parsePatterns('# commentaire\n\nsecret-host\n')
    const hits = scanText('app/a.ts', 'ok\nconst h = "Secret-Host.lan"\n', p)
    expect(hits).toEqual([{ file: 'app/a.ts', line: 2, pattern: 'secret-host', excerpt: 'Sec…(11 chars)' }])
  })

  it('honours per-pattern exceptions and ignored files', () => {
    const p = parsePatterns('alice !! LICENSE, docs/**\n! tests/fixtures/*.json\nbob\n')
    expect(scanText('LICENSE', 'Copyright alice', p)).toEqual([])
    expect(scanText('docs/a/b.md', 'alice', p)).toEqual([])
    expect(scanText('README.md', 'alice', p)).toHaveLength(1)
    expect(scanText('tests/fixtures/x.json', 'alice bob', p)).toEqual([])
    expect(scanText('scripts/leak-patterns.example', 'bob', p)).toEqual([])
  })

  it('counts each occurrence on a line', () => {
    expect(scanText('a', 'bob and BOB', parsePatterns('bob'))).toHaveLength(2)
  })

  it('returns null when the pattern file is missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'leaks-test-'))
    expect(loadPatterns(path.join(dir, '.leak-patterns'))).toBeNull()
    writeFileSync(path.join(dir, '.leak-patterns'), 'x+\n')
    expect(loadPatterns(path.join(dir, '.leak-patterns')).rules).toHaveLength(1)
  })

  it('reports an invalid regex with its line', () => {
    expect(() => parsePatterns('ok\n(broken')).toThrow('.leak-patterns:2')
  })

  it('never shows the whole value', () => {
    expect(redact('abc')).toBe('a…')
    expect(redact('ghp_0123456789abcdef')).toBe('ghp_…(20 chars)')
    expect(globToRegExp('*.md').test('docs/a.md')).toBe(false)
  })
})
