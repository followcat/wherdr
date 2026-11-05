// Command Code metadata through the public createTranscripts API: the
// generation-bound model, the guarded-chat preview fallback, generation-
// bound search and image re-reads — fake disk and gated IO only, never a
// real fs/agent.
import { describe, expect, it } from 'vitest'
import { createTranscripts, type Loc, type TranscriptPane } from '../server/utils/transcripts'
import type { FsStat, MachineFs } from '../server/utils/fsx'
import { defer, memFs, type MemFile, type MemIo } from './cmdStateFixture'
import { at, assistant, J, results, sess, user } from './cmdParserFixture'

const FILE = '/home/alice/.commandcode/projects/-w/s1.jsonl'
const FILE2 = '/home/alice/.commandcode/projects/-w/s2.jsonl'
const PANE: TranscriptPane = { id: 'p1', agent: 'cmd', cwd: '/w' }
const PANE2: TranscriptPane = { id: 'p2', agent: 'cmd', cwd: '/w' }
const noHerdr = (async () => { throw new Error('no Herdr') }) as never
const body = (...l: unknown[]) => Buffer.from(J(...l) + '\n')
const mc = (model: string, ms = 0) => ({ type: 'model_change', id: `mc-${ms}`, parentId: null, timestamp: at(ms), model })
const call = (id = 't1', ms = 5) => assistant('a1', [{ type: 'tool_use', id, name: 'read_file', input: {} }], ms)
const out = (id: string, content: unknown, ms = 10, tid = 't1') => results(id, [{ tool_use_id: tid, content }], ms)
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')
const imgLine = (id: string, ms = 5) => assistant(id, [
  { type: 'text', text: 'here it is' },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
], ms)
const sel = (file = FILE, session = 's1'): Loc => ({ file, session })
const mk = (disk: Record<string, MemFile>, io?: MemIo, locate?: (p: TranscriptPane) => Promise<Loc | null>) =>
  createTranscripts({ home: '/h', herdr: noHerdr, fs: memFs(disk, io), locateCommandCode: locate ?? (async () => sel()) })

