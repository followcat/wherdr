// The guarded Command Code reader through the public createTranscripts chat:
// generation-stamped tokens, cross-page outcomes, and the rewrite/short-read
// guards — fake disk and gated IO only, never a real fs/agent.
import { describe, expect, it } from 'vitest'
import { createTranscripts, type Loc, type TranscriptPane } from '../server/utils/transcripts'
import type { ChatResponse } from '../shared/types'
import { defer, memFs, type MemFile, type MemIo } from './cmdStateFixture'
import { assistant, J, results, sess, user } from './cmdParserFixture'

const FILE = '/home/alice/.commandcode/projects/-w/s1.jsonl'
const PANE: TranscriptPane = { id: 'p1', agent: 'cmd', cwd: '/w' }
const PANE2: TranscriptPane = { id: 'p2', agent: 'cmd', cwd: '/w' }
const noHerdr = (async () => { throw new Error('no Herdr') }) as never
const body = (...l: unknown[]) => Buffer.from(J(...l) + '\n')
const call = (id = 't1', ms = 5) => assistant('a1', [{ type: 'tool_use', id, name: 'read_file', input: {} }], ms)
const out = (id: string, content: unknown, ms = 10, tid = 't1') => results(id, [{ tool_use_id: tid, content }], ms)

const mk = (disk: Record<string, MemFile>, io?: MemIo) => createTranscripts({
  home: '/h', herdr: noHerdr, fs: memFs(disk, io),
  locateCommandCode: async () => ({ file: FILE, session: 's1' }),
})
const poll = (t: ReturnType<typeof createTranscripts>, token: string | undefined, from: number | undefined, pane = PANE) =>
  t.chat(pane, { since: token, from, anchor: token })
const stampOf = (token?: string) => /~s(\d+)~r/.exec(token ?? '')?.[1] ?? null

