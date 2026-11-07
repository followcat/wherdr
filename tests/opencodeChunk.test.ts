import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { OPENCODE_META } from '../server/utils/opencodeTransport'
import { OPENCODE_CHUNK } from '../server/utils/opencodeChunk'

// Same owned-fixture contract as the other OpenCode tests: real helper runs
// against an owned loopback peer and fixture HOME, with an owned default CLI
// stub so no installed OpenCode can ever be launched.
const run = promisify(execFile)
const homes: string[] = []
const servers: http.Server[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  for (const s of servers.splice(0)) await new Promise<void>(resolve => s.close(() => resolve()))
})

interface Peer { url: string, hits: http.IncomingMessage[], close: () => Promise<void> }
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void
async function serve(handler: Handler): Promise<Peer> {
  const hits: http.IncomingMessage[] = []
  const server = http.createServer((req, res) => { hits.push(req); handler(req, res) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}
const peer = (body: Handler | string = '{"data":{"id":"ses_example"}}') => serve((req, res) => {
  if (req.url === '/api/info') { res.end(JSON.stringify({ version: '2.0.27', pid: 10 })); return }
  if (typeof body === 'string') { res.end(body); return }
  body(req, res)
})

const basic = () => 'Basic ' + Buffer.from('opencode:fixture-password').toString('base64')
const REQ = { op: 'session', session: 'ses_example' } as const

function mkhome(url: string | null) {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-oc-chunk-'))
  homes.push(home)
  const bin = path.join(home, '.opencode/bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\nexit 42\n', { mode: 0o755 })
  if (url !== null) {
    const dir = path.join(home, '.local/state/opencode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'service.json'), JSON.stringify({ id: 'fixture', version: '2.0.27', url, pid: 10, password: 'fixture-password' }), { mode: 0o600 })
  }
  return home
}
// The chunk envelope can hold ~5.6 MiB of base64; execFile's default 1 MiB
// buffer would be a fixture error, not a bound.
async function helper(script: string, home: string, request: Record<string, unknown>) {
  try {
    const r = await run('python3', ['-X', 'utf8', '-c', script, home, JSON.stringify(request)],
      { env: { ...process.env, HOME: home, XDG_STATE_HOME: '' }, timeout: 15000, maxBuffer: 16 * 1024 * 1024 })
    return { out: JSON.parse(r.stdout.trim()), raw: r.stdout + r.stderr }
  } catch (error) {
    const e = error as { stdout: string, stderr: string }
    return { out: JSON.parse(e.stdout.trim()), raw: e.stdout + e.stderr }
  }
}
const meta = (home: string, request: Record<string, unknown>) => helper(OPENCODE_META, home, request)
const chunk = (home: string, request: Record<string, unknown>) => helper(OPENCODE_CHUNK, home, request)

// Test-side canonicalizer matching the helper's canon(): sorted keys,
// compact separators, ASCII string escapes. Fixtures stay ASCII.
const canon = (v: unknown): string =>
  v === null ? 'null' : typeof v === 'string' ? JSON.stringify(v)
    : typeof v === 'number' || typeof v === 'boolean' ? JSON.stringify(v)
      : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
        : '{' + Object.keys(v as object).sort().map(k => canon(k) + ':' + canon((v as Record<string, unknown>)[k])).join(',') + '}'

const mib = 1024 * 1024
const BLOB = 'x'.repeat(5 * mib)

it('returns the first exact 4 MiB piece and the truncated tail, bound to the snapshot', async () => {
  const body = `{"z":1,"data":{"blob":"${BLOB}"},"a":2}`
  const p = await peer(body)
  const home = mkhome(p.url)
  const expected = canon(JSON.parse(body))
  const d = (await meta(home, REQ)).out
  expect(d).toMatchObject({ status: 200, size: expected.length })
  const desc = { ...REQ, server: d.server, fingerprint: d.fingerprint, size: d.size }
  const first = (await chunk(home, { ...desc, offset: 0 })).out
  expect(first).toEqual({ status: 200, server: d.server, fingerprint: d.fingerprint, size: d.size, offset: 0, piece: expect.any(String) })
  const firstBytes = Buffer.from(first.piece, 'base64')
  expect(firstBytes.length).toBe(4 * mib)
  const tail = (await chunk(home, { ...desc, offset: 4 * mib })).out
  const tailBytes = Buffer.from(tail.piece, 'base64')
  expect(tailBytes.length).toBe(d.size - 4 * mib)
  expect(tailBytes.length).toBeLessThan(4 * mib)
  // Content proven by hash so a failure never dumps multi-MiB payloads.
  expect(createHash('sha256').update(Buffer.concat([firstBytes, tailBytes])).digest('hex'))
    .toBe(createHash('sha256').update(expected).digest('hex'))
  // meta reads info+session once; each chunk call re-validates with a
  // post-read info.
  expect(p.hits.map(h => h.url)).toEqual(['/api/info', '/api/session/ses_example',
    '/api/info', '/api/session/ses_example', '/api/info',
    '/api/info', '/api/session/ses_example', '/api/info'])
  expect(p.hits.every(h => h.headers.authorization === basic())).toBe(true)
  const { out, raw } = await chunk(home, { ...desc, offset: d.size })
  expect(out).toMatchObject({ status: 200, piece: '' })
  expect(raw).not.toMatch(/fixture-password|127\.0\.0\.1|service\.json/)
}, 60000)

it('returns a cursor-bound page piece with the exact escaped query and Basic auth', async () => {
  const body = '{"data":{"m":"v"}}'
  const p = await peer(body)
  const home = mkhome(p.url)
  const req = { op: 'page', session: 'ses_example', cursor: 'ab+cd/e' }
  const d = (await meta(home, req)).out
  const query = '/api/session/ses_example/message?limit=120&cursor=ab%2Bcd%2Fe'
  const out = (await chunk(home, { ...req, server: d.server, fingerprint: d.fingerprint, size: d.size, offset: 0 })).out
  expect(out).toEqual({ status: 200, server: d.server, fingerprint: d.fingerprint, size: d.size, offset: 0, piece: expect.any(String) })
  expect(Buffer.from(out.piece, 'base64').toString('utf8')).toBe(canon(JSON.parse(body)))
  expect(p.hits.map(h => h.url)).toEqual(['/api/info', query, '/api/info', query, '/api/info'])
  expect(p.hits.every(h => h.headers.authorization === basic())).toBe(true)
})

it('refuses malformed descriptors before any machine work', async () => {
  const p = await peer()
  const home = mkhome(p.url)
  const d = (await meta(home, REQ)).out
  const desc = { ...REQ, server: d.server, fingerprint: d.fingerprint, size: d.size, offset: 0 }
  for (const bad of [{ ...desc, op: 'delete' }, { ...desc, extra: 1 }, { ...desc, server: 'zz'.repeat(16) },
    { ...desc, fingerprint: 'xx' }, { ...desc, size: true }, { ...desc, size: 1.5 }, { ...desc, size: -1 },
    { ...desc, size: 25 * mib }, { ...desc, offset: -1 }, { ...desc, offset: 0.5 }, { ...desc, offset: d.size + 1 },
    { ...desc, session: '..' }, { ...desc, session: 's\u00e9ssion' }, { ...desc, cursor: 'page-only' },
    { ...desc, cursor: null }, { ...desc, op: 'page', cursor: null },
    'not json', '42', `{"op":"session","pad":"${'x'.repeat(5000)}"}`]) {
    expect(await chunk(home, bad as never)).toEqual({ out: { error: 'invalid_request' }, raw: expect.any(String) })
  }
  // Only the descriptor-minting meta read ever reached the peer.
  expect(p.hits.map(h => h.url)).toEqual(['/api/info', '/api/session/ses_example'])
}, 30000)

it('refuses stale snapshot descriptors and live changes without any piece', async () => {
  let body = `{"data":{"blob":"${'x'.repeat(1024)}"}}`
  const p = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(JSON.stringify({ version: '2.0.27', pid: 10 })); return }
    res.end(body)
  })
  const home = mkhome(p.url)
  const d = (await meta(home, REQ)).out
  const desc = { ...REQ, server: d.server, fingerprint: d.fingerprint, size: d.size }
  // A wrong generation fails before the data GET at all.
  const wrong = { ...desc, server: 'a'.repeat(32), offset: 0 }
  const hitsBefore = p.hits.length
  expect((await chunk(home, wrong)).out).toEqual({ error: 'snapshot_changed' })
  expect(p.hits.length).toBe(hitsBefore + 1) // one info only
  for (const stale of [{ ...desc, fingerprint: 'b'.repeat(64), offset: 0 },
    { ...desc, size: d.size + 1, offset: 0 }, { ...desc, size: d.size - 1, offset: 0 }]) {
    const out = (await chunk(home, stale)).out
    expect(out).toEqual({ error: 'snapshot_changed' })
    expect(out.piece).toBeUndefined()
  }
  // The fingerprint binds the request context itself: another session, the
  // other op or another cursor at the same body and service all refuse.
  for (const other of [{ ...desc, session: 'ses_other', offset: 0 }, { ...desc, op: 'page', offset: 0 }]) {
    const out = (await chunk(home, other)).out
    expect(out).toEqual({ error: 'snapshot_changed' })
    expect(out.piece).toBeUndefined()
  }
  const page = (await meta(home, { op: 'page', session: 'ses_example', cursor: 'a' })).out
  expect((await chunk(home, { op: 'page', session: 'ses_example', cursor: 'b',
    server: page.server, fingerprint: page.fingerprint, size: page.size, offset: 0 })).out)
    .toEqual({ error: 'snapshot_changed' })
  // A same-sized rewrite at the same generation still changes the
  // canonical digest.
  body = body.replaceAll('x', 'y')
  expect((await chunk(home, { ...desc, offset: 0 })).out).toEqual({ error: 'snapshot_changed' })
  // An info.pid change between the data read and the revalidating info
  // refuses the piece: the flip lands on this invocation's read.
  let pid = 10
  let reads = 0
  const live = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(JSON.stringify({ version: '2.0.27', pid })); return }
    reads += 1
    if (reads >= 2) pid = 11
    res.end(body)
  })
  const h2 = mkhome(live.url)
  const d2 = (await meta(h2, REQ)).out
  expect((await chunk(h2, { ...REQ, server: d2.server, fingerprint: d2.fingerprint, size: d2.size, offset: 0 })).out).toEqual({ error: 'snapshot_changed' })
  // A registration-id change to the owned state file between the data read
  // and rediscovery refuses the piece; info.pid and body stay unchanged.
  let regReads = 0
  const reg = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(JSON.stringify({ version: '2.0.27', pid: 10 })); return }
    regReads += 1
    if (regReads === 2) writeFileSync(state, JSON.stringify({ id: 'fixture-2', version: '2.0.27', url: reg.url, pid: 10, password: 'fixture-password' }), { mode: 0o600 })
    res.end(body)
  })
  const h3 = mkhome(reg.url)
  const state = path.join(h3, '.local/state/opencode/service.json')
  const d3 = (await meta(h3, REQ)).out
  expect((await chunk(h3, { ...REQ, server: d3.server, fingerprint: d3.fingerprint, size: d3.size, offset: 0 })).out).toEqual({ error: 'snapshot_changed' })
})

