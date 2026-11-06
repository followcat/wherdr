// File-scoped Command Code state: watch-validation observations — matched
// and orphan records proven by bytes, the bounded newest span, watch bounds,
// and the distinct-pending cap — driven by fake disks and gated promises,
// never a real home/proc/agent, no sleeps.
import { describe, expect, it } from 'vitest'
import { createCommandCodeState } from '../server/utils/commandCodeState'
import { watchFingerprint } from '../server/utils/commandCodeWatch'
import { defer, line, memFs, WATCH_BYTES, WATCH_SPAN, type MemFile, type MemIo } from './cmdStateFixture'

const FILE = '/home/user/.commandcode/projects/-w-proj/s1.jsonl'

describe('commandCodeState watches', () => {
  it('validates watched records on a growing file — matched or orphan', async () => {
    const rec1 = Buffer.from(line('u1', 'matched out'))
    const rec2 = Buffer.from(line('u2', 'orphan out'))
    const body = Buffer.concat([rec1, Buffer.from('\n'), rec2])
    const disk: Record<string, MemFile> = { [FILE]: { body, mtimeMs: 1, ino: 9 } }
    const reads: { start: number, len: number }[] = []
    const s = createCommandCodeState({ fs: memFs(disk, { reads }) })
    const first = await s.observe(FILE)
    const h = s.handle(FILE)
    // One watch per parsed result, matched or orphan (t1/t2 here).
    h.watch('t1', watchFingerprint(rec1, 0, rec1.length)!)
    h.watch('t2', watchFingerprint(rec2, rec1.length + 1, rec2.length)!)
    disk[FILE]!.body = Buffer.concat([body, Buffer.from('\n' + line('u3', 'three'))])
    const ok = await s.observe(FILE)
    expect(ok).toMatchObject({ invalidated: false, stamp: first.stamp })
    expect(reads).toEqual([{ start: 0, len: body.length }]) // one read covers both
    // Rewrite bytes inside the second record while GROWING past the last
    // trusted size: only the bounded watch read can catch this, never a
    // shrink/replacement check.
    const bad = Buffer.concat([disk[FILE]!.body, Buffer.from('\nxxxx')])
    bad[rec1.length + 5] = 0x21
    disk[FILE]!.body = bad
    expect(disk[FILE]!.body.length).toBeGreaterThan(ok.st!.size)
    const broken = await s.observe(FILE)
    expect(reads.length).toBe(2) // a second actual bounded validation read
    expect(reads[1]).toEqual({ start: 0, len: body.length })
    expect(broken.invalidated).toBe(true)
    expect(broken.stamp).not.toBe(ok.stamp)
    expect(s.handle(FILE).results.size).toBe(0)
  })

  it('reads only the newest watched span over the cap', async () => {
    const at1 = 0, at2 = 3_000_000, at3 = 7_000_000
    const body = Buffer.alloc(at3 + 200, 0x61)
    const rec = (at: number, len: number) => { body.fill(0x62, at, at + len); return watchFingerprint(body.subarray(at, at + len), at, len)! }
    const w1 = rec(at1, 100), w2 = rec(at2, 100), w3 = rec(at3, 100)
    const disk: Record<string, MemFile> = { [FILE]: { body, mtimeMs: 1, ino: 9 } }
    const reads: { start: number, len: number }[] = []
    const s = createCommandCodeState({ fs: memFs(disk, { reads }) })
    await s.observe(FILE)
    const h = s.handle(FILE)
    h.watch('t1', w1); h.watch('t2', w2); h.watch('t3', w3)
    disk[FILE]!.body = Buffer.concat([body, Buffer.from('new tail')])
    const o = await s.observe(FILE)
    expect(o.invalidated).toBe(false)
    // One read, bounded, covering only the records that fit the newest span.
    expect(reads.length).toBe(1)
    expect(reads[0]!.len).toBeLessThanOrEqual(WATCH_SPAN)
    expect(reads[0]!.start).toBe(at2)
    expect(reads[0]!.start + reads[0]!.len).toBe(at3 + 100)
  })

  it('coalesces concurrent observations into one stat', async () => {
    const stats = { n: 0 }
    const gate = defer()
    const s = createCommandCodeState({
      fs: memFs({ [FILE]: { body: Buffer.from('x'), mtimeMs: 1, ino: 9 } }, { stats, onStat: () => gate.promise }),
    })
    const a = s.observe(FILE)
    const b = s.observe(FILE)
    expect(a).toBe(b)
    gate.resolve()
    await a
    expect(stats.n).toBe(1)
  })

  it('keeps only the newest watch per id', async () => {
    const rec = Buffer.from(line('u1', 'out'))
    const disk: Record<string, MemFile> = { [FILE]: { body: Buffer.concat([Buffer.alloc(500, 0x61), rec]), mtimeMs: 1, ino: 9 } }
    const reads: { start: number, len: number }[] = []
    const s = createCommandCodeState({ fs: memFs(disk, { reads }) })
    await s.observe(FILE)
    const h = s.handle(FILE)
    h.watch('t1', watchFingerprint(rec, 500, rec.length)!)
    h.watch('t1', watchFingerprint(disk[FILE]!.body.subarray(0, 10), 0, 10)!) // older offset: dropped
    disk[FILE]!.body[7] = 0x62 // corrupt only the dropped watch's span, then grow
    disk[FILE]!.body = Buffer.concat([disk[FILE]!.body, Buffer.from('\ntail')])
    const o = await s.observe(FILE)
    expect(o.invalidated).toBe(false)
    expect(reads).toEqual([{ start: 500, len: rec.length }])
    // A newer record for the same id replaces the watch instead.
    const rec2 = Buffer.from(line('u2', 'newer'))
    h.watch('t1', watchFingerprint(rec2, 900, rec2.length)!)
    disk[FILE]!.body = Buffer.concat([disk[FILE]!.body, Buffer.alloc(400, 0x63)])
    disk[FILE]!.body.fill(0x21, 500, 510) // corrupt the superseded span, unseen
    const o2 = await s.observe(FILE)
    expect(o2.invalidated).toBe(true)
    expect(reads[1]!.start).toBe(900)
  })

  it('bounds watches per file — the oldest fingerprints are forgotten', async () => {
    const disk: Record<string, MemFile> = { [FILE]: { body: Buffer.alloc(20_000, 0x61), mtimeMs: 1, ino: 9 } }
    const reads: { start: number, len: number }[] = []
    const s = createCommandCodeState({ fs: memFs(disk, { reads }) })
    await s.observe(FILE)
    const h = s.handle(FILE)
    // 4100 watches over the 4096 cap: the first four leave the set.
    for (let i = 0; i < 4100; i++) h.watch(`t${i}`, { at: i * 4, len: 1, hash: `h${i}` })
    disk[FILE]!.body = Buffer.alloc(30_000, 0x61)
    await s.observe(FILE)
    // The first record the read covers is the fifth registered.
    expect(reads[0]!.start).toBe(16)
  })

  it('samples only the prefix of a giant watched record', async () => {
    const rec = Buffer.alloc(5 * 1024 * 1024, 0x61)
    const disk: Record<string, MemFile> = { [FILE]: { body: rec, mtimeMs: 1, ino: 9 } }
    const reads: { start: number, len: number }[] = []
    const s = createCommandCodeState({ fs: memFs(disk, { reads }) })
    await s.observe(FILE)
    s.handle(FILE).watch('t1', watchFingerprint(rec, 0, rec.length)!)
    disk[FILE]!.body = Buffer.concat([rec, Buffer.from('\nx')])
    const o = await s.observe(FILE)
    expect(o.invalidated).toBe(false)
    expect(reads).toEqual([{ start: 0, len: WATCH_BYTES }])
  })

  it('evicts only the evicted file — other stamps survive and old ones never reissue', () => {
    const s = createCommandCodeState({ fs: memFs({}) })
    const a = '/f/a', b = '/f/b'
    s.handle(a); s.handle(b)
    const stampA = s.stampOf(a)
    const stampB = s.stampOf(b)
    // 63 more entries push the oldest ('a') out of the 64-file bound.
    for (let i = 0; i < 63; i++) s.handle(`/f/x${i}`)
    expect(s.stampOf(a)).toBe(0)
    expect(s.stampOf(b)).toBe(stampB)
    // 'a' comes back as a new entry: its old stamp can never be reissued,
    // so no token minted on it can compare current again.
    s.handle(a)
    expect(s.stampOf(a)).not.toBe(stampA)
    expect(s.stampOf(a)).toBeGreaterThan(stampA)
  })

  it('coalesces at the pending cap, keeps every live promise, and recovers', async () => {
    const disk: Record<string, MemFile> = {}
    for (let i = 0; i < 70; i++) disk[`/f/p${i}`] = { body: Buffer.from('x'), mtimeMs: 1, ino: 9 }
    let calls = 0
    const gates: (() => void)[] = []
    const io: MemIo = { onStat: async () => { calls++; await new Promise<void>(r => gates.push(r)) } }
    const s = createCommandCodeState({ fs: memFs(disk, io) })
    const lives = Array.from({ length: 64 }, (_, i) => s.observe(`/f/p${i}`))
    // A distinct 65th file launches no IO at the cap — synchronously: an
    // uncapped observe would already have issued its stat call.
    const overP = s.observe('/f/p64')
    expect(calls).toBe(64)
    const over = await overP
    expect(over).toMatchObject({ st: null, stamp: 0, invalidated: false })
    // Same-file at the cap still coalesces into the live promise.
    expect(s.observe('/f/p0')).toBe(lives[0])
    // Release one; the next distinct observe launches its own stat.
    gates[0]!()
    await lives[0]
    const p64 = s.observe('/f/p64')
    expect(calls).toBe(65)
    gates[gates.length - 1]!()
    const recovered = await p64
    expect(recovered).toMatchObject({ invalidated: true })
    expect(recovered.st?.size).toBe(1)
    gates.forEach(g => g())
    await Promise.all(lives.slice(1))
  })

  it('drops out-of-contract watch registration — proven by later validation', async () => {
    const rec = Buffer.from(line('u1', 'out'))
    const disk: Record<string, MemFile> = { [FILE]: { body: rec, mtimeMs: 1, ino: 9 } }
    const reads: { start: number, len: number }[] = []
    const s = createCommandCodeState({ fs: memFs(disk, { reads }) })
    await s.observe(FILE)
    const h = s.handle(FILE)
    const wrong = watchFingerprint(Buffer.from('different'), 0, 6)!
    h.watch('', wrong) // empty id
    h.watch('x'.repeat(129), wrong) // over the 128-byte contract
    h.watch('€'.repeat(65), wrong) // 65 chars but 195 UTF-8 bytes
    h.watch('t1', { at: 0, len: 5, hash: 'h'.repeat(65) }) // oversized hash
    h.watch('t2', { at: -1, len: 5, hash: 'h' }) // malformed position
    h.watch('t3', { at: Number.MAX_SAFE_INTEGER - 5, len: 20, hash: 'h' }) // overflowed end
    h.watch('t4', { at: 0, len: Number.NaN, hash: 'h' })
    disk[FILE]!.body = Buffer.concat([rec, Buffer.from('\ntail')])
    const o = await s.observe(FILE)
    // Every write dropped: no validation read, the growth stays trusted.
    expect(reads).toEqual([])
    expect(o).toMatchObject({ invalidated: false })
    expect(o.st?.size).toBe(disk[FILE]!.body.length)
    // An in-contract watch does register and is validated on the next grow.
    h.watch('t5', watchFingerprint(disk[FILE]!.body, 0, disk[FILE]!.body.length)!)
    disk[FILE]!.body = Buffer.concat([disk[FILE]!.body, Buffer.from('x')])
    expect((await s.observe(FILE)).invalidated).toBe(false)
    expect(reads.length).toBe(1)
  })
})