describe('Command Code reader', () => {
  it('serves a conversation, reports a cross-page outcome as toolUpdates, and applies it on the older page', async () => {
    const u2 = user('u2', 'while it runs', 8)
    const v1 = body(sess('s1'), user('u1', 'q', 1), call(), u2)
    const offU2 = Buffer.byteLength(J(sess('s1'), user('u1', 'q', 1), call()) + '\n')
    const disk = { [FILE]: { body: v1 } }
    const t = mk(disk)
    const r1 = await t.chat(PANE, {})
    expect(r1).toMatchObject({ available: true, file: 's1.jsonl', session: 's1' })
    expect(r1.token).toMatch(/~s\d+~r[a-z0-9]+\//)
    expect(r1.items!.map(i => i.role)).toEqual(['user', 'tool', 'user'])
    const res = out('r1', 'found it')
    disk[FILE].body = Buffer.concat([v1, Buffer.from(JSON.stringify(res) + '\n')])
    // The client's window starts below the call: the result is an orphan in
    // this parse — its update reports on the wire for the older page.
    const r2 = await poll(t, r1.token, offU2)
    expect(r2.toolUpdates).toEqual([{ id: 't1', at: v1.length, out: 'found it', error: false, images: 0, ref: '', imageAt: 0 }])
    expect(r2.items!.map(i => i.role)).toEqual(['user'])
    // The older page's call shows the shared outcome — cross-page through the
    // generation's map, not a re-parse of the result.
    const old = await t.chat(PANE, { before: offU2, since: r2.token })
    expect(old.older).toBe(true)
    expect(old.items!.find(i => i.toolId === 't1')).toMatchObject({ out: 'found it' })
  })

  // Review finding 1: an older page awaited across another client's observed
  // rewrite is a different transcript's — never returned.
  it('rejects an older page whose generation moved while its windows were awaited', async () => {
    const v1 = body(sess('s1'), user('u1', 'one', 1), user('u2', 'two', 2), user('u3', 'three', 3))
    const offU3 = Buffer.byteLength(J(sess('s1'), user('u1', 'one', 1), user('u2', 'two', 2)) + '\n')
    const disk = { [FILE]: { body: v1 } }
    const gate = defer()
    const entered = defer()
    let arm = false
    const io: MemIo = {
      onRead: async (start, len) => {
        // Captured BEFORE the gate: what resolves is genuinely the old bytes.
        const snap = disk[FILE].body.subarray(start, start + len)
        if (arm) { arm = false; entered.resolve(); await gate.promise }
        return snap
      },
    }
    const t = mk(disk, io)
    const first = await t.chat(PANE, {})
    arm = true
    const aP = t.chat(PANE, { before: offU3, since: first.token })
    await entered.promise
    // B observes an in-place rewrite while A's window pends — same session
    // file, new content (a /clear would be another file, not a header swap).
    disk[FILE] = { body: body(sess('s1'), user('u9', 'different session', 1)), mtimeMs: 9 }
    const b = await t.chat(PANE2, {})
    expect(b.items!.some(i => i.text === 'different session')).toBe(true)
    gate.resolve()
    await expect(aP).rejects.toThrow('read unknown')
    // B's next poll keeps its generation — A's stale read reached nothing.
    const again = await poll(t, b.token, b.start, PANE2)
    expect(again.rewritten).toBeUndefined()
  })

  // Review finding 2: a stale awaited read must never feed the retained
  // parser nor overwrite the fresh generation's Below after a purge.
  it('a stale awaited read cannot republish a Below over the fresh generation', async () => {
    const pad = 'x'.repeat(9 * 1024)
    const v1 = body(sess('s1'), call(), out('r1', 'old outcome'))
    const disk = { [FILE]: { body: v1 } }
    const gate = defer()
    const entered = defer()
    let arm = false
    const reads: { start: number, len: number }[] = []
    const io: MemIo = {
      reads,
      onRead: async (start, len) => {
        const snap = disk[FILE].body.subarray(start, start + len)
        if (arm) { arm = false; entered.resolve(); await gate.promise }
        return snap
      },
    }
    const t = mk(disk, io)
    const r1 = await t.chat(PANE, {})
    // A's incremental poll pends on the Below rebuild read.
    arm = true
    const aP = poll(t, r1.token, r1.start)
    await entered.promise
    // Another same-generation request on the same cursor: a grown file gives
    // it a different tail flight, so it reaches the bottom mutex and queues
    // behind A — still the old stamp.
    const queued = defer()
    disk[FILE].body = Buffer.concat([v1, Buffer.from(J(user('u1b', 'still old', 15)) + '\n')])
    io.onRead = () => { queued.resolve() }
    const aP2 = poll(t, r1.token, r1.start)
    await queued.promise
    // Let its whole microtask chain drain: `handle` binds while S1 is live,
    // then it sits on A's mutex — a genuinely stale request at the door.
    await new Promise(setImmediate)
    // B observes the rewrite, then builds its fresh retained bottom at the
    // same cursor key A is about to republish under.
    // In-place rewrite of the same session file: s1.jsonl keeps its own
    // header — replacing its id would simulate a different file (/clear).
    const v2 = body(sess('s1'), user('u2', pad, 1), call('t2'), out('r2', 'new outcome', 10, 't2'))
    disk[FILE] = { body: v2, mtimeMs: 9 }
    const b2 = await t.chat(PANE2, {})
    const fresh = await poll(t, b2.token, b2.start, PANE2)
    expect(fresh.items!.find(i => i.toolId === 't2')).toMatchObject({ out: 'new outcome' })
    gate.resolve()
    await expect(aP).rejects.toThrow('read unknown')
    // The queued stale request must reject at the door — never delete the
    // fresh entry before its own readExact can reject on the dead stamp.
    await expect(aP2).rejects.toThrow('generation changed')
    // Append on the fresh generation: B's retained bottom (with its >4 KiB
    // history) checks continuity by the two-read span — a destroyed-and-
    // rebuilt bottom would have been one read from the cursor's anchor.
    const extra = Buffer.from(J(user('u3', 'more', 30)) + '\n')
    const size = v2.length + extra.length
    disk[FILE].body = Buffer.concat([v2, extra])
    reads.length = 0
    const r3 = await poll(t, fresh.token, fresh.start, PANE2)
    expect(r3.rewritten).toBeUndefined()
    expect(r3.items!.some(i => i.text === 'more')).toBe(true)
    expect(r3.items!.find(i => i.toolId === 't2')).toMatchObject({ out: 'new outcome' })
    expect(stampOf(r3.token)).toBe(stampOf(b2.token))
    // The retained bottom's two-read continuity pattern (above + tail from
    // `end - CHECK_BYTES`), never A's stale one-read rebuild.
    expect(reads.some(r => r.start > 0 && r.start < size && r.start + r.len === size)).toBe(true)
    expect(reads.some(r => r.start === 0 && r.len === size)).toBe(false)
  })

  // Review finding 3: a short Below read is unknown coverage, not proof of a
  // rewrite — no epoch advance, no map loss, no false rewritten.
  it('a short retained-bottom read rejects without invalidating and the same generation recovers', async () => {
    const v1 = body(sess('s1'), call(), out('r1', 'kept'))
    const disk = { [FILE]: { body: v1 } }
    let short = false
    const io: MemIo = {
      // Only the full-span Below read (from the anchor at 0) goes short —
      // the observation's watch-span read stays whole.
      onRead: (start, len) =>
        short && start === 0 && len === disk[FILE].body.length ? disk[FILE].body.subarray(0, len - 20) : undefined,
    }
    const t = mk(disk, io)
    const r1 = await t.chat(PANE, {})
    await poll(t, r1.token, r1.start) // retains the Below
    disk[FILE].body = Buffer.concat([v1, Buffer.from(J(user('u2', 'appended', 20)) + '\n')])
    short = true
    // The body covers all of above/known but drops the end of the new tail:
    // unknown coverage — never a rewrite, never a cacheable partial page.
    await expect(poll(t, r1.token, r1.start)).rejects.toThrow('read unknown')
    short = false
    const r4 = await poll(t, r1.token, r1.start)
    expect(r4.rewritten).toBeUndefined()
    expect(stampOf(r4.token)).toBe(stampOf(r1.token)) // no epoch advance
    expect(r4.items!.some(i => i.text === 'appended')).toBe(true)
    expect(r4.items!.find(i => i.toolId === 't1')).toMatchObject({ out: 'kept' }) // outcome map intact
  })

  // Review finding 4: a valid unterminated line whose whole-bottom read
  // fails must reject — never fall back to the stale retained items.
  it('a short initial backward read is unknown — rejects, and a retry serves the whole file', async () => {
    const v1 = body(sess('s1'), user('u1', 'hello', 1), call())
    const disk = { [FILE]: { body: v1 } }
    let short = false
    const t = mk(disk, { onRead: (start, len) => short ? disk[FILE].body.subarray(start, start + Math.max(0, len - 40)) : undefined })
    short = true
    await expect(t.chat(PANE, {})).rejects.toThrow('read unknown')
    short = false
    const r = await t.chat(PANE, {})
    expect(r.items!.some(i => i.toolId === 't1')).toBe(true)
    // Nothing was cached as the full size: the token is a fresh, current one.
    const again = await poll(t, r.token, r.start)
    expect(again.items!.some(i => i.toolId === 't1')).toBe(true)
  })

  // Review finding 4: a complete JSON line without its newline takes the
  // whole-bottom readSlice — the SECOND read of this poll. The first (the
  // retained bottom's raw span) must see the valid line; only the slice
  // read fails, and its IO failure surfaces — never stale items.
  it('rejects when the whole-bottom slice read fails, then serves the line on the next poll', async () => {
    const whole = J(sess('s1'), user('u1', 'one', 1)) + '\n'
    const tail = JSON.stringify(user('u2', 'tail message', 2))
    const disk = { [FILE]: { body: Buffer.from(whole + tail) } }
    let n = 0
    let fail = false
    const t = mk(disk, { onRead: () => { if (fail && ++n === 2) throw new Error('slice read broke') } })
    const r1 = await t.chat(PANE, {})
    fail = true
    // n=1: the Below's raw span returns the appended unterminated line;
    // n=2: readSlice's whole-bottom read fails — the request rejects.
    await expect(poll(t, r1.token, r1.start)).rejects.toThrow('read unknown')
    fail = false
    // No new disk write: the same line is served from the same bytes.
    const r3 = await poll(t, r1.token, r1.start)
    expect(r3.items!.some(i => i.text === 'tail message')).toBe(true)
  })

  // Review finding 5: the backward reader never issues a window past the
  // remaining MAX_READ_BYTES span — a 25 MiB line is not parsed by overshoot.
  it('never reads past the remaining span — a line beyond the cap is not parsed', async () => {
    const CAP = 24 * 1024 * 1024
    const pre = body(sess('s1'))
    const disk = { [FILE]: { body: Buffer.concat([pre, Buffer.alloc(25 * 1024 * 1024, 120), Buffer.from('\n')]) } }
    const lens: { start: number, len: number }[] = []
    const t = mk(disk, { onRead: (start, len) => { lens.push({ start, len }) } })
    const r = await t.chat(PANE, {})
    expect(r.items).toEqual([])
    // Every issued window stays within the cap: the largest logical span is
    // 24 MiB — each read may ask one extra lookback byte for the line-start
    // check, and widening re-reads overlap, so bytes transferred can be more.
    expect(Math.max(...lens.map(x => x.len))).toBeLessThanOrEqual(CAP + 1)
    expect(Math.min(...lens.map(x => x.start))).toBeGreaterThanOrEqual(disk[FILE].body.length - CAP - 1)
  })

  // Reply contexts are reader-local: a reply bound by another
  // createTranscripts — or no reader at all — can never authorize through
  // this one. An available Command Code reply whose context is unknown
  // fails closed; other agents keep "nothing to check".
  it('never authorizes a reply bound by a foreign or unknown reader', async () => {
    const FILE2 = '/home/alice/.commandcode/projects/-w/s2.jsonl'
    const disk = { [FILE]: { body: body(sess('s1'), user('u1', 'q', 1)) }, [FILE2]: { body: body(sess('s2'), user('u2', 'q', 1)) } }
    const locate = async (): Promise<Loc | null> => ({ file: FILE, session: 's1' })
    const t1 = createTranscripts({ home: '/h', herdr: noHerdr, fs: memFs(disk), locateCommandCode: locate })
    const t2 = createTranscripts({ home: '/h', herdr: noHerdr, fs: memFs(disk), locateCommandCode: locate })
    const r2 = await t2.chat(PANE, {}) // same file, same stamp numbers
    expect(await t1.current(PANE, r2)).toBe('gone')
    expect(t1.live(PANE, r2)).toBe(false)
    const r1 = await t1.chat(PANE, {})
    expect(await t1.current(PANE, r1)).toBe('ok')
    expect(t1.live(PANE, r1)).toBe(true)
    const bare = { available: true, file: 'x.jsonl' } as ChatResponse
    expect(await t1.current(PANE, bare)).toBe('gone')
    expect(t1.live(PANE, bare)).toBe(false)
    const other: TranscriptPane = { id: 'p9', agent: 'claude', cwd: '/w' }
    expect(await t1.current(other, bare)).toBeNull()
    expect(t1.live(other, bare)).toBeNull()
  })

  // A lookup started before forget holds a ticket that can never be
  // reissued: its late FILE1 answer cannot overwrite the newer FILE2
  // observation. With selection evidence unknown (post-forget) a bound
  // reply fails closed — FILE1's stamp stays live throughout (its
  // generation was never invalidated), so the selection guard is what
  // keeps it unpublishable.
  it('keeps a bound reply unpublishable through forget and a late stale lookup', async () => {
    const FILE2 = '/home/alice/.commandcode/projects/-w/s2.jsonl'
    const disk = { [FILE]: { body: body(sess('s1'), user('u1', 'q', 1)) }, [FILE2]: { body: body(sess('s2'), user('u2', 'q', 1)) } }
    let cur: Loc | null = { file: FILE, session: 's1' }
    let gated = false
    const started = defer()
    const g = defer()
    const t = createTranscripts({
      home: '/h', herdr: noHerdr, fs: memFs(disk),
      locateCommandCode: async () => { if (gated) { started.resolve(); await g.promise; return { file: FILE, session: 's1' } } return cur },
    })
    const rA = await t.chat(PANE, {})
    expect(t.live(PANE, rA)).toBe(true)
    gated = true
    const old = t.locate(PANE) // a lookup that started before forget
    await started.promise
    t.forget('p1')
    expect(t.live(PANE, rA)).toBe(false) // selection evidence unknown: closed
    gated = false
    cur = { file: FILE2, session: 's2' }
    await t.locate(PANE) // the newer lookup observes FILE2
    g.resolve()
    expect(await old).toEqual({ file: FILE, session: 's1' })
    expect(t.live(PANE, rA)).toBe(false) // the late FILE1 never overwrote FILE2
  })
})
