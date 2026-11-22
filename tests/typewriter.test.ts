// Typewriter effect (t-0021): splitting, speed, reveal of the final HTML,
// and choice of the replies to reveal (history vs new).
import { describe, expect, it } from 'vitest'
import {
  applyReveal, CATCHUP_MS, CIPHER_GAP, cipherSegments, effectiveTypingSpeed, encryptedTextActive, finishReveal, parseTypingSettings, planReveal, replyId, revealedAt,
  missedReply, sortNewReplies, trailGlyphs, typeDuration, typingFronts, wordStops, TRAIL_GLYPHS, TYPE_MAX_MS, TYPE_MIN_MS,
} from '../app/utils/typewriter'
import type { RevealNode } from '../app/utils/typewriter'

type Fake = RevealNode & { tag?: string, cls?: string, childNodes: Fake[] }
const txt = (v: string): Fake => ({ nodeType: 3, nodeValue: v, childNodes: [] })
const el = (tag: string, kids: Fake[], cls?: string): Fake => ({ nodeType: 1, nodeValue: null, tag, cls, hidden: false, childNodes: kids })
const text = (n: Fake): string => (n.nodeType === 3 ? n.nodeValue || '' : n.hidden ? '' : n.childNodes.map(text).join(''))

describe('splitting', () => {
  it('avance mot par mot, espaces compris', () => {
    expect(wordStops('Bonjour le monde')).toEqual([8, 11, 16])
    expect(wordStops('  a b')).toEqual([4, 5])
    expect(wordStops('')).toEqual([0])
  })
  it('cuts very long words into groups of 8 characters', () => {
    const s = '/home/user/code/app'
    const stops = wordStops(s)
    expect(stops[0]).toBe(8)
    expect(stops.at(-1)).toBe(s.length)
    for (let i = 1; i < stops.length; i++) expect(stops[i]! - stops[i - 1]!).toBeLessThanOrEqual(8)
  })
  it('reveals progressively until the end', () => {
    const stops = wordStops('un deux trois quatre')
    expect(revealedAt(stops, 0, 1000)).toBe(0)
    expect(revealedAt(stops, 500, 1000)).toBe(stops[1])
    expect(revealedAt(stops, 999, 1000)).toBe(stops[2])
    expect(revealedAt(stops, 1000, 1000)).toBe(20)
    const seq = [0, 100, 300, 600, 900].map(t => revealedAt(stops, t, 1000))
    expect([...seq].sort((a, b) => a - b)).toEqual(seq)
  })
})

describe('vitesse', () => {
  it('keeps the historical fast rate and multiplies the other durations', () => {
    expect(typeDuration(10)).toBe(TYPE_MIN_MS)
    expect(typeDuration(300)).toBeGreaterThanOrEqual(1000)
    expect(typeDuration(450)).toBeLessThanOrEqual(2000)
    expect(typeDuration(20000)).toBe(TYPE_MAX_MS)
    expect(typeDuration(200)).toBeLessThan(typeDuration(400))
    for (const chars of [10, 300, 20000]) {
      expect(typeDuration(chars, 'fast')).toBe(typeDuration(chars))
      expect(typeDuration(chars, 'medium')).toBe(typeDuration(chars) * 2)
      expect(typeDuration(chars, 'slow')).toBe(typeDuration(chars) * 3)
      expect(typeDuration(chars, 'off')).toBe(0)
    }
    expect(typeDuration(20000, 'medium')).toBe(4000)
    expect(typeDuration(20000, 'slow')).toBe(6000)
  })
})

