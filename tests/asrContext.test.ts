import { describe, expect, it } from 'vitest'
import { buildAsrContext } from '../app/utils/asrContext'

describe('buildAsrContext', () => {
  it('is empty without any input', () => {
    expect(buildAsrContext({ draft: '' })).toBe('')
  })
  it.each([
    '这里有一个新的名字，要保持原来的拼写。',
    '呢个编号同名称都保留原文。',
    'Réviser le numéro et le nom du projet.',
    'Keep the names, numbers 317 and punctuation as written.',
    '名前と番号はそのまま使ってください。',
  ])('keeps source text intact without a language-specific vocabulary: %s', draft => {
    expect(buildAsrContext({ draft })).toBe(draft)
  })
  it('includes recent source text in newest-first order', () => {
    const recent = ['Older topic', 'A previous message', 'Current topic: AlphaBeta 317']
    const ctx = buildAsrContext({ recent })
    expect(ctx).toContain(recent[2])
    expect(ctx.indexOf(recent[2]!)).toBeLessThan(ctx.indexOf(recent[1]!))
  })
  it('bounds history by recency instead of collecting unrelated old words', () => {
    const ctx = buildAsrContext({ recent: ['OutdatedSubject', 'First', 'Second', 'Latest'] })
    expect(ctx).not.toContain('OutdatedSubject')
    expect(ctx).toContain('Latest')
  })
  it('preserves identity and file spellings while omitting the private cwd prefix', () => {
    const ctx = buildAsrContext({ agent: 'agent-a', machine: 'Laptop', name: 'Équipe', cwd: '/home/user/projects/acme', files: ['data_model.ts'] })
    for (const s of ['agent-a', 'Laptop', 'Équipe', 'projects/acme', 'data_model.ts']) expect(ctx).toContain(s)
    expect(ctx).not.toContain('/home/user')
  })
  it('keeps room for history when the draft is long and does not cut Unicode pairs', () => {
    const ctx = buildAsrContext({ draft: '🙂'.repeat(500), recent: ['RecentTerm'], name: 'NamedProject' })
    expect(ctx.length).toBeLessThanOrEqual(400)
    expect(ctx).toContain('RecentTerm')
    expect(ctx).toContain('NamedProject')
    expect(ctx.isWellFormed()).toBe(true)
  })
  it('deduplicates identical source paragraphs without inventing vocabulary', () => {
    expect(buildAsrContext({ draft: 'Same paragraph', recent: ['Same paragraph'] })).toBe('Same paragraph')
  })
})
