// @vitest-environment happy-dom
// Budgets of the rendering caches (Markdown, question marks, reply targets):
// a corpus of large replies stays under the cap, and the versions of a reply
// still being written do not pile up.
import { describe, expect, it } from 'vitest'
import { MD_CACHE_CHARS, md, mdCacheStats, onMdDropped } from '../app/utils/markdown'
import { MARKED_CACHE_CHARS, TARGETS_CACHE_CHARS, forgetReply, replyCacheStats, replyTargets, withQuestions } from '../app/utils/questionReply'

// Nuxt auto-imports t() (app/utils/i18n.ts); English is the active language.
;(globalThis as { t?: (s: string) => string }).t = s => s

const labels = { reply: 'Reply', quoted: 'Quoted', discuss: 'Discuss', yes: 'Yes', no: 'No', okAll: 'OK to all', decisions: 'Decisions' }
const big = (i: number, chars: number) => `Reply ${i}\n\n` + `Line of plain prose number ${i}, long enough to weigh. `.repeat(Math.ceil(chars / 52))

describe('rendering caches', () => {
  it('stay under their budget in characters with a corpus of large replies', () => {
    onMdDropped(forgetReply)
    for (let i = 0; i < 120; i++) replyTargets(withQuestions(md(big(i, 50_000)), labels))
    const stats = { md: mdCacheStats(), ...replyCacheStats() }
    expect(stats.md.weight).toBeLessThanOrEqual(MD_CACHE_CHARS)
    expect(stats.marked.weight).toBeLessThanOrEqual(MARKED_CACHE_CHARS)
    expect(stats.targets.weight).toBeLessThanOrEqual(TARGETS_CACHE_CHARS)
    // The budget is used, not emptied: the last replies are still there.
    expect(stats.md.weight).toBeGreaterThan(MD_CACHE_CHARS / 2)
    expect(stats.md.entries).toBeLessThan(120)
  })
  it('renders the same HTML again after an eviction', () => {
    const text = big(1000, 2000) + '\n\nShall I go on?'
    const first = withQuestions(md(text), labels)
    for (let i = 0; i < 120; i++) md(big(2000 + i, 50_000))
    expect(withQuestions(md(text), labels)).toBe(first)
  })
  it('keeps one version of a reply being written, with what was derived from it', () => {
    const full = 'Streaming reply.\n\n' + Array.from({ length: 40 }, (_, i) => `Step ${i} is done. Shall I do step ${i + 1}?`).join('\n\n')
    const before = { md: mdCacheStats(), ...replyCacheStats() }
    for (let end = 40; end < full.length; end += 40) replyTargets(withQuestions(md(full.slice(0, end)), labels))
    const html = withQuestions(md(full), labels)
    expect(replyTargets(html).questions.length).toBe(40)
    const after = { md: mdCacheStats(), ...replyCacheStats() }
    expect(after.md.entries - before.md.entries).toBe(1)
    expect(after.marked.entries - before.marked.entries).toBe(1)
    expect(after.targets.entries - before.targets.entries).toBe(1)
  })
  it('renders again for other labels instead of serving the cached ones', () => {
    const html = '<p>The build is green.</p><p>Shall I push now?</p>'
    const en = withQuestions(html, labels)
    const fr = withQuestions(html, { ...labels, reply: 'Répondre' })
    expect(fr).not.toBe(en)
    expect(withQuestions(html, labels)).toBe(en)
  })
})
