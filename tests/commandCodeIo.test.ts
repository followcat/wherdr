import { describe, expect, it } from 'vitest'
import { commandCodeIo } from '../server/utils/commandCodeIo'
import { createCommandCodeState } from '../server/utils/commandCodeState'
import { watchFingerprint } from '../server/utils/commandCodeWatch'
import { defer, memFs } from './cmdStateFixture'

const FILE = '/f/cmd.jsonl'

describe('commandCodeIo', () => {
  it('answers exactly the asked bytes under a live stamp', async () => {
    const disk = { [FILE]: { body: Buffer.from('hello world') } }
    const io = commandCodeIo({ fs: memFs(disk), stampOf: () => 7 })
    expect((await io.readExact(FILE, 0, 5, 7))!.toString()).toBe('hello')
    expect((await io.readExact(FILE, 6, 5, 7))!.toString()).toBe('world')
    expect(io.live(FILE, 7)).toBe(true)
    expect(io.live(FILE, 8)).toBe(false)
  })

  it('a detached stamp performs no IO at all', async () => {
    const reads: Array<{ start: number, len: number }> = []
    const disk = { [FILE]: { body: Buffer.from('hello') } }
    const io = commandCodeIo({ fs: memFs(disk, { reads }), stampOf: () => 2 })
    expect(await io.readExact(FILE, 0, 5, 1)).toBeNull()
    expect(reads).toEqual([])
  })

  it('a generation moving mid-read detaches the result', async () => {
    let stamp = 1
    const gate = defer()
    const entered = defer()
    const disk = { [FILE]: { body: Buffer.from('hello world') } }
    const fs = memFs(disk, {
      onRead: async (start, len) => {
        const snap = disk[FILE].body.subarray(start, start + len)
        entered.resolve()
        await gate.promise
        return snap
      },
    })
    const io = commandCodeIo({ fs, stampOf: () => stamp })
    const p = io.readExact(FILE, 0, 5, 1)
    await entered.promise
    stamp = 2
    gate.resolve()
    expect(await p).toBeNull()
  })

  it('a short body is unknown, not a partial page', async () => {
    const disk = { [FILE]: { body: Buffer.from('hello') } }
    const fs = memFs(disk, {
      onRead: (start, len) => disk[FILE].body.subarray(start, start + len - 1),
    })
    const io = commandCodeIo({ fs, stampOf: () => 1 })
    expect(await io.readExact(FILE, 0, 5, 1)).toBeNull()
  })

  it('a failed read is unknown', async () => {
    const disk = { [FILE]: { body: Buffer.from('hello') } }
    const fs = memFs(disk, { onRead: () => { throw new Error('io') } })
    const io = commandCodeIo({ fs, stampOf: () => 1 })
    expect(await io.readExact(FILE, 0, 5, 1)).toBeNull()
  })

  it('stamp zero is not a captured generation — no IO', async () => {
    const reads: Array<{ start: number, len: number }> = []
    const disk = { [FILE]: { body: Buffer.from('hello') } }
    // stampOf returns 0: the file has no record, so 0 is "unproven", not a
    // generation a read may be bound to.
    const io = commandCodeIo({ fs: memFs(disk, { reads }), stampOf: () => 0 })
    expect(io.live(FILE, 0)).toBe(false)
    expect(await io.readExact(FILE, 0, 5, 0)).toBeNull()
    // Negative, fractional and unsafe stamps are not generations either.
    expect(io.live(FILE, -1)).toBe(false)
    expect(io.live(FILE, 1.5)).toBe(false)
    expect(io.live(FILE, Number.MAX_SAFE_INTEGER + 1)).toBe(false)
    expect(reads).toEqual([])
  })

  it('rejects invalid and oversized ranges before any IO', async () => {
    const reads: Array<{ start: number, len: number }> = []
    const disk = { [FILE]: { body: Buffer.from('hello') } }
    const io = commandCodeIo({ fs: memFs(disk, { reads }), stampOf: () => 1 })
    const LIMIT = 60 * 1024 * 1024
    for (const [start, len] of [
      [-1, 5], [0, -1], [0.5, 5], [0, 2.5], [NaN, 5],
      // Safe halves with an impossible end, then reads past the 60 MiB
      // ceiling the bounded transports already enforce.
      [Number.MAX_SAFE_INTEGER, 5], [0, LIMIT + 1], [5, LIMIT + 1],
    ]) {
      expect(await io.readExact(FILE, start, len, 1)).toBeNull()
    }
    // Nothing reached the fs: a bad range must never become a Buffer.alloc
    // attempt or a wire request.
    expect(reads).toEqual([])
    // The ceiling itself is admitted — the fake answers short, so the call
    // is still unknown, but the issued length proves the boundary is not
    // silently tighter.
    expect(await io.readExact(FILE, 0, LIMIT, 1)).toBeNull()
    expect(reads).toEqual([{ start: 0, len: LIMIT }])
    // A zero-length range covers exactly nothing — valid, returns empty.
    expect((await io.readExact(FILE, 0, 0, 1))!.length).toBe(0)
  })

  it('observe validation consumes it: a short span read holds the epoch', async () => {
    const body0 = Buffer.from('alpha-beta')
    const disk = { [FILE]: { body: body0 } }
    let short = false
    const io = {
      onRead: (start: number, len: number) =>
        short ? disk[FILE].body.subarray(start, start + len - 1) : undefined,
    }
    const st = createCommandCodeState({ fs: memFs(disk, io) })
    await st.observe(FILE)
    const h = st.handle(FILE)
    h.watch('w1', watchFingerprint(body0, 0, 4)!)
    disk[FILE].body = Buffer.concat([body0, Buffer.from('-tail')])
    short = true
    // The span validation read comes back short: unknown — hold, no epoch.
    const o1 = await st.observe(FILE)
    expect(o1.st).toBeNull()
    expect(st.stampOf(FILE)).toBe(h.stamp)
    short = false
    // Recovering without another disk write: the retry validates and grows.
    const o2 = await st.observe(FILE)
    expect(o2.st?.size).toBe(disk[FILE].body.length)
    expect(o2.invalidated).toBe(false)
    expect(st.stampOf(FILE)).toBe(h.stamp)
  })
})
