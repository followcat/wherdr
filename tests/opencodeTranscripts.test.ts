// OpenCode reader for a selected session: parseOpenCode shapes, and the
// numeric-cursor paging contract over the snapshot seam (bottom joins,
// older slices, unchanged tokens, proven absence vs transport unknown).
import { expect, it } from 'vitest'
import { parseOpenCode, createOpencodeTranscripts } from '../server/utils/opencodeTranscripts'
import type { OpencodeSnapshot } from '../server/utils/opencodeSnapshot'
import type { ShellExec } from '../server/utils/fsx'
import type { Loc, TranscriptPane } from '../server/utils/transcripts'

type Json = Record<string, any>
const T0 = 1762000000000

// --- parseOpenCode ----------------------------------------------------------

it('user, assistant text/reasoning, tool and shell shape into chat items', () => {
  const items = parseOpenCode([
    { id: 'm1', type: 'user', text: 'say hi', time: { created: T0 },
      files: [{ mime: 'image/png', data: 'AAAA' }] },
    { id: 'm2', type: 'assistant', time: { created: T0 + 1000 }, content: [
      { type: 'reasoning', text: 'thinking…' },
      { type: 'text', text: 'hi there' },
      { type: 'tool', id: 'call_1', name: 'bash', state: { input: { command: 'echo hi' }, content: 'hi\n', status: 'completed' },
        time: { created: T0 + 1100, completed: T0 + 1400 } },
    ] },
    { id: 'm3', type: 'synthetic', metadata: { source: 'shell', exit: 1 }, time: { created: T0 + 2000 },
      description: 'ls /tmp', text: '<shell id="j1" state="failed" command="ls /tmp">oops\n</shell>' },
    { id: 'm4', type: 'system', text: 'session started', time: { created: T0 + 3000 } },
    { id: 'm5', type: 'compaction', summary: 'compact', time: { created: T0 + 4000 } },
    { id: 'm6', type: 'assistant', time: { created: T0 + 5000 }, content: [],
      error: { message: 'provider blew up' } },
  ])
  expect(items.map(i => [i.role, i.name ?? '', i.text, i.out ?? '', i.error ?? false, i.images ?? 0, i.ms ?? 0])).toEqual([
    ['user', '', 'say hi', '', false, 1, 0],
    ['thinking', '', 'thinking…', '', false, 0, 0],
    ['assistant', '', 'hi there', '', false, 0, 0],
    ['tool', 'bash', 'echo hi', 'hi\n', false, 0, 300],
    ['bash', '', 'ls /tmp', 'oops\n', true, 0, 0],
    ['notice', '', 'session started', '', false, 0, 0],
    ['notice', 'compaction', 'compact', '', false, 0, 0],
    ['assistant', '', 'provider blew up', '', true, 0, 0],
  ])
  expect(items[0]!.ts).toBe(new Date(T0).toISOString())
  expect(items[0]!.ref).toBe('oc:m1:u')
  expect(items[3]!.ref).toBe('oc:m2:tcall_1')
})

it('skips idle markers and unknown types; refs stay image-addressable', () => {
  expect(parseOpenCode([
    { id: 'm1', type: 'idle' },
    { id: 'm2', type: 'mystery', text: '?' },
    { id: 'm3', type: 'synthetic', metadata: { source: 'system' }, description: 'note' },
    { id: 'm4', type: 'assistant', content: [{ type: 'step-start' }] },
  ]).map(i => i.role)).toEqual(['notice'])
})

// --- reader (chat) ----------------------------------------------------------

const exec = (() => Promise.reject(new Error('no exec in tests'))) as unknown as ShellExec
const pane = (id = 'p1'): TranscriptPane => ({ id, agent: 'opencode' } as TranscriptPane)
const loc: Loc = { file: `oc:${'a'.repeat(32)}:ses_1`, session: 'ses_1' }
const SERVER = 'a'.repeat(32)
const fp = (s: string) => s.padEnd(64, '0').slice(0, 64)

// A scripted snapshot reader: `replies[key]` answers each request in order
// (session or page-by-cursor); records every request it saw.
function scripted(replies: Record<string, OpencodeSnapshot[]>) {
  const seen: Record<string, unknown>[] = []
  const snap = async (_home: string, request: Record<string, unknown>): Promise<OpencodeSnapshot> => {
    seen.push(request)
    const key = request.op === 'page' ? `page:${request.cursor ?? ''}` : 'session'
    const list = replies[key] || []
    return list.length ? list.shift()! : { ok: false, error: 'unreachable' }
  }
  return { snap, seen }
}
const ok = (body: Json, fingerprint = fp('x')): OpencodeSnapshot =>
  ({ ok: true, server: SERVER, fingerprint, size: JSON.stringify(body).length, unchanged: false, body: Buffer.from(JSON.stringify(body)) })
const session = (over: Json = {}): Json => ({ data: { id: 'ses_1', time: { created: T0, updated: T0 }, model: { id: 'acme-7' }, ...over } })
const msgs = (list: Json[], next?: string): Json => ({ data: list, cursor: next ? { next } : {} })
const msg = (id: string, type: string, over: Json = {}): Json => ({ id, type, time: { created: T0 }, ...over })

