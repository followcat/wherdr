import { appendFileSync, chmodSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localShell } from '../server/utils/agentProcesses'
import { cmdFiles } from '../server/utils/commandCodeFiles'
import { createCmdHeaders } from '../server/utils/commandCodeHeaders'
import type { CmdFileSnapshot } from '../server/utils/commandCodeFileRecords'
import type { ShellExec } from '../server/utils/fsx'
import { U1, U2, U3, cleanupHomes, counting, hdr, mkhome, put, putSess, rootOf } from './cmdHeaderFixture'

afterEach(cleanupHomes)

const snap = async (home: string) => cmdFiles(localShell, home)
const count = () => counting(localShell)

describe('createCmdHeaders', () => {
  it('reads validated headers for every candidate, large bodies bounded', async () => {
    const home = mkhome()
    const f1 = putSess(home, 'p', U1, '/work/one')
    putSess(home, 'q', U2, '/work/two', 'x'.repeat(3 * 1024 * 1024)) // multi-MB body, first line only
    const c = count()
    const h = createCmdHeaders(c.exec, home)
    const r = await h.headers(await snap(home))
    expect(r.complete).toBe(true)
    expect(r.items.map(i => i.file).sort()).toEqual([f1, join(rootOf(home), 'q', `${U2}.jsonl`)].sort())
    expect(r.items.find(i => i.file === f1)).toMatchObject({ id: U1, cwd: '/work/one' })
    expect(c.seen.length).toBe(1) // one batch round trip
    // A warm unchanged poll transfers zero header bytes: no exec at all.
    const r2 = await h.headers(await snap(home))
    expect(r2.complete).toBe(true)
    expect(r2.items.length).toBe(2)
    expect(c.seen.length).toBe(1)
  })

  it('is incomplete on malformed, wrong-shape or mismatched headers', async () => {
    const home = mkhome()
    putSess(home, 'ok', U1)
    put(home, 'bad', `${U2}.jsonl`, 'not json\n')
    put(home, 'ver', `${U3}.jsonl`, JSON.stringify({ type: 'session', version: 2, id: U3, cwd: '/x' }) + '\n')
    let r = await createCmdHeaders(localShell, home).headers(await snap(home))
    expect(r.complete).toBe(false)
    expect(r.incomplete).toBe('metadata')
    expect(r.items.map(i => i.id)).toEqual([U1]) // good entries still returned
    // id in the header disagreeing with the basename is just as malformed.
    const home2 = mkhome()
    put(home2, 'p', `${U1}.jsonl`, hdr(U2) + 'x\n')
    r = await createCmdHeaders(localShell, home2).headers(await snap(home2))
    expect(r.incomplete).toBe('metadata')
    // relative cwd and an overlong first line fail the same way.
    const home3 = mkhome()
    put(home3, 'p', `${U1}.jsonl`, hdr(U1, 'relative/cwd') + 'x\n')
    put(home3, 'p', `${U2}.jsonl`, `{"type":"session","version":3,"id":"${U2}","cwd":"/${'x'.repeat(20000)}"}\n`)
    r = await createCmdHeaders(localShell, home3).headers(await snap(home3))
    expect(r.incomplete).toBe('metadata')
    expect(r.items).toEqual([])
  })

  it('propagates an incomplete producer snapshot without re-reading', async () => {
    const home = mkhome()
    // The real metadata producer already flags an unreadable file — that flag
    // must reach the result, never be quietly re-read.
    const locked = putSess(home, 'p', U1)
    chmodSync(locked, 0)
    const c = count()
    const r = await createCmdHeaders(c.exec, home).headers(await snap(home))
    expect(r.complete).toBe(false)
    expect(r.incomplete).toBe('metadata')
    expect(c.seen.length).toBe(0) // no header RPC on an incomplete snapshot
    chmodSync(locked, 0o644)
  })

  it('reports a listing-meta vs observed-stat mismatch as raced', async () => {
    const home = mkhome()
    const f = putSess(home, 'p', U1)
    const s = await snap(home)
    appendFileSync(f, 'more\n') // mtime/size changed after the listing
    const r = await createCmdHeaders(localShell, home).headers(s)
    expect(r.incomplete).toBe('raced')
    expect(r.items).toEqual([]) // never a mixed header/stat candidate
  })

  it('rejects unsafe snapshot metadata even when the record would be pre-birth', async () => {
    const home = mkhome()
    const f = `${rootOf(home)}/p/${U1}.jsonl`
    const snapOf = (over: object): CmdFileSnapshot => ({ complete: true, files: [{ file: f, ino: 7, size: 9, mtimeMs: 1, ...over }], dirs: 1, found: 1 })
    // Every record is validated BEFORE afterMs/cache: malformed numeric
    // metadata can never hide a candidate behind a "pre-birth" filter.
    for (const bad of [
      snapOf({ mtimeMs: Number.NaN }),
      snapOf({ mtimeMs: Number.POSITIVE_INFINITY }),
      snapOf({ ino: 0 }),
      snapOf({ ino: -1 }),
      snapOf({ ino: Number.NaN }),
      snapOf({ size: -1 }),
      snapOf({ size: Number.NaN }),
      snapOf({ size: 9007199254740993 }) // 2^53+1 rounds — not a safe integer
    ]) {
      const r = await createCmdHeaders(localShell, home).headers(bad, { afterMs: 0 })
      expect(r.complete).toBe(false)
      expect(r.incomplete).toBe('metadata')
    }
  })

  it('rejects header lines that are not exact UTF-8', async () => {
    const home = mkhome()
    // A raw 0xFF byte inside cwd must not decode to '/work/�' and be used.
    const bad = Buffer.concat([
      Buffer.from(`{"type":"session","version":3,"id":"${U1}","cwd":"/work/`),
      Buffer.from([0xff]),
      Buffer.from('"}\nbody\n')
    ])
    put(home, 'p', `${U1}.jsonl`, bad)
    const r = await createCmdHeaders(localShell, home).headers(await snap(home))
    expect(r.complete).toBe(false)
    expect(r.incomplete).toBe('metadata')
    // A REAL U+FFFD (EF BF BD) and other unicode are valid UTF-8: keep them.
    const home2 = mkhome()
    putSess(home2, 'p', U1, '/work/λ�x')
    const r2 = await createCmdHeaders(localShell, home2).headers(await snap(home2))
    expect(r2.complete).toBe(true)
    expect(r2.items[0]?.cwd).toBe('/work/λ�x')
  })

  it('skips pre-birth header reads but keeps every basename for seeds', async () => {
    const home = mkhome()
    const old = putSess(home, 'old', U2)
    const fresh = putSess(home, 'new', U1)
    utimesSync(old, 1_000_000_000, 1_000_000_000)
    utimesSync(fresh, 1_700_000_000, 1_700_000_000)
    const s = await snap(home)
    const c = count()
    const r = await createCmdHeaders(c.exec, home).headers(s, { afterMs: 1_500_000_000_000 })
    expect(r.complete).toBe(true)
    expect(r.items.map(i => i.id)).toEqual([U1]) // only post-birth got a header read
    expect(r.files.map(f => f.id).sort()).toEqual([U1, U2].sort()) // all basenames preserved
    expect(c.seen[0]?.slice(1)).toEqual([fresh]) // the pre-birth path was never read
  })

  it('keeps duplicate basenames visible when one is pre-birth and malformed', async () => {
    const home = mkhome()
    // A --session <uuid> seed is unique only across ALL files: hiding the
    // pre-birth duplicate (or failing on its unread header) would falsely
    // accept the seed. Pre-birth entries never reach a header read at all.
    const a = putSess(home, 'd1', U1)
    const b = put(home, 'd2', `${U1}.jsonl`, 'not a header\n')
    utimesSync(a, 1_700_000_000, 1_700_000_000)
    utimesSync(b, 1_000_000_000, 1_000_000_000)
    const r = await createCmdHeaders(localShell, home).headers(await snap(home), { afterMs: 1_500_000_000_000 })
    expect(r.complete).toBe(true)
    expect(r.items.map(i => i.id)).toEqual([U1])
    expect(r.files.filter(f => f.id === U1).length).toBe(2) // ambiguity survives
  })

  it('stays incomplete on an incomplete snapshot but ships the catalog', async () => {
    const home = mkhome()
    const f = `${rootOf(home)}/p/${U1}.jsonl`
    const s: CmdFileSnapshot = { complete: false, incomplete: 'raced', files: [{ file: f, ino: 7, size: 9, mtimeMs: 1 }], dirs: 0, found: 0 }
    const r = await createCmdHeaders(localShell, home).headers(s)
    expect(r.complete).toBe(false)
    expect(r.incomplete).toBe('raced')
    expect(r.items).toEqual([])
    expect(r.files).toEqual([{ file: f, id: U1 }])
    expect((await createCmdHeaders(localShell, home).headers(s, { afterMs: Number.NaN })).incomplete).toBe('metadata')
    // An empty complete snapshot completes with an empty catalog, no exec.
    const c = count()
    const empty = await createCmdHeaders(c.exec, mkhome()).headers(await snap(mkhome()))
    expect(empty).toMatchObject({ complete: true, items: [], files: [] })
    expect(c.seen.length).toBe(0)
  })

  it('re-reads changed or replaced files and retries failed reads', async () => {
    const home = mkhome()
    const f = putSess(home, 'p', U1)
    const c = count()
    const h = createCmdHeaders(c.exec, home)
    expect((await h.headers(await snap(home))).complete).toBe(true)
    expect(c.seen.length).toBe(1)
    appendFileSync(f, 'more events\n') // changed: stat triple differs -> re-read
    expect((await h.headers(await snap(home))).complete).toBe(true)
    expect(c.seen.length).toBe(2)
    unlinkSync(f)
    writeFileSync(f, hdr(U2) + 'x\n') // replaced: new inode AND new header id
    const s = await snap(home)
    const r = await h.headers(s)
    expect(r.complete).toBe(false) // basename id U1 != header id U2: metadata
    expect(r.incomplete).toBe('metadata')
    // A failed read is never cached as success: fix and it recovers.
    writeFileSync(f, hdr(U1) + 'x\n')
    const r2 = await h.headers(await snap(home))
    expect(r2.complete).toBe(true)
    expect(r2.items.map(i => i.id)).toEqual([U1])
  })

  it('evicts within a bounded cache without losing current-pass candidates', async () => {
    const home = mkhome()
    putSess(home, 'p', U1)
    putSess(home, 'p', U2)
    putSess(home, 'p', U3)
    const h = createCmdHeaders(localShell, home, { cacheEntries: 1 }) // smaller than the snapshot
    for (let i = 0; i < 3; i++) {
      const r = await h.headers(await snap(home))
      expect(r.complete).toBe(true)
      expect(r.items.length).toBe(3) // eviction forces re-reads, never drops items
    }
  })

  it('coalesces concurrent calls and bounds the pending queue', async () => {
    const home = mkhome()
    putSess(home, 'p', U1)
    const c = count()
    const h = createCmdHeaders(c.exec, home)
    const s = await snap(home)
    const [a, b] = await Promise.all([h.headers(s), h.headers(s)])
    expect(a.complete).toBe(true)
    expect(b.complete).toBe(true)
    expect(c.seen.length).toBe(1) // serialized: the second call sees a warm cache
    // Identical in-flight calls share work BEFORE pending accounting: with
    // maxPending=1 both resolve COMPLETE on one exec — serial queue plus
    // rejection is not coalescing. Distinct requests still hit the cap.
    let release: () => void = () => {}
    const gate = new Promise<void>(res => { release = res })
    const c2 = count()
    const slow: ShellExec = async (s2, a, o) => { await gate; return c2.exec(s2, a, o) }
    const h2 = createCmdHeaders(slow, home, { maxPending: 1 })
    const g1 = h2.headers(s)
    const g2 = h2.headers(s) // identical: shares g1, spends no pending slot
    const overAfter = await h2.headers(s, { afterMs: 42 }) // distinct afterMs -> cap
    const overSnap = await h2.headers({ ...s }) // distinct snapshot -> cap
    expect(overAfter.incomplete).toBe('unavailable')
    expect(overSnap.incomplete).toBe('unavailable')
    release()
    const [r1, r2] = await Promise.all([g1, g2])
    expect(r1).toBe(r2) // literally the same shared resolution
    expect(r1.complete).toBe(true)
    expect(r1.items.length).toBe(1)
    expect(c2.seen.length).toBe(1) // one exec for both callers
    // Once resolved the key is forgotten: the next identical call gets a
    // fresh run (warm cache legitimately needs no exec for it).
    const r3 = await h2.headers(s)
    expect(r3).not.toBe(r1)
    expect(r3.complete).toBe(true)
    expect(c2.seen.length).toBe(1)
    // A shared in-flight failure resolves identically for every sharer.
    const boom: ShellExec = async () => { throw new Error('x') }
    const h3 = createCmdHeaders(boom, home, { maxPending: 1 })
    const [f1, f2] = await Promise.all([h3.headers(s), h3.headers(s)])
    expect(f1).toBe(f2)
    expect(f1.incomplete).toBe('unavailable')
  })

  it('aborts instead of issuing an empty batch for an oversized path', async () => {
    const home = mkhome()
    // One path bigger than the whole request budget: chunk assembly must
    // fail, never loop zero-progress RPCs. (Timeout would reveal a hang.)
    const huge = `${rootOf(home)}/${'x'.repeat(300000)}/${U1}.jsonl`
    const s: CmdFileSnapshot = { complete: true, files: [{ file: huge, ino: 1, size: 1, mtimeMs: 1 }], dirs: 1, found: 1 }
    const r = await createCmdHeaders(localShell, home).headers(s)
    expect(r.complete).toBe(false)
    expect(r.incomplete).toBe('metadata')
  }, 2000)

  it('clamps cache and pending options to finite positive bounds', async () => {
    const home = mkhome()
    putSess(home, 'p', U1)
    const s = await snap(home)
    // maxPending: 0 would refuse every call; a clamped bound keeps working.
    const h = createCmdHeaders(localShell, home, { maxPending: 0 })
    expect((await h.headers(s)).complete).toBe(true)
    // cacheEntries: 0 evicts every entry at insert: a warm poll must not
    // re-read, so the clamped bound keeps its minimum capacity.
    const c = count()
    const h2 = createCmdHeaders(c.exec, home, { cacheEntries: 0 })
    expect((await h2.headers(s)).complete).toBe(true)
    expect((await h2.headers(s)).complete).toBe(true)
    expect(c.seen.length).toBe(1) // stayed warm: no re-read
    // Infinity must not disable the pending bound either.
    const h3 = createCmdHeaders(localShell, home, { maxPending: Number.POSITIVE_INFINITY, cacheEntries: Number.NaN })
    expect((await h3.headers(s)).complete).toBe(true)
  })

  it('passes the canonical root positionally inside each request', async () => {
    const home = mkhome()
    putSess(home, 'p', U1)
    const c = count()
    await createCmdHeaders(c.exec, home).headers(await snap(home))
    expect(c.seen[0]?.[0]).toBe(rootOf(home))
    expect(c.seen[0]?.length).toBe(2) // root + one path
  })

  it('chunks large batches on count and reports RPC counts', async () => {
    const home = mkhome()
    for (let i = 0; i < 70; i++) {
      const id = `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
      putSess(home, 'p', id)
    }
    const c = count()
    const r = await createCmdHeaders(c.exec, home).headers(await snap(home))
    expect(r.complete).toBe(true)
    expect(r.items.length).toBe(70)
    expect(c.seen.length).toBe(2) // 70 > 64-record batch bound -> two bounded RPCs
    expect(c.seen.every(a => a.length <= 65)).toBe(true) // root + <=64 paths
    expect(c.seen.every(a => a[0] === rootOf(home))).toBe(true) // root positional
  })
})
