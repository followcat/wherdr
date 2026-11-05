// The guarded Command Code reader through the public createTranscripts chat:
// generation-stamped tokens, cross-page outcomes, and the rewrite/short-read
// guards — fake disk and gated IO only, never a real fs/agent.
import { describe, expect, it, vi } from 'vitest'
import { createTranscripts, type Loc, type TranscriptPane } from '../server/utils/transcripts'
import type { ChatResponse } from '../shared/types'
import { defer, memFs, type MemFile, type MemIo } from './cmdStateFixture'
import { assistant, at, J, results, sess, user } from './cmdParserFixture'

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

  // A result older than the window reports as a toolUpdates revision —
  // images and the record's own ref included — and a later empty success
  // clears the outcome instead of preserving it. An older page that
  // re-parses the superseded record can never downgrade the shared map:
  // the newest absolute revision wins whichever order pages arrived in.
  it('carries a late image outcome, then an empty success clears it — an older page cannot downgrade', async () => {
    const ownImg = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(9000) } }
    const resImg = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(9000) } }
    const u2 = user('u2', 'while it runs', 8)
    const v1 = body(sess('s1'), user('u1', 'q', 1), call(), u2)
    const offU2 = Buffer.byteLength(J(sess('s1'), user('u1', 'q', 1), call()) + '\n')
    const disk = { [FILE]: { body: v1 } }
    const t = mk(disk)
    const r1 = await t.chat(PANE, {})
    // One own image before the result's: the result's image is imageAt 1.
    const res1 = JSON.stringify({
      type: 'message', id: 'r1', parentId: null, timestamp: at(10),
      message: { role: 'user', meta: { source: 'tool', createdAt: 1700000000010 },
        content: [ownImg, { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'first' }, resImg] }] },
    })
    const res1Off = v1.length
    const res1Len = Buffer.byteLength(res1)
    disk[FILE].body = Buffer.concat([v1, Buffer.from(res1 + '\n')])
    const r2 = await poll(t, r1.token, offU2)
    expect(r2.toolUpdates).toEqual([{ id: 't1', at: res1Off, out: 'first', error: false, images: 1, ref: `${res1Off}:${res1Len}`, imageAt: 1 }])
    // The update's own ref+imageAt publicly selects the RESULT's image
    // bytes, not the own image the line carried before it.
    const picked = await t.image(PANE, r2.file!, r2.toolUpdates![0]!.ref!, r2.toolUpdates![0]!.imageAt)
    expect(picked).toMatchObject({ type: 'image/png' })
    expect(picked!.body).toEqual(Buffer.from('B'.repeat(9000), 'base64'))
    // The result directly before the empty success carries BOTH error and
    // image — the later clear then proves removal, not absence.
    const res2 = JSON.stringify({
      type: 'message', id: 'r2', parentId: null, timestamp: at(11),
      message: { role: 'user', meta: { source: 'tool', createdAt: 1700000000011 },
        content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'boom' }, resImg] }] },
    })
    const res2Off = res1Off + res1Len + 1
    const res2Len = Buffer.byteLength(res2)
    disk[FILE].body = Buffer.concat([disk[FILE].body, Buffer.from(res2 + '\n')])
    const r3 = await poll(t, r2.token, offU2)
    expect(r3.toolUpdates).toEqual([{ id: 't1', at: res2Off, out: 'boom', error: true, images: 1, ref: `${res2Off}:${res2Len}`, imageAt: 0 }])
    // The older page re-parses res1's record but the shared map keeps res2.
    const old = await t.chat(PANE, { before: res2Off, since: r3.token })
    expect(old.older).toBe(true)
    const callItem = old.items!.find(i => i.toolId === 't1')!
    expect(callItem).toMatchObject({ out: 'boom', error: true, images: 1, ref: `${res2Off}:${res2Len}` })
    // An empty success is a complete replacement: it clears, not preserves.
    const res3 = out('r3', '', 12)
    disk[FILE].body = Buffer.concat([disk[FILE].body, Buffer.from(JSON.stringify(res3) + '\n')])
    const r4 = await poll(t, r3.token, offU2)
    expect(r4.toolUpdates).toEqual([{ id: 't1', at: res2Off + res2Len + 1, out: '', error: false, images: 0, ref: '', imageAt: 0 }])
    const old2 = await t.chat(PANE, { before: res2Off, since: r4.token })
    const cleared = old2.items!.find(i => i.toolId === 't1')!
    expect(cleared.out).toBeUndefined()
    expect(cleared.error).toBeUndefined()
    expect(cleared.images).toBeUndefined()
    expect(cleared.ref).toBeUndefined()
    expect(cleared.imageAt).toBeUndefined()
    expect(cleared.hashes).toBeUndefined()
  })

  // The retained bottom is incremental: appended lines parse alone — an
  // old record is never JSON-parsed again — and a record whose newline has
  // not landed waits for the next poll.
  it('parses only appended lines, and a partial record completes next poll', async () => {
    const v1 = body(sess('s1'), user('u1', 'uniq-marker-1', 1))
    const disk = { [FILE]: { body: v1 } }
    const t = mk(disk)
    // An explicit cursor warms the retained bottom (a null `from` walks
    // backwards and retains nothing): later polls feed appends only.
    const r1 = await t.chat(PANE, { from: 0 })
    const spy = vi.spyOn(JSON, 'parse')
    try {
      const u2 = JSON.stringify(user('u2', 'second', 2))
      disk[FILE].body = Buffer.concat([v1, Buffer.from(u2 + '\n')])
      const r2 = await poll(t, r1.token, r1.start)
      expect(r2.items!.some(i => i.text === 'second')).toBe(true)
      // The marker lives inside the first record: re-parsing it would show.
      expect(spy.mock.calls.filter(c => String(c[0]).includes('uniq-marker-1'))).toEqual([])
      const u3 = JSON.stringify(user('u3', 'partial-xy', 3))
      disk[FILE].body = Buffer.concat([disk[FILE].body, Buffer.from(u3.slice(0, 30))])
      const r3 = await poll(t, r2.token, r1.start)
      expect(r3.items!.some(i => i.text === 'partial-xy')).toBe(false)
      disk[FILE].body = Buffer.concat([disk[FILE].body, Buffer.from(u3.slice(30) + '\n')])
      const r4 = await poll(t, r3.token, r1.start)
      expect(r4.items!.some(i => i.text === 'partial-xy')).toBe(true)
    } finally { spy.mockRestore() }
  })

  // Every public reset shape reaches the same contract: the stale token
  // answers a rewritten fresh bottom — never older:true — under a new stamp.
  it('resets public clients on truncate, inode, same-size rewrite and a watched-result edit', async () => {
    const v1 = body(sess('s1'), user('u1', 'q', 1), call(), out('r1', 'watched'), user('u2', 'tail one', 12))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    const t = mk(disk)
    let r = await t.chat(PANE, {})
    let prevStamp = stampOf(r.token)
    const fresh = async (want: { text?: string, out?: string }) => {
      r = await poll(t, r.token, r.start)
      expect(r.rewritten).toBe(true)
      expect(r.older).toBeUndefined()
      // Each reset mints a new positive stamp — an anchor-only client reset
      // could not mask a missing cross-client generation invalidation.
      const stamp = Number(stampOf(r.token))
      expect(stamp).toBeGreaterThan(Number(prevStamp))
      prevStamp = stampOf(r.token)
      if (want.text !== undefined) expect(r.items!.some(i => i.text === want.text)).toBe(true)
      if (want.out !== undefined) expect(r.items!.find(i => i.toolId === 't1')).toMatchObject({ out: want.out })
    }
    // Shorter than the generation's trusted size (the client's from cursor
    // is 0 — the file is still longer than it): reset.
    disk[FILE] = { body: v1.subarray(0, v1.length - 30), mtimeMs: 5 }
    await fresh({ text: 'q' })
    // Same bytes under another inode: another file's generation.
    disk[FILE] = { body: v1, mtimeMs: 5, ino: 4242 }
    await fresh({ out: 'watched' })
    // Same size, same inode, same session header, different content — the
    // realistic rewrite shape: content identity wins, not the header.
    const v2 = body(sess('s1'), user('u1', 'q', 1), call(), out('r1', 'watched'), user('u2', 'tail two', 12))
    expect(v2.length).toBe(v1.length)
    disk[FILE] = { body: v2, mtimeMs: 9, ino: 4242 }
    await fresh({ text: 'tail two' })
    // Same inode again: an in-place edit of a watched result record plus
    // growth — the result watch catches what a pure size check cannot.
    const resOff = Buffer.byteLength(J(sess('s1'), user('u1', 'q', 1), call()) + '\n')
    const resLine = Buffer.byteLength(JSON.stringify(out('r1', 'watched')))
    const edited = Buffer.from(JSON.stringify(out('r1', 'xatched')) + '\n')
    expect(edited.length).toBe(resLine + 1)
    disk[FILE] = { body: Buffer.concat([v2.subarray(0, resOff), edited, v2.subarray(resOff + resLine + 1), Buffer.from(J(user('u3', 'appended', 15)) + '\n')]), mtimeMs: 12, ino: 4242 }
    await fresh({ out: 'xatched' })
  })

  // One client's stale proof cannot regress another client's state: an old
  // token replays into a fresh bottom of the CURRENT generation — it mints
  // nothing and never serves older:true. The remembered outcome must
  // survive the replay itself: the shared map's NEWER result sits outside
  // the fresh bottom's window, so the response can only carry it from the
  // map, not from re-parsing the record — and an older page ending before
  // it still shows it over the page's own older result. The raw anchor
  // alone (since forgotten) is no better proof.
  it('a stale token cannot downgrade another client nor mint a generation', async () => {
    const callLine = call()
    const rold = out('rold', 'old out', 8)
    const rnew = out('rnew', 'new out', 9)
    const roldOff = Buffer.byteLength(J(sess('s1'), user('u1', 'q', 1), callLine) + '\n')
    const rnewOff = roldOff + Buffer.byteLength(JSON.stringify(rold)) + 1
    const v1 = body(sess('s1'), user('u1', 'q', 1), callLine, rold, rnew)
    const reads: { start: number, len: number }[] = []
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    const t = mk(disk, { reads })
    // A's token belongs to the previous generation: same-size rewrite.
    const rA = await t.chat(PANE, {})
    const v2 = body(sess('s1'), user('u1', 'w', 1), callLine, rold, rnew)
    expect(v2.length).toBe(v1.length)
    disk[FILE] = { body: v2, mtimeMs: 9 }
    // B learns 'new out' into the current generation while the file is small.
    const rB = await t.chat(PANE2, {})
    expect(stampOf(rB.token)).not.toBe(stampOf(rA.token))
    // A visible tail of distinct items, both deeper than one bottom window
    // and dense enough that its last slice is already a full bottom: the
    // remembered result now sits outside what a fresh bottom reaches.
    const tail = Buffer.from(Array.from({ length: 160 }, (_, i) => J(user(`t${i}`, `tail ${i} ` + 'x'.repeat(14 * 1024), 20 + i))).join('\n') + '\n')
    disk[FILE].body = Buffer.concat([v2, tail])
    const b2 = await poll(t, rB.token, rB.start, PANE2)
    expect(b2.rewritten).toBeUndefined()
    expect(stampOf(b2.token)).toBe(stampOf(rB.token)) // growth mints nothing
    // No disk mutation: A's stale replay serves the current generation's
    // fresh bottom — it must mint nothing and must not re-read 'rnew'.
    const spy = vi.spyOn(JSON, 'parse')
    const rnewParses = () => spy.mock.calls.filter(c => String(c[0]).includes('"id":"rnew"')).length
    spy.mockClear()
    reads.length = 0
    const a2 = await t.chat(PANE, { anchor: rA.token, from: rA.start })
    expect(a2.rewritten).toBe(true)
    expect(a2.older).toBeUndefined()
    expect(stampOf(a2.token)).toBe(stampOf(b2.token)) // same generation, not a new one
    expect(rnewParses()).toBe(0)
    // Geometry: every content window began after the remembered record
    // (only the session probe may read from 0), and the bottom's items are
    // all from the tail — never u1, the call or either result.
    expect(reads.filter(r => r.start > 0).every(r => r.start >= rnewOff + Buffer.byteLength(JSON.stringify(rnew)) + 1)).toBe(true)
    expect(a2.items!.some(i => i.toolId === 't1')).toBe(false)
    expect(a2.items!.some(i => i.text === 'w')).toBe(false)
    // An older page ending BEFORE rnew but covering the call and rold: the
    // page's own parse offers 'old out' — the remembered map still wins.
    const old = await t.chat(PANE, { before: rnewOff, since: a2.token })
    expect(old.older).toBe(true)
    expect(old.items!.find(i => i.toolId === 't1')).toMatchObject({ out: 'new out' })
    // The raw anchor alone (since forgotten) is no better proof: same fresh
    // bottom, never an older page.
    const a3 = await t.chat(PANE, { before: rnewOff, anchor: rA.token })
    expect(a3.older).toBeUndefined()
    expect(a3.rewritten).toBe(true)
    spy.mockRestore()
  })

  // A reader restart drops every map: the nonce in new tokens differs and a
  // token of the previous process is foreign proof. The file table is
  // bounded at 64: the oldest file's record evicts, so its next read mints
  // a new stamp — an unrelated still-retained file stays current.
  it('changes the reader nonce on restart and the stamp past the 64-file bound', async () => {
    const v1 = body(sess('s1'), user('u1', 'q', 1))
    const disk = { [FILE]: { body: v1 } }
    const t1 = mk(disk)
    const r1 = await t1.chat(PANE, {})
    const t2 = mk(disk)
    const r2 = await t2.chat(PANE, {})
    expect(/~r([a-z0-9]+)/.exec(r2.token!)![1]).not.toBe(/~r([a-z0-9]+)/.exec(r1.token!)![1])
    const stale = await poll(t2, r1.token, r1.start)
    expect(stale.rewritten).toBe(true) // the old process's proof is foreign
    // Sixty-five distinct files through the real table: ev1 evicts.
    const many: Record<string, MemFile> = {}
    const pathOf = (id: string) => `/home/alice/.commandcode/projects/-w/${id}.jsonl`
    for (let i = 1; i <= 65; i++) many[pathOf(`e${i}`)] = { body: body(sess(`e${i}`), user(`u${i}`, `file ${i}`, 1)) }
    const t3 = createTranscripts({
      home: '/h', herdr: noHerdr, fs: memFs(many),
      locateCommandCode: async p => ({ file: pathOf(p.id), session: p.id }),
    })
    const kept = new Map<string, string>()
    const evPane = (id: string): TranscriptPane => ({ id, agent: 'cmd', cwd: '/w' })
    for (let i = 1; i <= 65; i++) {
      const r = await t3.chat(evPane(`e${i}`), {})
      kept.set(`e${i}`, r.token!)
    }
    const evicted = await t3.chat(evPane('e1'), { since: kept.get('e1')!, anchor: kept.get('e1')! })
    expect(evicted.rewritten).toBe(true)
    const current = await t3.chat(evPane('e40'), { since: kept.get('e40')!, anchor: kept.get('e40')! })
    expect(current.unchanged).toBe(true)
  })

  // A backward window whose raw buffer begins inside a large preceding
  // record: the result after it is the first parsed line of a buffer that
  // starts BEFORE it — its watch must fingerprint the real record bytes,
  // not an offset shifted to the aligned start. A second client whose list
  // starts past the 9-KiB pad can never re-check those bytes (its 4-KiB
  // anchor and its retained check cover the tail only): growth keeps its
  // stamp — a fingerprint based on the aligned start instead of the raw
  // buffer's would fail right there — and an in-place edit of the watched
  // result still detaches its token.
  it('a result watched through a nonaligned window still detaches old clients on an in-place edit', async () => {
    const big = user('ub', 'x'.repeat(2300 * 1024), 4)
    const res = out('r1', 'watched-result-content', 6)
    const pad = user('u3', 'pad ' + 'y'.repeat(9 * 1024), 8)
    const pre = J(sess('s1'), user('u1', 'q', 1), call(), big) + '\n'
    const resOff = Buffer.byteLength(pre)
    const resLen = Buffer.byteLength(JSON.stringify(res))
    const resEnd = resOff + resLen + 1
    const v1 = body(sess('s1'), user('u1', 'q', 1), call(), big, res, pad)
    const reads: { start: number, len: number }[] = []
    const disk = { [FILE]: { body: v1 } }
    const t = mk(disk, { reads })
    // An older page exists only under live proof — mint a token first.
    const first = await t.chat(PANE, {})
    reads.length = 0
    const page = await t.chat(PANE, { before: v1.length, since: first.token })
    expect(page.older).toBe(true)
    expect(page.items!.find(i => i.toolId === 't1')).toMatchObject({ out: 'watched-result-content' })
    // The first window's buffer began inside the big record — a positive
    // read start before the result's offset, not a full-file aligned read.
    expect(reads.some(r => r.start > 0 && r.start < resOff)).toBe(true)
    // The second client's list starts at the old file end (after the pad):
    // its anchor above and its retained check can cover the tail only.
    const extra = Buffer.from(J(user('u4', 'fresh tail', 10)) + '\n')
    disk[FILE].body = Buffer.concat([v1, extra])
    const r2 = await t.chat(PANE2, { from: v1.length })
    expect(r2.rewritten).toBeUndefined()
    // Pure growth minted nothing: still the first client's generation — a
    // wrongly-based fingerprint would already have forced a new stamp.
    expect(stampOf(r2.token)).toBe(stampOf(first.token))
    const same = await poll(t, r2.token, v1.length, PANE2)
    expect(same.unchanged).toBe(true)
    // An in-place edit of the watched record plus growth: the second
    // client's token detaches even though its own checks cannot see it.
    const res2 = Buffer.from(JSON.stringify(out('r1', 'xatched-result-content', 6)) + '\n')
    expect(res2.length).toBe(resLen + 1)
    disk[FILE] = { body: Buffer.concat([v1.subarray(0, resOff), res2, v1.subarray(resEnd), extra, Buffer.from(J(user('u5', 'later', 11)) + '\n')]), mtimeMs: 9 }
    const det = await poll(t, r2.token, v1.length, PANE2)
    expect(det.rewritten).toBe(true)
    expect(det.older).toBeUndefined()
    expect(stampOf(det.token)).not.toBe(stampOf(r2.token))
  })
})