it('bottom read returns ascending items, a start cursor and a token; unchanged reuses it', async () => {
  const s = scripted({
    session: [ok(session()), ok(session(), fp('x'))],
    'page:': [ok(msgs([msg('m2', 'assistant', { content: [{ type: 'text', text: 'hi' }] }), msg('m1', 'user', { text: 'say hi' })])), ok(msgs([msg('m2', 'assistant', { content: [{ type: 'text', text: 'hi' }] }), msg('m1', 'user', { text: 'say hi' })]))],
  })
  const oc = createOpencodeTranscripts({ exec, home: '/home/user', snap: s.snap })
  const r1 = await oc.chat(pane(), loc, {})
  expect(r1.available).toBe(true)
  expect(r1.items!.map(i => i.role)).toEqual(['user', 'assistant'])
  expect(r1.items![0]!.text).toBe('say hi')
  expect(typeof r1.start).toBe('number')
  expect(r1.token).toBeTruthy()
  // Same token + same tail anchor -> unchanged, no items.
  const r2 = await oc.chat(pane(), loc, { since: r1.token, from: r1.start })
  expect(r2.unchanged).toBe(true)
  expect(r2.items).toBeUndefined()
})

it('a from join keeps the same start; a revert moves the file and rewrites', async () => {
  const page = msgs([msg('m2', 'assistant', { content: [{ type: 'text', text: 'hi' }] }), msg('m1', 'user', { text: 'say hi' })])
  const s = scripted({
    session: [ok(session()), ok(session(), fp('a')), ok(session({ revert: { messageID: 'm1' } }), fp('b'))],
    'page:': [ok(page), ok(page, fp('c')), ok(page, fp('d'))],
  })
  const oc = createOpencodeTranscripts({ exec, home: '/home/user', snap: s.snap })
  const r1 = await oc.chat(pane(), loc, {})
  const r2 = await oc.chat(pane(), loc, { from: r1.start })
  expect(r2.start).toBe(r1.start)
  expect(r2.rewritten).toBeUndefined()
  // A revert changes the file identity: a cursor minted under the old one
  // can never join — fresh bottom, marked rewritten.
  const r3 = await oc.chat(pane(), loc, { from: r1.start })
  expect(r3.rewritten).toBe(true)
  expect(r3.start).not.toBe(r1.start)
  expect(r3.file).not.toBe(r1.file)
})

it('before pages older slices; the end of history has no further start', async () => {
  const p0 = msgs([msg('m4', 'assistant', { content: [{ type: 'text', text: 'd' }] }), msg('m3', 'user', { text: 'c' })], 'n1')
  const p1 = msgs([msg('m2', 'assistant', { content: [{ type: 'text', text: 'b' }] }), msg('m1', 'user', { text: 'a' })])
  const s = scripted({
    session: [ok(session()), ok(session(), fp('s2')), ok(session(), fp('s3'))],
    'page:': [ok(p0), ok(p0, fp('p0b')), ok(p0, fp('p0c'))],
    'page:n1': [ok(p1), ok(p1, fp('p1b'))],
  })
  const oc = createOpencodeTranscripts({ exec, home: '/home/user', snap: s.snap })
  const r1 = await oc.chat(pane(), loc, {})
  expect(r1.items!.map(i => i.text)).toEqual(['c', 'd'])
  const r2 = await oc.chat(pane(), loc, { before: r1.start })
  expect(r2.older).toBe(true)
  expect(r2.items!.map(i => i.text)).toEqual(['a', 'b'])
  // p1 exhausted the history: no continuation cursor.
  expect(r2.start).toBeUndefined()
})

it('an older slice over the page limit keeps a decreasing start', async () => {
  const many = Array.from({ length: 121 }, (_, i) => msg(`x${i}`, 'user', { text: `t${i}` }))
  const p0 = msgs([msg('anchor', 'user', { text: 'c' })], 'n1')
  const p1 = msgs(many, 'n2')
  const s = scripted({
    session: [ok(session()), ok(session(), fp('s2'))],
    'page:': [ok(p0), ok(p0, fp('p0b'))],
    'page:n1': [ok(p1)],
    'page:n2': [ok(msgs([msg('old', 'user', { text: 'oldest' })]))],
  })
  const oc = createOpencodeTranscripts({ exec, home: '/home/user', snap: s.snap })
  const r1 = await oc.chat(pane(), loc, {})
  const r2 = await oc.chat(pane(), loc, { before: r1.start })
  expect(r2.items).toHaveLength(120)
  expect(typeof r2.start).toBe('number')
  expect(r2.start!).toBeLessThan(r1.start!)
})

it('a proven absent session reads unavailable; a transport unknown throws', async () => {
  const s = scripted({ session: [{ ok: false, status: 404, server: SERVER }] })
  const oc = createOpencodeTranscripts({ exec, home: '/home/user', snap: s.snap })
  expect(await oc.chat(pane(), loc, {})).toEqual({ available: false, reason: 'not_found' })
  const s2 = scripted({ session: [{ ok: false, error: 'unreachable' }] })
  const oc2 = createOpencodeTranscripts({ exec, home: '/home/user', snap: s2.snap })
  await expect(oc2.chat(pane(), loc, {})).rejects.toThrow()
})
