// Command Code metadata through the public createTranscripts API: the
// generation-bound model and the guarded-chat preview fallback — fake
// disk and gated IO only, never a real fs/agent.
import { describe, expect, it } from 'vitest'
import { createTranscripts, type Loc, type TranscriptPane } from '../server/utils/transcripts'
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
})
