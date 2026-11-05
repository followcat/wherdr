// Command Code late tool outcomes on the client: immutable per-item updates
// matched by toolId, revision-checked by the result's absolute byte offset,
// and a bounded pending map for calls whose page is still in flight — pure
// helpers, no store or fetch.
import { describe, expect, it } from 'vitest'
import { applyToolUpdates, mergeToolUpdates, retainToolUpdates } from '../app/utils/chatTail'
import type { ChatItem, CommandCodeToolUpdate } from '../shared/types'

const item = (text: string, role: ChatItem['role'] = 'assistant'): ChatItem => ({ role, text, ts: '2026-01-01T00:00:00Z' })
const call = (id: string, extra: Partial<ChatItem> = {}): ChatItem =>
  ({ role: 'tool', text: 'read file', ts: '2026-01-01T00:00:00Z', toolId: id, ...extra })
const up = (id: string, at: number | undefined, fields: Partial<CommandCodeToolUpdate> = {}): CommandCodeToolUpdate =>
  ({ id, at, out: 'res', error: false, images: 0, ref: '', imageAt: 0, ...fields })

describe('chatTail tool updates', () => {
  it('applies outcomes to matching toolIds in tail and older lists — immutably', () => {
    const a = call('t1'), b = item('hello', 'user'), c = call('t2')
    const tail = [b, c]
    const older = [a]
    const updates = [up('t1', 100, { out: 'found it' }), up('t2', 50, { out: 'other' })]
    const tail2 = applyToolUpdates(tail, updates)
    const older2 = applyToolUpdates(older, updates)
    expect(older2).not.toBe(older)
    expect(older2[0]).toMatchObject({ out: 'found it', toolAt: 100 })
    expect(tail2.find(i => i.toolId === 't2')).toMatchObject({ out: 'other', toolAt: 50 })
    expect(tail2[0]).toBe(b) // an item with nothing to apply keeps its identity
    // Nothing matched: the same array and the same items come back.
    expect(applyToolUpdates(tail, [up('zzz', 1)])).toBe(tail)
    expect(applyToolUpdates(tail, undefined)).toBe(tail)
    expect(applyToolUpdates([], updates)).toEqual([])
  })

  it('an applied outcome replaces and clears out/error/images/ref/imageAt/hashes — empty values clear', () => {
    const c = call('t1', { out: 'boom', error: true, images: 1, ref: '10:20', imageAt: 0, hashes: ['h1'], toolAt: 10 })
    const n = applyToolUpdates([c], [up('t1', 20, { out: '', error: false, images: 0 })])[0]!
    expect(n).not.toBe(c)
    expect(n).toMatchObject({ toolAt: 20 })
    expect(n.out).toBeUndefined()
    expect(n.error).toBeUndefined()
    expect(n.images).toBeUndefined()
    expect(n.ref).toBeUndefined()
    expect(n.imageAt).toBeUndefined()
    expect(n.hashes).toBeUndefined()
    // A non-empty outcome sets its fields — old hashes never survive.
    const img = applyToolUpdates([c], [up('t1', 30, { out: 'shot', images: 1, ref: '30:40', imageAt: 1 })])[0]!
    expect(img).toMatchObject({ out: 'shot', images: 1, ref: '30:40', imageAt: 1, toolAt: 30 })
    expect(img.hashes).toBeUndefined()
    expect(img.error).toBeUndefined()
  })

  it('rejects older or unknown revisions over a known toolAt; equal revisions apply', () => {
    const c = call('t1', { out: 'new', toolAt: 100 })
    expect(applyToolUpdates([c], [up('t1', 50, { out: 'old' })])[0]).toBe(c)
    expect(applyToolUpdates([c], [up('t1', undefined, { out: 'mystery' })])[0]).toBe(c)
    expect(applyToolUpdates([c], [up('t1', -3, { out: 'negative' })])[0]).toBe(c)
    const equal = applyToolUpdates([c], [up('t1', 100, { out: 'same byte, edited' })])[0]!
    expect(equal).toMatchObject({ out: 'same byte, edited', toolAt: 100 })
    const newer = applyToolUpdates([c], [up('t1', 120, { out: 'newest' })])[0]!
    expect(newer).toMatchObject({ out: 'newest', toolAt: 120 })
    // An unknown revision over an unknown value applies, but stamps nothing.
    const u = applyToolUpdates([call('t2')], [up('t2', undefined, { out: 'first' })])[0]!
    expect(u.out).toBe('first')
    expect(u.toolAt).toBeUndefined()
  })

  it('a repeated equal outcome returns the same item and the same array; only real changes clone', () => {
    const applied = call('t1', { out: 'res', toolAt: 100 })
    const other = call('t2', { out: 'old', toolAt: 50 })
    const unrelated = item('keep')
    const list = [applied, other, unrelated]
    // Every update already shown: the same array, the same items.
    expect(applyToolUpdates(list, [up('t1', 100, { out: 'res' }), up('t2', 50, { out: 'old' })])).toBe(list)
    // One changed, one repeated, one unrelated: the array is new, only the
    // changed item is cloned.
    const next = applyToolUpdates(list, [up('t1', 100, { out: 'res' }), up('t2', 50, { out: 'edited same byte' })])
    expect(next).not.toBe(list)
    expect(next[0]).toBe(applied)
    expect(next[1]).not.toBe(other)
    expect(next[1]).toMatchObject({ out: 'edited same byte', toolAt: 50 })
    expect(next[2]).toBe(unrelated)
    // An identical outcome on an item holding hashes is NOT identical:
    // hashes must still clear.
    const withHash = call('t3', { out: 'res', toolAt: 100, hashes: ['h1'] })
    const cleared = applyToolUpdates([withHash], [up('t3', 100, { out: 'res' })])[0]!
    expect(cleared).not.toBe(withHash)
    expect(cleared.hashes).toBeUndefined()
    // An all-clear outcome repeated on a bare call is identical too.
    const bare = call('t4', { toolAt: 100 })
    expect(applyToolUpdates([bare], [up('t4', 100, { out: '' })])[0]).toBe(bare)
  })

  it.each([NaN, Infinity, -Infinity, 0.5, -1, Number.MAX_SAFE_INTEGER + 1, undefined])(
    'rejects an invalid revision %s over a known toolAt', (at) => {
      const c = call('t1', { out: 'new', toolAt: 100 })
      expect(applyToolUpdates([c], [up('t1', at, { out: 'intruder' })])[0]).toBe(c)
    })

  it('accepts 0 as a valid revision — the first byte is a real position', () => {
    const c = call('t1', { out: 'old' })
    expect(applyToolUpdates([c], [up('t1', 0, { out: 'fresh' })])[0]).toMatchObject({ out: 'fresh', toolAt: 0 })
  })

  it('within one update set the newest revision wins; equal and unknown keep order', () => {
    const c = call('t1')
    const next = applyToolUpdates([c], [up('t1', 50, { out: 'first' }), up('t1', 90, { out: 'newest' }), up('t1', 70, { out: 'older' })])
    expect(next[0]).toMatchObject({ out: 'newest', toolAt: 90 })
    expect(applyToolUpdates([c], [up('t1', 90, { out: 'a' }), up('t1', 90, { out: 'b' })])[0]).toMatchObject({ out: 'b' })
    expect(applyToolUpdates([c], [up('t1', undefined, { out: 'x' }), up('t1', 42, { out: 'known' })])[0]).toMatchObject({ out: 'known', toolAt: 42 })
    expect(applyToolUpdates([c], [up('t1', 42, { out: 'known' }), up('t1', undefined, { out: 'x' })])[0]).toMatchObject({ out: 'known', toolAt: 42 })
  })

  it('merges pending with incoming once — a late call gets the remembered outcome, not the older response', () => {
    const pending = new Map<string, CommandCodeToolUpdate>([['t1', up('t1', 200, { out: 'newest' })]])
    // An older incoming response carries t1 @50 and unrelated t9.
    const merged = mergeToolUpdates(pending, [up('t1', 50, { out: 'stale' }), up('t9', 30, { out: 'other' })])
    expect(merged.find(u => u.id === 't1')).toMatchObject({ at: 200, out: 'newest' })
    expect(merged.find(u => u.id === 't9')).toMatchObject({ at: 30 })
    // The call page arriving now receives the remembered outcome.
    const applied = applyToolUpdates([call('t1'), item('older')], merged)
    expect(applied[0]).toMatchObject({ out: 'newest', toolAt: 200 })
    // After applying to every retained list: t1 is satisfied at its own
    // revision, t9's call is not visible — it stays pending, contents kept.
    retainToolUpdates(pending, [applied, [item('another page')]], merged)
    expect(pending.has('t1')).toBe(false)
    expect(pending.get('t9')).toMatchObject({ at: 30, out: 'other' })
  })

  it('a visible tool at a newer toolAt satisfies an older pending; a stale response cannot downgrade it', () => {
    const pending = new Map<string, CommandCodeToolUpdate>([['t1', up('t1', 200, { out: 'newest' })]])
    const merged = mergeToolUpdates(pending, [up('t1', 50, { out: 'stale' })])
    expect(merged[0]).toMatchObject({ at: 200, out: 'newest' })
    // The call arrived already carrying a newer outcome: pending is done.
    retainToolUpdates(pending, [[call('t1', { out: 'later result', toolAt: 250 })]], merged)
    expect(pending.has('t1')).toBe(false)
    // Its call nowhere visible yet (an older page still in flight): the
    // pending survives untouched — no list alone can retire it.
    const flying = new Map<string, CommandCodeToolUpdate>([['t1', up('t1', 200, { out: 'newest' })]])
    retainToolUpdates(flying, [[item('scrolling')], []], merged)
    expect(flying.get('t1')).toMatchObject({ at: 200, out: 'newest' })
  })

  it('keeps the newest known revision per pending id — unknown and older arrivals never downgrade it', () => {
    const pending = new Map<string, CommandCodeToolUpdate>([['t1', up('t1', 200, { out: 'newest' })]])
    retainToolUpdates(pending, [[]], [up('t1', 50, { out: 'stale' })])
    expect(pending.get('t1')).toMatchObject({ at: 200, out: 'newest' })
    retainToolUpdates(pending, [[]], [up('t1', undefined, { out: 'unknown' })])
    expect(pending.get('t1')).toMatchObject({ at: 200, out: 'newest' })
    retainToolUpdates(pending, [[]], [up('t1', 300, { out: 'latest' })])
    expect(pending.get('t1')).toMatchObject({ at: 300, out: 'latest' })
  })

  it('bounds pending outcomes at 256 ids, evicting the oldest first', () => {
    const pending = new Map<string, CommandCodeToolUpdate>()
    retainToolUpdates(pending, [[]], Array.from({ length: 300 }, (_, i) => up(`t${i}`, i)))
    expect(pending.size).toBe(256)
    expect(pending.has('t0')).toBe(false)
    expect(pending.has('t43')).toBe(false)
    expect(pending.get('t44')).toMatchObject({ at: 44 })
    expect(pending.get('t299')).toMatchObject({ at: 299 })
  })
})
