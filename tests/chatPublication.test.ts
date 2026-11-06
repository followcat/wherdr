// The actual /api/chat handler must never publish a Command Code response
// whose generation detached during the route's own postprocessing (upload
// hashes, model lookup, even its revalidation promise): an observed rewrite
// makes the already-read items and token another transcript's. Real handler,
// real createTranscripts, fake disk and stubbed ordinary route globals only.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTranscripts, type Loc, type TranscriptPane } from '../server/utils/transcripts'
import type { ChatItem, ChatResponse } from '../shared/types'
import { defer, memFs, type MemFile, type MemIo } from './cmdStateFixture'
import { at, assistant, J, sess, user } from './cmdParserFixture'

const FILE = '/home/alice/.commandcode/projects/-w/s1.jsonl'
const FILE2 = '/home/alice/.commandcode/projects/-w/s2.jsonl'
const PANE: TranscriptPane = { id: 'p1', agent: 'cmd', cwd: '/w' }
const noHerdr = (async () => { throw new Error('no Herdr') }) as never
const body = (...l: unknown[]) => Buffer.from(J(...l) + '\n')
const mc = (model: string, ms = 0) => ({ type: 'model_change', id: `mc-${ms}`, parentId: null, timestamp: at(ms), model })
const text = (id: string, t: string, ms = 5) => assistant(id, [{ type: 'text', text: t }], ms)

const texts = (items: ChatItem[] | undefined) => (items || []).map(i => i.text)
type Transcripts = ReturnType<typeof createTranscripts>

// The state.ts facade shape the route sees: chat/current awaited, live
// synchronous — all reaching the same owning reader.
const wire = (t: Transcripts) => ({
  chat: (p: TranscriptPane, o?: Parameters<Transcripts['chat']>[1]) => t.chat(p, o),
  current: (p: TranscriptPane, r: ChatResponse) => t.current(p, r),
  live: (p: TranscriptPane, r: ChatResponse) => t.live(p, r),
})

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

// The real handler under test, with every route global stubbed except the
// real transcripts instance (behind the facade shape) and the real
// chatDelta module (imported by the route). Tests stub `addUploadHashes`
// themselves to gate post-chat work.
function handler(disk: Record<string, MemFile>, opts: { locate?: () => Promise<Loc | null>, query?: Record<string, unknown>, io?: MemIo, t?: Transcripts } = {}) {
  const t = opts.t ?? createTranscripts({ home: '/h', herdr: noHerdr, fs: memFs(disk, opts.io), locateCommandCode: opts.locate ?? (async () => ({ file: FILE, session: 's1' })) })
  vi.stubGlobal('defineApi', (h: unknown) => h)
  vi.stubGlobal('getQuery', () => opts.query ?? { pane: 'p1' })
  vi.stubGlobal('findPane', () => PANE)
  vi.stubGlobal('HerdrError', class extends Error { constructor(public code: string, m: string) { super(m) } })
  vi.stubGlobal('takenBackOf', () => ({ hidden: [], seq: 0 }))
  vi.stubGlobal('withoutTakenBack', (items: unknown) => items)
  vi.stubGlobal('chatPasted', (items: unknown) => items)
  vi.stubGlobal('transcripts', wire(t))
  vi.stubGlobal('currentModel', async (p: TranscriptPane) => t.model(p))
  return { t, run: async () => (await import('../server/api/chat.get')).default({}) as Promise<any> }
}