describe('reveal of the final HTML', () => {
  // <p>Voici <b>du code</b> :</p> <div.code-block><div.code-head>…</div><pre><code>…</code></pre></div> <table>…</table>
  const build = () => {
    const head = el('div', [el('span', [txt('ts')]), el('button', [txt('Copier')])], 'code-head')
    const p = el('p', [txt('Voici '), el('b', [txt('du code')]), txt(' :')])
    const code = el('div', [head, el('pre', [el('code', [txt('const a = 1\nconst b = 2')])])], 'code-block')
    const cell = (s: string) => el('td', [txt(s)])
    const table = el('table', [el('tr', [cell('A'), cell('B')]), el('tr', [cell('C'), cell('D')])])
    const root = el('div', [p, txt('\n'), code, txt('\n'), table])
    const plan = planReveal(root, {
      atomic: n => (n as Fake).cls === 'code-head',
      keep: n => (n as Fake).tag === 'td',
    })
    return { root, p, code, head, table, plan }
  }

  it('counts neither layout whitespace nor the code block header', () => {
    const { plan } = build()
    expect(plan.total).toBe('Voici du code :'.length + 'const a = 1\nconst b = 2'.length + 4)
  })

  it('hides what has not started, without breaking the structure', () => {
    const { root, p, code, head, table, plan } = build()
    applyReveal(plan, 9)
    expect(text(p)).toBe('Voici du ')
    expect(code.hidden).toBe(true)
    expect(table.hidden).toBe(true)
    // The code block appears with its whole header as soon as its text starts.
    applyReveal(plan, 16)
    expect(code.hidden).toBe(false)
    expect(head.hidden).toBe(false)
    expect(text(head)).toBe('tsCopier')
    expect(text(code).endsWith('c')).toBe(true)
    // Table: the started row keeps its two cells (the second empty).
    applyReveal(plan, plan.total - 3)
    const [r1, r2] = table.childNodes
    expect(r1!.hidden).toBe(false)
    expect(r1!.childNodes.map(c => c.hidden)).toEqual([false, false])
    expect(r2!.hidden).toBe(true)
    applyReveal(plan, plan.total - 1)
    expect(r2!.hidden).toBe(false)
    expect(text(r2!.childNodes[1]!)).toBe('')
    finishReveal(plan)
    expect(text(root)).toBe('Voici du code :\ntsCopierconst a = 1\nconst b = 2\nABCD')
  })

  it('shows a text-less element as soon as what precedes it is written', () => {
    const hr = el('hr', [])
    const root = el('div', [el('p', [txt('ab')]), hr, el('p', [txt('cd')])])
    const plan = planReveal(root)
    applyReveal(plan, 1)
    expect(hr.hidden).toBe(true)
    applyReveal(plan, 2)
    expect(hr.hidden).toBe(false)
    expect(root.childNodes[2]!.hidden).toBe(true)
  })
})

describe('two cipher fronts', () => {
  const build = () => {
    const a = txt('Voici un ')
    const b = txt('lien')
    const p1 = el('p', [a, el('a', [b]), txt(' ok')])
    const p2 = el('p', [txt('Suite')])
    const root = el('div', [p1, txt('\n'), p2])
    return { root, p1, p2, a, b, plan: planReveal(root) }
  }

  it('the band crosses Markdown elements and does not go past the written front', () => {
    const { plan, a, b } = build()
    expect(cipherSegments(plan, 6, 12)).toEqual([{ node: a, text: 'un ' }, { node: b, text: 'lie' }])
    expect(cipherSegments(plan, 12, 12)).toEqual([])
  })

  it('writes cipher ahead of the deciphered text, according to the speed', () => {
    for (const speed of ['fast', 'medium', 'slow'] as const) {
      const total = 500
      const duration = typeDuration(total, speed)
      const halfway = typingFronts(total, duration / 2, speed)
      expect(halfway.written).toBe(250)
      expect(halfway.written - halfway.decrypted).toBe(CIPHER_GAP[speed])
      const atEnd = typingFronts(total, duration, speed)
      expect(atEnd).toEqual({ written: total, decrypted: total - CIPHER_GAP[speed], done: false })
      const catching = typingFronts(total, duration + CATCHUP_MS[speed] / 2, speed)
      expect(catching.decrypted).toBeGreaterThan(atEnd.decrypted)
      expect(catching.decrypted).toBeLessThan(total)
      expect(typingFronts(total, duration + CATCHUP_MS[speed], speed)).toEqual({ written: total, decrypted: total, done: true })
    }
    expect(typingFronts(12, typeDuration(12, 'slow') / 2, 'slow').decrypted).toBe(0)
    expect(typingFronts(0, 0, 'slow').done).toBe(true)
  })

  it('shows the elements reached by the writing and leaves the real text behind', () => {
    const { plan, p2 } = build()
    const start = 'Voici un lien ok'.length
    applyReveal(plan, start)
    expect(p2.hidden).toBe(true)
    applyReveal(plan, start - 2, true, start)
    expect(p2.hidden).toBe(false)
    expect(text(p2)).toBe('') // The glyphs are painted outside the text nodes.
    applyReveal(plan, start - 2, true, start - 2)
    expect(p2.hidden).toBe(true)
  })

  it('terminal set glyphs, whitespace kept, same length', () => {
    let i = 0
    const rand = () => (i++ % 7) / 7
    const g = trailGlyphs('a b\tc\nd', rand)
    expect(g).toHaveLength(7)
    expect([g[1], g[3], g[5]]).toEqual([' ', '\t', '\n'])
    for (const c of [g[0], g[2], g[4], g[6]]) expect(TRAIL_GLYPHS).toContain(c)
    expect(trailGlyphs('xyz', () => 0.999999).every(c => c === TRAIL_GLYPHS.at(-1))).toBe(true)
  })
  it('keeps the growing gaps and caps at the message length', () => {
    expect(CIPHER_GAP.fast).toBe(20)
    expect(CIPHER_GAP.medium).toBe(40)
    expect(CIPHER_GAP.slow).toBe(70)
    const fronts = typingFronts(10, typeDuration(10, 'slow'), 'slow')
    expect(fronts).toEqual({ written: 10, decrypted: 0, done: false })
  })
})

