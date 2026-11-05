// The incremental Command Code parser: complete lines are fed once each,
// late results update already-served calls immutably, and chronology rides
// on absolute result byte offsets — never on feed or parse order.
import { describe, expect, it, vi } from 'vitest'
import { commandCodeParser, type CommandCodeResult, type Lines } from '../server/utils/transcripts'
import { itemSigs } from '../server/utils/chatDelta'
import { assistant, results, user } from './cmdParserFixture'

// Complete lines with their absolute "start:length" refs, as the reader's
// storeLines computes them.
const L = (base: number, ...raw: unknown[]): Lines => {
  const lines = raw.map(l => (typeof l === 'string' ? l : JSON.stringify(l))) as Lines
  lines.refs = []
  let off = base
  for (const l of lines) {
    const n = Buffer.byteLength(l)
    lines.refs.push(`${off}:${n}`)
    off += n + 1
  }
  return lines
}
const CALL = (id: string) => ({ type: 'tool_use', id, name: 'shell_command', input: { command: 'npm test' } })

describe('commandCodeParser fed incrementally', () => {
  it('applies a later result to its call without touching served objects', () => {
    const p = commandCodeParser()
    p.feed(L(0, user('u1', 'Fix the flaky spec', 10), assistant('a1', [CALL('t1')], 20)))
    const first = p.result()
    const [user1, tool1] = first
    expect(tool1).toMatchObject({ role: 'tool', toolId: 't1' })
    expect(tool1!.out).toBeUndefined()

    p.feed(L(500, results('u2', [{ tool_use_id: 't1', content: '2 tests failed' }], 30)))
    const second = p.result()
    expect(second[0]).toBe(user1) // unchanged item, same object (signed once)
    expect(second[1]).not.toBe(tool1) // replaced by a fresh object, never mutated
    expect(second[1]).toMatchObject({ role: 'tool', toolId: 't1', out: '2 tests failed', toolAt: 500 })
    expect(tool1!.out).toBeUndefined() // the copy already served is intact
    expect(itemSigs([tool1!])[0]).not.toBe(itemSigs([second[1]!])[0])
  })

  it('clears a prior error and images on a newer empty success', () => {
    const p = commandCodeParser()
    p.feed(L(0, assistant('a1', [CALL('t1')], 10),
      results('u2', [{ tool_use_id: 't1', content: [{ type: 'text', text: 'nope' }, { type: 'image', data: 'aGk=' }], is_error: true }], 20)))
    const err = p.result()[0]
    expect(err).toMatchObject({ error: true, images: 1 })
    p.feed(L(800, results('u3', [{ tool_use_id: 't1', content: '' }], 30)))
    const cleared = p.result()[0]
    expect(cleared).toMatchObject({ role: 'tool', toolId: 't1', toolAt: 800 })
    expect(cleared!.out).toBeUndefined()
    expect(cleared!.error).toBeUndefined()
    expect(cleared!.images).toBeUndefined()
  })

  it('emits an unmatched result once, with its absolute revision', () => {
    const p = commandCodeParser(new Map())
    p.feed(L(400, results('u1', [{ tool_use_id: 't-x', content: 'ran ok' }], 10)))
    expect(p.result().updates).toEqual([{ id: 't-x', out: 'ran ok', error: false, images: 0, ref: '', imageAt: 0, at: 400 }])
    // The same record again (a re-feed) is the same revision: nothing new.
    p.feed(L(400, results('u1', [{ tool_use_id: 't-x', content: 'ran ok' }], 10)))
    expect(p.result().updates).toBeUndefined()
  })

  it('deduplicates updates within a feed, keeping the newest revision', () => {
    const p = commandCodeParser(new Map())
    p.feed(L(100, results('u1', [{ tool_use_id: 't-x', content: 'first' }], 10),
      results('u2', [{ tool_use_id: 't-x', content: 'second' }], 20)))
    const us = p.result().updates
    expect(us!.length).toBe(1)
    expect(us![0]).toMatchObject({ id: 't-x', out: 'second', at: expect.any(Number) })
    expect(us![0]!.at).toBeGreaterThan(100)
  })

  it('never lets an older page outcome replace a newer saved revision', () => {
    const map = new Map<string, CommandCodeResult>()
    const newer = commandCodeParser(map)
    // Newer page first: the result lives after the call's page.
    newer.feed(L(5000, results('u9', [{ tool_use_id: 't1', content: 'newest out' }], 90)))
    expect(newer.result().updates).toEqual([{ id: 't1', out: 'newest out', error: false, images: 0, ref: '', imageAt: 0, at: 5000 }])

    const older = commandCodeParser(map)
    // Older page second: its call inherits the newer saved outcome; its own
    // older result then cannot downgrade what the item shows.
    older.feed(L(1000, assistant('a1', [CALL('t1')], 10),
      results('u2', [{ tool_use_id: 't1', content: 'older out' }], 20)))
    const t = older.result()[0]
    expect(t).toMatchObject({ role: 'tool', toolId: 't1', out: 'newest out', toolAt: 5000 })
    expect(map.get('t1')).toMatchObject({ out: 'newest out', at: 5000 }) // still the newer revision
    expect(older.result().updates).toBeUndefined() // no stale outcome reported
  })

  it('keeps a call indexed while its item is in the bottom, past the orphan cap', () => {
    const map = new Map<string, CommandCodeResult>()
    const p = commandCodeParser(map)
    p.feed(L(0, assistant('a1', [CALL('t-live')], 10)))
    p.result()
    // Fill the bounded orphan map beyond its cap with other results.
    p.feed(L(1000, ...Array.from({ length: 4100 }, (_, i) => results(`f${i}`, [{ tool_use_id: `o${i}`, content: 'x' }], i))))
    p.result()
    // The live call is still matched: its late result updates the item,
    // no update emitted — the cap never evicted its lookup.
    p.feed(L(90000, results('u9', [{ tool_use_id: 't-live', content: 'late out' }], 50)))
    const r = p.result()
    expect(r[0]).toMatchObject({ role: 'tool', toolId: 't-live', out: 'late out' })
    expect((r.updates || []).filter(u => u.id === 't-live')).toEqual([])
  })

  it('drops a call lookup with its item when the bottom slides', () => {
    const p = commandCodeParser(new Map())
    p.feed(L(0, assistant('a1', [CALL('t1')], 10)))
    p.result()
    p.drop(1) // the tool item left the returned bottom
    p.feed(L(500, results('u2', [{ tool_use_id: 't1', content: 'late' }], 20)))
    expect(p.result().updates).toEqual([{ id: 't1', out: 'late', error: false, images: 0, ref: '', imageAt: 0, at: 500 }])
  })

  it('lets the shared map learn a matched outcome and apply the newest known', () => {
    const map = new Map<string, CommandCodeResult>()
    const p = commandCodeParser(map)
    // Matched in p: the shared map must still learn it for other parsers.
    p.feed(L(0, assistant('a1', [CALL('t1')], 10)))
    p.feed(L(5000, results('u2', [{ tool_use_id: 't1', content: 'newest out' }], 20)))
    p.result()
    const q = commandCodeParser(map)
    q.feed(L(1000, assistant('a2', [CALL('t1')], 5)))
    q.feed(L(1000, results('u3', [{ tool_use_id: 't1', content: 'older out' }], 8)))
    expect(q.result()[0]).toMatchObject({ role: 'tool', toolId: 't1', out: 'newest out', toolAt: 5000 })
    expect(map.get('t1')).toMatchObject({ out: 'newest out', at: 5000 })
  })

  it('shows the newer shared outcome when a served call gets an older result', () => {
    const map = new Map<string, CommandCodeResult>()
    const p = commandCodeParser(map)
    p.feed(L(0, assistant('a1', [CALL('t1')], 10)))
    p.result()
    // Another parser stores a newer outcome for the same call.
    commandCodeParser(map).feed(L(5000, results('u9', [{ tool_use_id: 't1', content: 'newest out' }], 90)))
    p.feed(L(1000, results('u2', [{ tool_use_id: 't1', content: 'older out' }], 20)))
    expect(p.result()[0]).toMatchObject({ out: 'newest out', toolAt: 5000 })
  })

  it('emits a changed outcome at the same offset but not an identical repeat', () => {
    const p = commandCodeParser(new Map())
    p.feed(L(400, results('u1', [{ tool_use_id: 't-x', content: 'first' }], 10)))
    expect(p.result().updates).toMatchObject([{ out: 'first', at: 400 }])
    // Same position, different outcome: a rewritten record, not a repeat.
    p.feed(L(400, results('u1', [{ tool_use_id: 't-x', content: 'CHANGED' }], 10)))
    expect(p.result().updates).toMatchObject([{ out: 'CHANGED', at: 400 }])
    p.feed(L(400, results('u1', [{ tool_use_id: 't-x', content: 'CHANGED' }], 10)))
    expect(p.result().updates).toBeUndefined()
  })

  it('bounds emitted revisions, forgetting the oldest — not a shown outcome', () => {
    const map = new Map<string, CommandCodeResult>()
    const p = commandCodeParser(map)
    p.feed(L(0, assistant('a1', [CALL('t1')], 10)))
    p.feed(L(5000, results('u0', [{ tool_use_id: 't1', content: 'kept' }], 20)))
    p.result()
    const many = Array.from({ length: 4100 }, (_, i) => results(`f${i}`, [{ tool_use_id: `o${i}`, content: 'x' }], i))
    p.feed(L(0, ...many))
    p.result()
    // 4101 outcomes over a 4096 cap evicted t1's shared entry — but the
    // call still shows it, so an older record must not downgrade shared.
    p.feed(L(1000, results('u1', [{ tool_use_id: 't1', content: 'older' }], 8)))
    expect(p.result()[0]).toMatchObject({ out: 'kept', toolAt: 5000 })
    const q = commandCodeParser(map)
    q.feed(L(2000, assistant('a2', [CALL('t1')], 5)))
    expect(q.result()[0]).toMatchObject({ out: 'kept', toolAt: 5000 })
    // A genuinely newer result still replaces it.
    q.feed(L(9000, results('u2', [{ tool_use_id: 't1', content: 'newest' }], 9)))
    expect(q.result()[0]).toMatchObject({ out: 'newest', toolAt: 9000 })
    // Identical re-feed re-emits only the evicted revisions.
    p.feed(L(0, ...many))
    expect(p.result().updates!.length).toBe(4)
  })

  it('treats malformed refs as unknown revisions, never a bogus offset', () => {
    const p = commandCodeParser(new Map())
    const bads = ['NaN:5', '1e3:5', '99999999999999999999:5', '5:99999999999999999999', ':5', '5']
    for (const bad of bads) {
      const lines = L(0, results('u1', [{ tool_use_id: `t-${bad}`, content: 'x' }], 10))
      lines.refs![0] = bad
      p.feed(lines)
    }
    const us = p.result().updates!
    expect(us.length).toBe(bads.length)
    expect(us.every(u => u.at === undefined)).toBe(true)
    // An unknown revision never poisons chronology: the next real offset wins.
    p.feed(L(900, results('u2', [{ tool_use_id: 't-NaN:5', content: 'fixed' }], 20)))
    expect(p.result().updates).toMatchObject([{ id: 't-NaN:5', out: 'fixed', at: 900 }])
  })

  it('parses only the lines fed, never the old list again', () => {
    const spy = vi.spyOn(JSON, 'parse')
    try {
      const p = commandCodeParser()
      p.feed(L(0, 'not json', user('u1', 'hi', 10), assistant('a1', 'plain', 20)))
      const first = spy.mock.calls.length
      p.feed(L(300, user('u2', 'more', 30)))
      const second = spy.mock.calls.length - first
      for (let i = 0; i < 5; i++) p.feed(L(400 + i * 100, user(`v${i}`, `msg ${i}`, 40 + i)))
      const rest = spy.mock.calls.length - first - second
      expect(first).toBe(3) // every fed line, once
      expect(second).toBe(1)
      expect(rest).toBe(5) // five appends cost five parses, not the whole file
    } finally {
      spy.mockRestore()
    }
  })
})