describe('/api/chat Command Code publication', () => {
  // The gap: chat's own final live check ran before the route's awaited
  // upload-hash step; the model call then observes the rewrite and
  // invalidates — the route would publish the old body/token anyway.
  it('never publishes items detached between chat and the model lookup', async () => {
    const v1 = body(sess('s1'), user('u1', 'old question', 1), text('a1', 'old answer'), mc('example/model-a', 6))
    const v2 = body(sess('s1'), user('u1', 'new question', 1), text('a1', 'new answer'), mc('example/model-b', 6))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    const gate = defer()
    const entered = defer()
    const { run } = handler(disk)
    vi.stubGlobal('addUploadHashes', () => { entered.resolve(); return gate.promise })
    const p = run()
    await entered.promise
    // A rewrite lands while the route is inside its post-chat await.
    disk[FILE] = { body: v2, mtimeMs: 9 }
    gate.resolve()
    const r = await p
    // The stale body is not what the file says now: one bounded re-issue
    // publishes the generation the model call observed instead.
    expect(texts(r.items)).toContain('new answer')
    expect(texts(r.items)).not.toContain('old answer')
    expect(String(r.token)).toContain('~s2~r')
    expect(r.model?.id).toBe('example/model-b')
  })

  // The awaited selection check's own continuation is still a gap: a real
  // rewrite observed just before its verdict resolves must not slip past —
  // the synchronous predicate after every await is the last word.
  it('catches a rewrite observed inside the revalidation continuation', async () => {
    const v1 = body(sess('s1'), user('u1', 'q', 1), text('a1', 'old answer'), mc('example/model-a', 6))
    const v2 = body(sess('s1'), user('u1', 'q', 1), text('a1', 'new answer'), mc('example/model-b', 6))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    const t = createTranscripts({ home: '/h', herdr: noHerdr, fs: memFs(disk), locateCommandCode: async () => ({ file: FILE, session: 's1' }) })
    const { run } = handler(disk, { t })
    // Wrap the real service method: the fake-disk rewrite and a real
    // observed invalidation are enqueued just before its verdict returns —
    // an ordinary test wrapper, no mocked verdict, no production seam.
    vi.stubGlobal('transcripts', {
      ...wire(t),
      current: async (p: TranscriptPane, r: ChatResponse) => {
        const c = await t.current(p, r)
        disk[FILE] = { body: v2, mtimeMs: 9 }
        await t.chat(PANE, {}) // its observe lands the invalidation
        return c
      },
    })
    vi.stubGlobal('addUploadHashes', () => {})
    const r = await run()
    expect(texts(r.items)).toContain('new answer')
    expect(String(r.token)).toContain('~s2~r')
    expect(r.model?.id).toBe('example/model-b')
  })

  // A selection move observed between the selection verdict and the
  // route's continuation voids the reply even while its stamp stays live:
  // the synchronous predicate joins generation liveness with the latest
  // observed selection evidence.
  it('catches a selection moved and observed inside the revalidation continuation', async () => {
    const v1 = body(sess('s1'), user('u1', 'q', 1), text('a1', 'old answer'), mc('example/model-a', 6))
    const v2 = body(sess('s2'), user('u2', 'q', 1), text('a2', 'z answer'), mc('example/model-z', 3))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 }, [FILE2]: { body: v2 } }
    let cur: Loc | null = { file: FILE, session: 's1' }
    const t = createTranscripts({ home: '/h', herdr: noHerdr, fs: memFs(disk), locateCommandCode: async () => cur })
    const { run } = handler(disk, { t })
    // Wrap the real method: after its verdict, the fake selection moves
    // and a real model lookup observes it before the verdict returns.
    vi.stubGlobal('transcripts', {
      ...wire(t),
      current: async (p: TranscriptPane, r: ChatResponse) => {
        const c = await t.current(p, r)
        cur = { file: FILE2, session: 's2' }
        await t.model(p) // its locate observes the new selection
        return c
      },
    })
    vi.stubGlobal('addUploadHashes', () => {})
    const r = await run()
    expect(texts(r.items)).not.toContain('old answer')
    expect(texts(r.items)).toContain('z answer')
    expect(r.file).toBe('s2.jsonl')
    expect(r.model?.id).toBe('example/model-z')
  })

  it('answers unavailable when identity is lost inside the revalidation continuation', async () => {
    const v1 = body(sess('s1'), user('u1', 'q', 1), text('a1', 'old answer'), mc('example/model-a', 6))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    let cur: Loc | null = { file: FILE, session: 's1' }
    const t = createTranscripts({ home: '/h', herdr: noHerdr, fs: memFs(disk), locateCommandCode: async () => cur })
    const { run } = handler(disk, { t })
    vi.stubGlobal('transcripts', {
      ...wire(t),
      current: async (p: TranscriptPane, r: ChatResponse) => {
        const c = await t.current(p, r)
        cur = null
        await t.model(p)
        return c
      },
    })
    vi.stubGlobal('addUploadHashes', () => {})
    const r = await run()
    expect(r).toEqual({ available: false, reason: 'not_found' })
  })

  // A moved selection during the second lookup must not authorize the
  // prior selection's response — the authoritative unavailable contract.
  it('answers unavailable when the selected file moved during postprocessing', async () => {
    const v1 = body(sess('s1'), user('u1', 'q', 1), text('a1', 'old answer'), mc('example/model-a', 6))
    const disk: Record<string, MemFile> = {
      [FILE]: { body: v1 },
      [FILE2]: { body: body(sess('s2'), user('u2', 'q', 1), mc('example/model-z', 2)) },
    }
    const gate = defer()
    const entered = defer()
    let cur: Loc | null = { file: FILE, session: 's1' }
    const { run } = handler(disk, { locate: async () => cur })
    vi.stubGlobal('addUploadHashes', () => { entered.resolve(); return gate.promise })
    const p = run()
    await entered.promise
    cur = { file: FILE2, session: 's2' }
    gate.resolve()
    const r = await p
    expect(r).toEqual({ available: false, reason: 'not_found' })
  })

  it('answers unavailable when identity is lost during postprocessing', async () => {
    const v1 = body(sess('s1'), user('u1', 'q', 1), text('a1', 'old answer'), mc('example/model-a', 6))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    const gate = defer()
    const entered = defer()
    let cur: Loc | null = { file: FILE, session: 's1' }
    const { run } = handler(disk, { locate: async () => cur })
    vi.stubGlobal('addUploadHashes', () => { entered.resolve(); return gate.promise })
    const p = run()
    await entered.promise
    cur = null
    gate.resolve()
    const r = await p
    expect(r).toEqual({ available: false, reason: 'not_found' })
  })

  // A file that keeps rewriting through the bounded retry fails closed —
  // a read error, never the detached body. Same-size rewrites: an append
  // would be the same generation growing, not a detach.
  it('fails closed when the file keeps changing across the bounded retry', async () => {
    const v1 = body(sess('s1'), user('u1', 'q', 1), text('a1', 'first answer'), mc('example/model-a', 6))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    const g1 = defer()
    const g2 = defer()
    const e1 = defer()
    const e2 = defer()
    let n = 0
    const { run } = handler(disk)
    vi.stubGlobal('addUploadHashes', () => {
      n += 1
      if (n === 1) { e1.resolve(); return g1.promise }
      if (n === 2) { e2.resolve(); return g2.promise }
    })
    const p = run()
    await e1.promise
    disk[FILE] = { body: body(sess('s1'), user('u1', 'q', 1), text('a1', 'secon answer'), mc('example/model-b', 6)), mtimeMs: 9 }
    g1.resolve()
    await e2.promise
    disk[FILE] = { body: body(sess('s1'), user('u1', 'q', 1), text('a1', 'third answer'), mc('example/model-c', 6)), mtimeMs: 10 }
    g2.resolve()
    await expect(p).rejects.toThrow('generation changed')
  })

  // Older pages bind the same response context even without a token: a
  // rewrite observed during postprocessing detaches them too — the
  // re-issue is a rewritten fresh bottom, never an older page of the
  // wrong transcript.
  it('resets an older page detached during postprocessing', async () => {
    const v1 = body(sess('s1'), user('u1', 'q1', 1), user('u2', 'q2', 2), text('a1', 'a page'), mc('example/model-a', 6))
    const v2 = body(sess('s1'), user('u1', 'new page', 1), text('a1', 'new content'), mc('example/model-b', 6))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    const t = createTranscripts({ home: '/h', herdr: noHerdr, fs: memFs(disk), locateCommandCode: async () => ({ file: FILE, session: 's1' }) })
    const first = await t.chat(PANE, {})
    expect(first.token).toBeTruthy()
    const gate = defer()
    const entered = defer()
    const { run } = handler(disk, { query: { pane: 'p1', before: String(v1.length), since: first.token }, t })
    vi.stubGlobal('addUploadHashes', () => { entered.resolve(); return gate.promise })
    const p = run()
    await entered.promise
    disk[FILE] = { body: v2, mtimeMs: 9 }
    gate.resolve()
    const r = await p
    expect(r.older).toBeUndefined()
    expect(r.rewritten).toBe(true)
    expect(texts(r.items)).not.toContain('a page')
    expect(texts(r.items)).toContain('new content')
  })

  // Unchanged polls: no items, no upload-hash work, no model lookup — and
  // no transcript-body reads: the currency check is in-memory only.
  it('keeps unchanged polls free of transcript IO and postprocessing', async () => {
    const v1 = body(sess('s1'), user('u1', 'q', 1), text('a1', 'an answer'), mc('example/model-a', 6))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    const reads: { start: number, len: number }[] = []
    const t = createTranscripts({ home: '/h', herdr: noHerdr, fs: memFs(disk, { reads }), locateCommandCode: async () => ({ file: FILE, session: 's1' }) })
    const first = await t.chat(PANE, {})
    const calls = { uploads: 0, model: 0 }
    const { run } = handler(disk, { query: { pane: 'p1', since: first.token }, t })
    vi.stubGlobal('addUploadHashes', () => { calls.uploads += 1 })
    vi.stubGlobal('currentModel', async () => { calls.model += 1; return t.model(PANE) })
    const before = reads.length
    const r = await run()
    expect(r.unchanged).toBe(true)
    expect(calls).toEqual({ uploads: 0, model: 0 })
    expect(reads.length).toBe(before)
  })

  // Nothing internal rides the wire: no generation context, no callbacks,
  // no absolute transcript path (the reply's `file` is its basename).
  it('serializes no internal context or absolute path', async () => {
    const v1 = body(sess('s1'), user('u1', 'q', 1), text('a1', 'an answer'), mc('example/model-a', 6))
    const disk: Record<string, MemFile> = { [FILE]: { body: v1 } }
    const { run } = handler(disk)
    vi.stubGlobal('addUploadHashes', () => {})
    const r = await run()
    const wire = JSON.parse(JSON.stringify(r))
    expect(wire).not.toHaveProperty('gen')
    expect(wire.file).toBe('s1.jsonl')
    expect(JSON.stringify(r)).not.toContain('/home/')
  })

  // Legacy replies carry no context and are published exactly as before:
  // no selection revalidation, no generation check, same delta plumbing.
  it('passes a legacy reply through with its unchanged contract', async () => {
    const other: TranscriptPane = { id: 'p2', agent: 'claude', cwd: '/w' }
    const reply: ChatResponse = { available: true, file: 'conv.jsonl', session: 'conv', items: [{ role: 'assistant', text: 'hi', ts: at(1) }], token: 'tok-1', start: 0, queue: [] }
    const { run } = handler({})
    vi.stubGlobal('findPane', () => other)
    vi.stubGlobal('transcripts', {
      chat: async () => reply,
      current: async () => null,
      live: () => null,
    })
    vi.stubGlobal('addUploadHashes', () => {})
    vi.stubGlobal('currentModel', async () => null)
    const r = await run()
    expect(r.items?.map((i: ChatItem) => i.text)).toContain('hi')
    expect(String(r.token)).toContain('tok-1')
    expect(r.model).toBeNull()
  })
})
