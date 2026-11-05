// File-scoped Command Code state: per-file result/watch maps, trusted
// (size, gen, inode) evidence, invalidation stamps and the reader nonce —
// lifecycle coverage; watch-validation observations are the next spec.
// Driven by fake disks only, never a real home/proc/agent.
import { describe, expect, it } from 'vitest'
import { createCommandCodeState } from '../server/utils/commandCodeState'
import { watchFingerprint } from '../server/utils/commandCodeWatch'
import { defer, line, memFs, type MemFile, type MemIo } from './cmdStateFixture'

const FILE = '/home/user/.commandcode/projects/-w-proj/s1.jsonl'

describe('commandCodeState', () => {
  it('tracks a new file, an unchanged stat and a growing append', async () => {
    const disk: Record<string, MemFile> = { [FILE]: { body: Buffer.from(line('u1', 'one')), mtimeMs: 1, ino: 9 } }
    const reads: { start: number, len: number }[] = []
    const s = createCommandCodeState({ fs: memFs(disk, { reads }) })
    const first = await s.observe(FILE)
    expect(first.invalidated).toBe(true) // a new entry: its clients rebuild
    expect(first.st?.size).toBe(disk[FILE]!.body.length)
    const again = await s.observe(FILE)
    expect(again).toMatchObject({ invalidated: false, stamp: first.stamp })
    // A growing append keeps everything; with no watches nothing is read.
    disk[FILE]!.body = Buffer.concat([disk[FILE]!.body, Buffer.from('\n' + line('u2', 'two'))])
    const grown = await s.observe(FILE)
    expect(grown).toMatchObject({ invalidated: false, stamp: first.stamp })
    expect(reads).toEqual([])
    expect(s.stampOf(FILE)).toBe(first.stamp)
  })

  it('detects a truncate, a new inode and a same-size rewrite', async () => {
    const disk: Record<string, MemFile> = { [FILE]: { body: Buffer.from(line('u1', 'one') + '\n' + line('u2', 'two')), mtimeMs: 1, ino: 9 } }
    const s = createCommandCodeState({ fs: memFs(disk) })
    const first = await s.observe(FILE)
    disk[FILE]!.body = Buffer.from(line('u1', 'one')) // shorter: a truncation
    const cut = await s.observe(FILE)
    expect(cut).toMatchObject({ invalidated: true, stamp: first.stamp + 1 })
    const stable = await s.observe(FILE)
    disk[FILE]!.ino = 77 // another inode: a different file replaced it
    const inode = await s.observe(FILE)
    expect(inode).toMatchObject({ invalidated: true, stamp: stable.stamp + 1 })
    // Same size, another generation: rewritten in place within one second.
    const size = disk[FILE]!.body.length
    disk[FILE]!.body = Buffer.from(line('u1', 'ONE').padEnd(size, ' '))
    disk[FILE]!.mtimeMs = 2
    const gen = await s.observe(FILE)
    expect(gen).toMatchObject({ invalidated: true, stamp: inode.stamp + 1 })
    expect((await s.observe(FILE)).invalidated).toBe(false)
  })

  it('invalidates on any inode continuity change while growing — both directions', async () => {
    for (const [from, to] of [[9, undefined], [undefined, 9]] as const) {
      const disk: Record<string, MemFile> = { [FILE]: { body: Buffer.from(line('u1', 'one')), mtimeMs: 1, ino: from } }
      const reads: { start: number, len: number }[] = []
      const s = createCommandCodeState({ fs: memFs(disk, { reads }) })
      const first = await s.observe(FILE)
      s.handle(FILE).results.set('t1', { out: 'kept' })
      disk[FILE]!.ino = to // continuity evidence changed while appending
      disk[FILE]!.body = Buffer.concat([disk[FILE]!.body, Buffer.from('\nmore')])
      const o = await s.observe(FILE)
      expect(o.invalidated).toBe(true)
      expect(o.stamp).not.toBe(first.stamp)
      // A replacement, not a validation masquerading as continuity.
      expect(reads).toEqual([])
      expect(s.handle(FILE).results.size).toBe(0)
    }
  })

  it('detaches stale result/watch handles after truncate and eviction', async () => {
    const disk: Record<string, MemFile> = { [FILE]: { body: Buffer.from(line('u1', 'one')), mtimeMs: 1, ino: 9 } }
    const s = createCommandCodeState({ fs: memFs(disk) })
    await s.observe(FILE)
    const old = s.handle(FILE)
    old.results.set('t1', { out: 'kept' })
    old.watch('t1', { at: 0, len: 5, hash: 'h' })
    disk[FILE]!.body = Buffer.from('short')
    await s.observe(FILE)
    // A new generation: the old handle's maps are void, its stamp stale.
    const fresh = s.handle(FILE)
    expect(fresh.stamp).toBe(s.stampOf(FILE))
    expect(old.stamp).not.toBe(s.stampOf(FILE))
    expect(fresh.results).not.toBe(old.results)
    old.results.set('t2', { out: 'stale' })
    expect(fresh.results.size).toBe(0)
    // A stale watch that mismatches the new file must not reach it either:
    // seed a valid fresh watch + result, send the stale one, then grow.
    // Its at sits inside the read span so a misdirected entry would hash
    // real bytes and invalidate — never just shrink the verified span.
    fresh.results.set('t2', { out: 'fresh' })
    fresh.watch('t2', watchFingerprint(disk[FILE]!.body, 0, disk[FILE]!.body.length)!)
    old.watch('t3', { at: 1, len: 4, hash: 'WRONGFINGERPRINT' })
    disk[FILE]!.body = Buffer.concat([disk[FILE]!.body, Buffer.from('\nmore')])
    const o = await s.observe(FILE)
    expect(o).toMatchObject({ invalidated: false, stamp: fresh.stamp })
    expect(o.st?.size).toBe(disk[FILE]!.body.length)
    expect(s.handle(FILE).results.size).toBe(1)
    // And after the file's entry is evicted entirely, the same holds.
    const before = s.handle(FILE)
    for (let i = 0; i < 64; i++) s.handle(`/f/x${i}`)
    expect(before.stamp).not.toBe(s.stampOf(FILE))
    before.results.set('t3', { out: 'stale' })
    before.watch('t3', { at: 0, len: 1, hash: 'h' })
    expect(s.handle(FILE).results.size).toBe(0)
  })

  it('exposes an unvalidated observation as unknown and retries it', async () => {
    const rec = Buffer.from(line('u1', 'out'))
    const disk: Record<string, MemFile> = { [FILE]: { body: rec, mtimeMs: 1, ino: 9 } }
    const io: MemIo = { reads: [] }
    const s = createCommandCodeState({ fs: memFs(disk, io) })
    const first = await s.observe(FILE)
    s.handle(FILE).watch('t1', watchFingerprint(rec, 0, rec.length)!)
    disk[FILE]!.body = Buffer.concat([rec, Buffer.from('\ntail')])
    io.onRead = async () => { throw new Error('remote cut') }
    const unknown = await s.observe(FILE)
    // Unknown: no stat to trust, trusted size/gen held, same stamp.
    expect(unknown).toMatchObject({ st: null, invalidated: false, stamp: first.stamp })
    io.onRead = async () => Buffer.alloc(5) // short: the record can't be found
    expect((await s.observe(FILE)).st).toBeNull()
    io.onRead = undefined
    const retried = await s.observe(FILE)
    expect(retried).toMatchObject({ invalidated: false, stamp: first.stamp })
    expect(retried.st?.size).toBe(disk[FILE]!.body.length)
    expect(io.reads!.length).toBe(3)
    await s.observe(FILE)
    expect(io.reads!.length).toBe(3) // trusted now: no revalidation
  })

  it('lets no stale awaited stat publish under a fresh stamp', async () => {
    const disk: Record<string, MemFile> = { [FILE]: { body: Buffer.from('old-body'), mtimeMs: 1, ino: 9 } }
    const gate = defer()
    const entered = defer()
    const s = createCommandCodeState({
      fs: memFs(disk, { onStat: async () => { entered.resolve(); await gate.promise } }),
    })
    const stale = s.observe(FILE) // stat captured, then pends on the gate
    await entered.promise // the captured-old stat is in flight
    // While it awaits: evict the entry, change the file, seed a fresh generation.
    for (let i = 0; i < 64; i++) s.handle(`/f/x${i}`)
    disk[FILE]!.body = Buffer.from('grown-new')
    disk[FILE]!.ino = 42
    const fresh = s.handle(FILE)
    fresh.results.set('t1', { out: 'fresh' })
    gate.resolve()
    const late = await stale
    expect(late).toMatchObject({ st: null, invalidated: true })
    expect(late.stamp).toBe(fresh.stamp)
    expect(s.handle(FILE).results.size).toBe(1) // fresh maps survive
    // The abandoned stat wrote nothing: a real observation returns the
    // file's actual new stat, not the captured-old one.
    const real = await s.observe(FILE)
    expect(real.invalidated).toBe(true)
    expect(real.st).toMatchObject({ size: 'grown-new'.length, ino: 42 })
  })

  it('lets no stale awaited validation publish its stat under a fresh stamp', async () => {
    const rec = Buffer.from(line('u1', 'out'))
    const disk: Record<string, MemFile> = { [FILE]: { body: rec, mtimeMs: 1, ino: 9 } }
    const gate = defer()
    const entered = defer()
    const reads: { start: number, len: number }[] = []
    const s = createCommandCodeState({
      fs: memFs(disk, { reads, onRead: async () => { entered.resolve(); await gate.promise } }),
    })
    const first = await s.observe(FILE)
    s.handle(FILE).watch('t1', watchFingerprint(rec, 0, rec.length)!)
    // Grow in place: validation of the new state pends on the gated read.
    disk[FILE]!.body = Buffer.concat([rec, Buffer.from('\nmore')])
    const stale = s.observe(FILE)
    await entered.promise // the old record is bound; its read is in flight
    // While it awaits, the file's entry is evicted — newer state wins.
    for (let i = 0; i < 64; i++) s.handle(`/f/x${i}`)
    gate.resolve()
    const late = await stale
    expect(late).toMatchObject({ st: null, invalidated: true })
    expect(late.stamp).not.toBe(first.stamp)
    // The abandoned validation wrote nothing: the fresh entry has no
    // watches, so the next observation does no read at all.
    const fresh = await s.observe(FILE)
    expect(fresh.invalidated).toBe(true)
    expect(reads.length).toBe(1)
    expect(s.handle(FILE).results.size).toBe(0)
  })

  it('starts each reader with a fresh nonce and empty state', () => {
    const fs = memFs({ [FILE]: { body: Buffer.from('x'), mtimeMs: 1, ino: 9 } })
    const a = createCommandCodeState({ fs })
    const b = createCommandCodeState({ fs })
    expect(a.reader).not.toBe(b.reader)
    expect(a.stampOf(FILE)).toBe(0) // nothing tracked until observed
  })

  it('does not track a directory where the transcript was expected', async () => {
    const s = createCommandCodeState({ fs: memFs({ [FILE]: { body: Buffer.alloc(0), isDir: true } }) })
    const o = await s.observe(FILE)
    expect(o.invalidated).toBe(false)
    expect(s.stampOf(FILE)).toBe(0)
    await expect(s.observe('/gone')).rejects.toThrow('no such file')
  })
})