describe('Command Code metadata', () => {
  it('model() reads the last model line, caches it per generation and reads appends only', async () => {
    const v1 = body(sess('s1'), user('u1', 'q', 1), mc('example/model-a', 2))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    const reads: { start: number, len: number }[] = []
    const t = mk(disk, { reads })
    expect((await t.model(PANE))!.id).toBe('example/model-a')
    reads.length = 0
    // Same generation and size: the bound entry answers without any read.
    expect((await t.model(PANE))!.id).toBe('example/model-a')
    expect(reads).toEqual([])
    const add = Buffer.from(J(user('u2', 'more', 3), mc('example/model-b', 4)) + '\n')
    disk[FILE].body = Buffer.concat([v1, add])
    expect((await t.model(PANE))!.id).toBe('example/model-b')
    // The append fallback re-reads only what followed the remembered size.
    expect(Math.min(...reads.map(r => r.start))).toBeGreaterThanOrEqual(v1.length - 2)
  })

  it('model() refreshes on same-size rewrite and inode replacement — no size-only identity', async () => {
    const v1 = body(sess('s1'), user('u1', 'q', 1), mc('example/model-a', 2))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    const t = mk(disk)
    expect((await t.model(PANE))!.id).toBe('example/model-a')
    // Same session file, same size, another generation: re-read, not the cache.
    const v2 = body(sess('s1'), user('u1', 'q', 1), mc('example/model-b', 2))
    expect(v2.length).toBe(v1.length)
    disk[FILE] = { body: v2, mtimeMs: 9 }
    expect((await t.model(PANE))!.id).toBe('example/model-b')
    // Same size again but another inode: replaced — another generation.
    const v3 = body(sess('s1'), user('u1', 'q', 1), mc('example/model-c', 2))
    disk[FILE] = { body: v3, mtimeMs: 9, ino: 4242 }
    expect((await t.model(PANE))!.id).toBe('example/model-c')
  })

  it('model() returns null without identity and never inherits a prior selected file\'s metadata', async () => {
    const disk: Record<string, MemFile> = {
      [FILE]: { body: body(sess('s1'), user('u1', 'q', 1), mc('example/model-a', 2)) },
      [FILE2]: { body: body(sess('s2'), user('u2', 'q', 1), mc('example/model-z', 2)) },
    }
    let cur: Loc | null = sel()
    const t = mk(disk, undefined, async () => cur)
    expect((await t.model(PANE))!.id).toBe('example/model-a')
    // The selection moved to another session file: read for itself — the
    // cached entry names the old file and cannot answer for the new one.
    cur = sel(FILE2, 's2')
    expect((await t.model(PANE))!.id).toBe('example/model-z')
    // Identity unavailable: "no location", never a failed-read fallback.
    cur = null
    expect(await t.model(PANE)).toBeNull()
  })

  it('model() returns null when the selected file disappears — even with a warm entry', async () => {
    const disk: Record<string, MemFile> = { [FILE]: { body: body(sess('s1'), user('u1', 'q', 1), mc('example/model-a', 2)) } }
    const t = mk(disk)
    expect((await t.model(PANE))!.id).toBe('example/model-a')
    delete disk[FILE]
    expect(await t.model(PANE)).toBeNull()
  })

  // Entry review: a metadata read whose window awaited across another
  // client's observed rewrite is another transcript's — never returned,
  // and never filled from a warm entry of the detached generation.
  it('a metadata read awaiting across an observed rewrite rejects, never the warm stale model', async () => {
    const v1 = body(sess('s1'), user('u1', 'q', 1), mc('example/model-a', 2))
    const add = Buffer.from(J(mc('example/model-c', 3)) + '\n')
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    const gate = defer()
    const entered = defer()
    let arm = false
    const io: MemIo = {
      onRead: async (start, len) => {
        const snap = disk[FILE].body.subarray(start, start + len)
        if (arm) { arm = false; entered.resolve(); await gate.promise }
        return snap
      },
    }
    const t = mk(disk, io)
    // Warm PANE's model cache, then grow the file: A's next call must read
    // beyond the remembered size — its raw read is the one gated.
    expect((await t.model(PANE))!.id).toBe('example/model-a')
    disk[FILE].body = Buffer.concat([v1, add])
    arm = true
    const aP = t.model(PANE)
    await entered.promise
    // B observes the in-place rewrite (same session file, new content)
    // and publishes the fresh model.
    disk[FILE] = { body: body(sess('s1'), user('u9', 'x', 1), mc('example/model-b', 2)), mtimeMs: 9 }
    expect((await t.model(PANE2))!.id).toBe('example/model-b')
    gate.resolve()
    // The warm entry is another generation's: stale(e) keeps only current
    // same-generation metadata — never the remembered model-a.
    await expect(aP).rejects.toThrow('read unknown')
    // B's generation stays authoritative after A's stale read is rejected.
    expect((await t.model(PANE))!.id).toBe('example/model-b')
  })

  // An unknown observation (here: the watch-span validation read fails on
  // an in-place grow) retains only proven same-generation metadata.
  it('an unknown observation retains only proven same-generation metadata', async () => {
    const v1 = body(sess('s1'), call(), out('r1', 'old outcome'), mc('example/model-a', 20))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    let fail = false
    const t = mk(disk, { onRead: () => { if (fail) { fail = false; throw new Error('io broke') } } })
    await t.chat(PANE, {}) // the result record's watch lives under this generation
    expect((await t.model(PANE))!.id).toBe('example/model-a')
    disk[FILE].body = Buffer.concat([v1, Buffer.from(J(user('u2', 'more', 30)) + '\n')])
    fail = true // the validation span read fails once → unknown, record kept
    expect((await t.model(PANE))!.id).toBe('example/model-a')
    fail = true
    // No entry proven of this generation: the unknown is a read error.
    await expect(t.model(PANE2)).rejects.toThrow('state unknown')
  })

  // Entry review: the issued window is clipped to the remaining 16 MiB
  // logical span — a request never reads under the cap's boundary.
  it('model() never issues a window past the remaining 16 MiB span', async () => {
    const CAP = 16 * 1024 * 1024
    const line = J(user('u1', 'x'.repeat(4000), 1)) + '\n'
    const n = Math.ceil((CAP + 300 * 1024) / line.length)
    const disk: Record<string, MemFile> = { [FILE]: { body: Buffer.concat([body(sess('s1')), Buffer.from(line.repeat(n))]) } }
    const reads: { start: number, len: number }[] = []
    const t = mk(disk, { reads })
    expect(await t.model(PANE)).toBeNull()
    // The last issued window reaches the cap's boundary — never below it
    // (readRange takes one lookback byte before a nonzero start).
    const size = disk[FILE].body.length
    expect(Math.min(...reads.map(r => r.start))).toBeGreaterThanOrEqual(size - CAP - 1)
  })

  it('preview() falls back through the guarded chat and keeps a stable reply key', async () => {
    const v1 = body(sess('s1'), user('u1', 'q', 1), assistant('a1', [{ type: 'text', text: 'First answer' }], 5))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    const t = mk(disk)
    const first = await t.latestReply(PANE)
    expect(first?.text).toBe('First answer')
    expect(await t.latestReply(PANE)).toEqual(first)
    expect(await t.preview(PANE)).toBe('First answer')
    disk[FILE].body = Buffer.concat([v1, Buffer.from(J(assistant('a2', [{ type: 'text', text: 'Next answer' }], 9)) + '\n')])
    const next = await t.latestReply(PANE)
    expect(next?.text).toBe('Next answer')
    expect(next?.key).not.toBe(first?.key)
  })

  it('search() finds human and assistant text with absolute source offsets — not tool payloads', async () => {
    const u1 = user('u1', 'deploy the acme shop', 1)
    const a1 = assistant('a1', [{ type: 'text', text: 'acme deploy done' }], 5)
    const c2 = assistant('a2', [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'acme deploy' } }], 6)
    const r1 = out('r1', 'acme tool payload', 7)
    const v1 = body(sess('s1'), u1, a1, c2, r1)
    const offA1 = Buffer.byteLength(J(sess('s1'), u1) + '\n')
    const offU1 = Buffer.byteLength(J(sess('s1')) + '\n')
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    const t = mk(disk)
    const r = await t.search(PANE, 'acme', Date.now() + 5000)
    expect(r.kind).toBe('cmd')
    expect(r.limited).toBe(false)
    expect(r.hits.map(h => [h.role, h.text])).toEqual([['assistant', 'acme deploy done'], ['user', 'deploy the acme shop']])
    expect(r.hits.map(h => h.offset)).toEqual([offA1, offU1])
  })

  // The generation-bound view forwards the caller's deadline to physical
  // reads — a finite positive budget inside the request's deadline.
  it('search() forwards the caller deadline budget to physical reads', async () => {
    const disk: Record<string, MemFile> = { [FILE]: { body: body(sess('s1'), user('u1', 'acme one', 1), user('u2', 'acme two', 2)) } }
    const inner = memFs(disk)
    const timeouts: (number | undefined)[] = []
    const fs: MachineFs = {
      ...inner,
      read: async (p, s, l, timeoutMs) => { timeouts.push(timeoutMs); return inner.read(p, s, l, timeoutMs) },
    }
    const t = createTranscripts({ home: '/h', herdr: noHerdr, fs, locateCommandCode: async () => sel() })
    const deadline = Date.now() + 5000
    const r = await t.search(PANE, 'acme', deadline)
    expect(r.hits.map(h => h.text)).toEqual(['acme two', 'acme one'])
    expect(timeouts.length).toBeGreaterThan(0)
    for (const x of timeouts) {
      expect(x).toBeGreaterThan(0)
      expect(x).toBeLessThanOrEqual(5000)
    }
  })

  // A search window awaiting across an observed rewrite is another
  // transcript's — the generation-bound view rejects it.
  it('a search awaiting across an observed rewrite rejects', async () => {
    const v1 = body(sess('s1'), user('u1', 'acme one', 1))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    const gate = defer()
    const entered = defer()
    let arm = false
    const io: MemIo = {
      onRead: async (start, len) => {
        const snap = disk[FILE].body.subarray(start, start + len)
        if (arm) { arm = false; entered.resolve(); await gate.promise }
        return snap
      },
    }
    const t = mk(disk, io)
    arm = true
    const aP = t.search(PANE, 'acme', Date.now() + 5000)
    await entered.promise
    disk[FILE] = { body: body(sess('s1'), user('u9', 'acme two', 1)), mtimeMs: 9 }
    await t.chat(PANE2, {})
    gate.resolve()
    await expect(aP).rejects.toThrow('read unknown')
  })

  // A short window is unknown coverage, not a page of hits — the retry
  // serves the same bytes without a disk write.
  it('a short search window rejects as unknown — the retry serves the same bytes', async () => {
    const v1 = body(sess('s1'), user('u1', 'acme one', 1), user('u2', 'acme two', 2))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    let short = false
    const t = mk(disk, { onRead: (start, len) => short ? disk[FILE].body.subarray(start, start + len - 5) : undefined })
    short = true
    await expect(t.search(PANE, 'acme', Date.now() + 5000)).rejects.toThrow('read unknown')
    short = false
    const r = await t.search(PANE, 'acme', Date.now() + 5000)
    expect(r.hits.map(h => h.text)).toEqual(['acme two', 'acme one'])
  })

  it('image() re-reads an inline image by its line position, file-bound only', async () => {
    const disk: Record<string, MemFile> = { [FILE]: { body: body(sess('s1'), user('u1', 'q', 1), imgLine('a1')) } }
    const t = mk(disk)
    const r = await t.chat(PANE, {})
    const item = r.items!.find(i => i.images)!
    expect(item.ref).toMatch(/^\d+:\d+$/)
    const img = await t.image(PANE, r.file!, item.ref!, 0)
    expect(img!.type).toBe('image/png')
    expect(img!.body.equals(Buffer.from(PNG, 'base64'))).toBe(true)
    expect(await t.image(PANE, 'other.jsonl', item.ref!, 0)).toBeNull()
  })

  // Entry review: an unsafe extent is rejected before even the observation
  // — a warm file reads its watches inside observe; bad numbers start no IO.
  it('rejects an unsafe image ref before any IO — even on a warm watched file', async () => {
    const v1 = body(sess('s1'), call(), out('r1', 'old outcome'), imgLine('a1', 20))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    const stats = { n: 0 }
    const reads: { start: number, len: number }[] = []
    const t = mk(disk, { stats, reads })
    await t.chat(PANE, {})
    // An in-place grow would make the next observation validate by reading.
    disk[FILE].body = Buffer.concat([v1, Buffer.from(J(user('u2', 'more', 30)) + '\n')])
    reads.length = 0
    stats.n = 0
    expect(await t.image(PANE, 's1.jsonl', '9007199254740991:10', 0)).toBeNull()
    expect(stats.n).toBe(0)
    expect(reads).toEqual([])
  })

  // The caller-side live check: readExact's own guard runs before its
  // promise resolves; the caller resumes in a later continuation. A
  // rewrite observation queued in that gap (its stat continuation IS the
  // invalidation) detaches the bytes — the outer check catches it, without
  // it the stale image would publish.
  it('an image detached between the read guard and the caller serves nothing', async () => {
    const img = imgLine('a1')
    const v1 = body(sess('s1'), img)
    const v2 = body(sess('s1'), imgLine('b1', 20))
    expect(v2.length).toBe(v1.length) // same-size rewrite: stat sees another generation
    // The ref names exactly the image record — a whole-file ref spans the
    // session line too and never parses, masking the guard entirely.
    const imgOff = Buffer.byteLength(J(sess('s1'))) + 1
    const imgLen = Buffer.byteLength(J(img))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    const aRead = defer<Buffer>()
    const aEntered = defer()
    const bStat = defer<FsStat>()
    const bStatEntered = defer()
    let reads = 0
    let stats = 0
    const inner = memFs(disk)
    // The deferreds ARE the raw IO promises: resolving them queues the
    // awaiting continuation directly — release order alone sets the
    // queue order, no microtask shapes to count.
    const fs: MachineFs = {
      ...inner,
      read: (p, s, l) => {
        reads += 1
        if (reads === 1) { aEntered.resolve(); return aRead.promise }
        return inner.read(p, s, l)
      },
      stat: p => {
        stats += 1
        if (stats === 2) { bStatEntered.resolve(); return bStat.promise }
        return inner.stat(p)
      },
    }
    const t = createTranscripts({ home: '/h', herdr: noHerdr, fs, locateCommandCode: async () => sel() })
    const aP = t.image(PANE, 's1.jsonl', `${imgOff}:${imgLen}`, 0)
    await aEntered.promise // A's raw read is armed under the v1 generation
    disk[FILE] = { body: v2, mtimeMs: 9 }
    const bP = t.preview(PANE2) // B's observation stats the rewrite — gated
    await bStatEntered.promise
    // One hop each: A's read resolves with the bytes it armed, then B's
    // stat — B's post-stat continuation (replaced → fresh stamp) lands
    // between readExact's inner live check and the caller's continuation.
    aRead.resolve(v1.subarray(imgOff, imgOff + imgLen))
    bStat.resolve({ size: v2.length, mtimeMs: 9, isFile: true, isDir: false })
    await expect(aP).resolves.toBeNull()
    expect(await bP).toBe('here it is')
  })

  // An image read awaiting across an observed rewrite serves nothing —
  // a captured read detached in flight is unknown, not an image.
  it('an image read awaiting across an observed rewrite returns nothing', async () => {
    const v1 = body(sess('s1'), user('u1', 'q', 1), imgLine('a1'))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    const gate = defer()
    const entered = defer()
    let arm = false
    const t = mk(disk, {
      onRead: async (start, len) => {
        const snap = disk[FILE].body.subarray(start, start + len)
        if (arm) { arm = false; entered.resolve(); await gate.promise }
        return snap
      },
    })
    const r = await t.chat(PANE, {})
    const ref = r.items!.find(i => i.images)!.ref!
    arm = true
    const aP = t.image(PANE, r.file!, ref, 0)
    await entered.promise
    disk[FILE] = { body: body(sess('s1'), user('u9', 'fresh', 1)), mtimeMs: 9 }
    await t.chat(PANE2, {})
    gate.resolve()
    expect(await aP).toBeNull()
  })
})
