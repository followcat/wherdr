// Bounded raw watch fingerprints and the newest-span validation selection —
// pure helpers over neutral buffers, no filesystem or processes.
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { verifyWatches, watchFingerprint, watchSpan, type CommandCodeWatch } from '../server/utils/commandCodeWatch'

const WATCH_BYTES = 64 * 1024
const WATCH_SPAN = 4 * 1024 * 1024
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 16)
const fp = (body: Buffer, at = 0, len = body.length - at) => watchFingerprint(body.subarray(at, at + len), at, len)!
const w = (at: number, len = 100, hash = 'h'): CommandCodeWatch => ({ at, len, hash })

describe('commandCodeWatch', () => {
  it('hashes the exact byte prefix — multi-byte chars split safely at the boundary', () => {
    // '€' is three UTF-8 bytes: the 64 KiB sample cuts it mid-sequence.
    const raw = Buffer.from('x'.repeat(WATCH_BYTES - 1) + '€' + 'y'.repeat(100), 'utf8')
    const w = watchFingerprint(raw, 10, raw.length)!
    expect(w).toMatchObject({ at: 10, len: raw.length, hash: digest(raw.subarray(0, WATCH_BYTES)) })
    // The builder takes bytes: no string round-trip of a multi-MiB line.
    const spy = vi.spyOn(Buffer, 'from')
    try {
      watchFingerprint(raw, 10, raw.length)
      expect(spy).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })

  it('hashes exactly the record sample — trailing buffer bytes never leak in', () => {
    // A buffer longer than the record: bytes after `len` must not alter it.
    const rec = Buffer.alloc(100, 0x61)
    const wider = Buffer.concat([rec, Buffer.from('other bytes')])
    expect(watchFingerprint(wider, 0, 100)!.hash).toBe(digest(rec))
    // A bounded prefix of a giant logical line is enough: len 5 MiB,
    // raw exactly the 64 KiB sample.
    const prefix = Buffer.alloc(WATCH_BYTES, 0x62)
    const w = watchFingerprint(prefix, 0, 5 * 1024 * 1024)!
    expect(w).toMatchObject({ at: 0, len: 5 * 1024 * 1024, hash: digest(prefix) })
    // A shorter raw than the sample claims can't prove anything.
    expect(watchFingerprint(Buffer.from('x'), 0, WATCH_BYTES)).toBeNull()
    expect(watchFingerprint(prefix.subarray(0, WATCH_BYTES - 1), 0, 5 * 1024 * 1024)).toBeNull()
  })

  it('rejects positions whose sample end would leave the number line', () => {
    const raw = Buffer.from('x')
    expect(watchFingerprint(raw, -1, 5)).toBeNull()
    expect(watchFingerprint(raw, 0, -1)).toBeNull()
    expect(watchFingerprint(raw, 0, 1.5)).toBeNull()
    expect(watchFingerprint(raw, 1.5, 5)).toBeNull()
    // at + sample would overflow: a bogus watch, never a valid one.
    expect(watchFingerprint(raw, Number.MAX_SAFE_INTEGER - 5, 20)).toBeNull()
    expect(watchFingerprint(raw, Number.MAX_SAFE_INTEGER, 1)).toBeNull()
    // Near-MAX positions stay valid when the sample is really supplied.
    expect(watchFingerprint(Buffer.alloc(WATCH_BYTES), Number.MAX_SAFE_INTEGER - WATCH_BYTES, WATCH_BYTES)).not.toBeNull()
  })

  it('collapses identical fingerprints and selects the newest span', () => {
    expect(watchSpan([])).toBeNull()
    expect(watchSpan([w(0)])).toEqual({ start: 0, end: 100, selected: [w(0)] })
    const dup = watchSpan([w(10, 20, 'x'), w(10, 20, 'x'), w(30, 10, 'y')])!
    expect(dup.selected).toEqual([w(10, 20, 'x'), w(30, 10, 'y')])
    // Over the cap: only the records fitting the newest span are read.
    const span = watchSpan([w(0), w(3_000_000), w(7_000_000)])!
    expect(span.selected.map(s => s.at)).toEqual([3_000_000, 7_000_000])
    expect(span.start).toBe(3_000_000)
    expect(span.end).toBe(7_000_100)
    expect(span.end - span.start).toBeLessThanOrEqual(WATCH_SPAN)
    // A record's own sample can exceed the cap: it is still the span's size.
    const giant = watchSpan([w(0, WATCH_SPAN * 2)])!
    expect(giant.end - giant.start).toBe(WATCH_BYTES)
  })

  it('skips watches whose bounds cannot be verified', () => {
    const overflow = { at: Number.MAX_SAFE_INTEGER - 5, len: 20, hash: 'x' }
    const ok = w(100, 50, 'y')
    expect(watchSpan([overflow, ok])!.selected).toEqual([ok])
    expect(watchSpan([overflow])).toBeNull()
    expect(watchSpan([{ at: -1, len: 0, hash: 'x' }, { at: NaN, len: 1, hash: 'y' }])).toBeNull()
  })

  it('verifies sampled prefixes — match, mismatch, short buffer', () => {
    const body = Buffer.alloc(300, 0x61)
    const w1 = fp(body, 0, 100), w2 = fp(body, 100, 200)
    expect(verifyWatches(body, 0, [w1, w2])).toBe(true)
    const bad = Buffer.from(body)
    bad[150] = 0x62
    expect(verifyWatches(bad, 0, [w1, w2])).toBe(false)
    // Short buffer: unknown, not a rewrite.
    expect(verifyWatches(body.subarray(0, 150), 0, [w1, w2])).toBeNull()
    // A watch outside the span start can't be verified either.
    expect(verifyWatches(body, 50, [w1])).toBeNull()
    // A len-0 record samples nothing.
    expect(verifyWatches(body, 0, [{ at: 50, len: 0, hash: digest(Buffer.alloc(0)) }])).toBe(true)
  })

  it('samples only the prefix of a record longer than the budget', () => {
    const rec = Buffer.alloc(5 * 1024 * 1024, 0x61)
    const span = watchSpan([fp(rec, 0, rec.length)])!
    expect(span.end - span.start).toBe(WATCH_BYTES)
    expect(verifyWatches(rec.subarray(0, WATCH_BYTES), 0, span.selected)).toBe(true)
    // A change beyond the sampled prefix is outside the fingerprint.
    const tail = Buffer.from(rec)
    tail[rec.length - 1] = 0x62
    expect(verifyWatches(tail.subarray(0, WATCH_BYTES), 0, span.selected)).toBe(true)
    // A change inside it is caught.
    const head = Buffer.from(rec)
    head[WATCH_BYTES - 1] = 0x62
    expect(verifyWatches(head.subarray(0, WATCH_BYTES), 0, span.selected)).toBe(false)
  })
})