it('keeps absence, errors and oversize replies free of partial bytes', async () => {
  // One mutable peer: descriptor minted from a good read, then the body or
  // status changes under the same server generation.
  let body = '{"data":{"id":"ses_example"}}'
  let status = 200
  const p = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(JSON.stringify({ version: '2.0.27', pid: 10 })); return }
    res.statusCode = status; res.end(body)
  })
  const home = mkhome(p.url)
  const d = (await meta(home, REQ)).out
  const desc = { ...REQ, server: d.server, fingerprint: d.fingerprint, size: d.size, offset: 0 }
  status = 404
  expect((await chunk(home, desc)).out).toEqual({ status: 404, server: d.server })
  status = 200; body = 'not json'
  expect((await chunk(home, desc)).out).toEqual({ error: 'reply_invalid' })
  body = `["${'x'.repeat(24 * mib - 2)}"]`
  const out = (await chunk(home, desc)).out
  expect(out).toEqual({ error: 'too_large' })
  expect(out.piece).toBeUndefined()
  const denied = await serve((req, res) => { res.statusCode = 401; res.end() })
  expect((await chunk(mkhome(denied.url), { ...desc, server: 'a'.repeat(32), fingerprint: 'a'.repeat(64), size: 1 })).out).toEqual({ error: 'auth' })
  const gone = await peer()
  const url = gone.url
  await gone.close()
  expect((await chunk(mkhome(url), { ...desc, server: 'a'.repeat(32), fingerprint: 'a'.repeat(64), size: 1 })).out).toEqual({ error: 'unreachable' })
})