describe('typing settings', () => {
  it('gives Medium with cipher text on a new device', () => {
    expect(parseTypingSettings(null, null, null, null)).toEqual({ speed: 'medium', encrypted: true })
  })
  it('migrates the three old modes and the old switch', () => {
    expect(parseTypingSettings(null, null, 'off', null)).toEqual({ speed: 'off', encrypted: true })
    expect(parseTypingSettings(null, null, 'plain', null)).toEqual({ speed: 'fast', encrypted: false })
    expect(parseTypingSettings(null, null, 'terminal', null)).toEqual({ speed: 'fast', encrypted: true })
    expect(parseTypingSettings(null, null, null, '0')).toEqual({ speed: 'off', encrypted: true })
    expect(parseTypingSettings(null, null, null, '1')).toEqual({ speed: 'medium', encrypted: true })
  })
  it('prefers the new choices and turns off effects with reduced motion', () => {
    expect(parseTypingSettings('slow', '0', 'terminal', null)).toEqual({ speed: 'slow', encrypted: false })
    expect(effectiveTypingSpeed('slow', true)).toBe('off')
    expect(effectiveTypingSpeed('slow', false)).toBe('slow')
    expect(encryptedTextActive('off', true, false)).toBe(false)
    expect(encryptedTextActive('medium', false, false)).toBe(false)
    expect(encryptedTextActive('medium', true, true)).toBe(false)
    expect(encryptedTextActive('slow', true, false)).toBe(true)
  })
})

describe('historique vs nouveau', () => {
  const a = replyId({ ts: '2026-09-27T10:00:00Z', text: 'Première réponse' })
  const b = replyId({ ts: '2026-09-27T10:01:00Z', text: 'Deuxième réponse' })
  const c = replyId({ ts: '2026-09-27T10:02:00Z', text: 'Troisième réponse' })

  const sort = (known: Set<string>, ids: string[], following: boolean, baseline = true) => sortNewReplies(known, ids, { following, animate: true, baseline })
  it('first open on this device: nothing typed nor marked, everything becomes known', () => {
    const known = new Set<string>()
    expect(sort(known, [a, b], false, false)).toEqual({ typing: null, fresh: null })
    expect(known.has(a) && known.has(b)).toBe(true)
  })
  it('a reply already there at opening: shown at once under the New marker', () => {
    const known = new Set([a])
    expect(sort(known, [a, b, c], false)).toEqual({ typing: null, fresh: b })
    expect(sort(known, [a, b, c], true)).toEqual({ typing: null, fresh: null })
  })
  it('a reply arriving while open: typed in, no marker (none with the typewriter off)', () => {
    expect(sort(new Set([a]), [a, b, c], true)).toEqual({ typing: c, fresh: null })
    expect(sortNewReplies(new Set([a]), [a, b], { following: true, animate: false, baseline: true })).toEqual({ typing: null, fresh: null })
  })
  it('kept end read after the server: the first reply it lacks, written after it, is missed', () => {
    const user = { role: 'user', text: 'Go', ts: '2026-09-27T09:59:00Z' }
    const r = (ts: string, text: string) => ({ role: 'assistant', text, ts })
    const r1 = r('2026-09-27T10:00:00Z', 'Première réponse'), r2 = r('2026-09-27T10:01:00Z', 'Deuxième réponse')
    // No reply in common: left before the first one.
    expect(missedReply([user], [user, r1, r2])).toBe(replyId(r1))
    // The kept replies pushed out of the server's tail: only newer ones count.
    expect(missedReply([r('2026-09-27T09:00:00Z', 'Old'), user], [r1, r2])).toBe(replyId(r1))
    expect(missedReply([user, r1], [r('2026-09-27T09:30:00Z', 'Before'), r1, r2])).toBe(replyId(r2))
    expect(missedReply([user, r1, r2], [user, r1, r2])).toBeNull()
  })
  it('stable identity whatever the position in the list', () => {
    expect(replyId({ ts: '2026-09-27T10:00:00Z', text: 'Première réponse' })).toBe(a)
    expect(a).not.toBe(b)
  })
})
