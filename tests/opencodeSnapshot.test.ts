import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { opencodeSnapshots } from '../server/utils/opencodeSnapshot'
import { OPENCODE_META } from '../server/utils/opencodeTransport'
import { OPENCODE_CHUNK } from '../server/utils/opencodeChunk'
import { localShell } from '../server/utils/agentProcesses'
import type { ExecResult, ShellExec } from '../server/utils/fsx'

// Same owned-fixture contract as the other OpenCode tests: real helpers run
// against an owned loopback peer and fixture HOME, with an owned default CLI
// stub so no installed OpenCode can ever be launched.
const homes: string[] = []
const servers: http.Server[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  for (const s of servers.splice(0)) await new Promise<void>(resolve => s.close(() => resolve()))
})

interface Peer { url: string, hits: http.IncomingMessage[] }
async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Peer> {
  const hits: http.IncomingMessage[] = []
  const server = http.createServer((req, res) => { hits.push(req); handler(req, res) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits }
}
const peer = (body: string) => serve((req, res) => {
  if (req.url === '/api/info') { res.end(JSON.stringify({ version: '2.0.27', pid: 10 })); return }
  res.end(body)
})
const basic = () => 'Basic ' + Buffer.from('opencode:fixture-password').toString('base64')
const mib = 1024 * 1024
const hex32 = 'a'.repeat(32)
const hex64 = 'b'.repeat(64)
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

function mkhome(url: string | null) {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-oc-snap-'))
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

// Test-side canonicalizer matching the helper's canon(). Fixtures stay ASCII.
const canon = (v: unknown): string =>
  v === null ? 'null' : typeof v === 'string' ? JSON.stringify(v)
    : typeof v === 'number' || typeof v === 'boolean' ? JSON.stringify(v)
      : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
        : '{' + Object.keys(v as object).sort().map(k => canon(k) + ':' + canon((v as Record<string, unknown>)[k])).join(',') + '}'
// The helper's fingerprint serialization: a json.dumps list uses ", " item
// separators, so the array is rebuilt element by element.
const snapFp = (server: string, session: string, op: string, cursor: string, digest: string) =>
  sha('[' + [server, session, op, cursor, digest].map(s => JSON.stringify(s)).join(', ') + ']')
const env = (o: Record<string, unknown>): ExecResult => ({ code: 0, stdout: Buffer.from(JSON.stringify(o) + '\n'), stderr: '' })
const err = (e: string): ExecResult => ({ code: 1, stdout: Buffer.from(`{"error":"${e}"}\n`), stderr: '' })

it('assembles a >4 MiB page snapshot through the real helpers end to end', async () => {
  const body = `{"z":1,"data":{"blob":"${'x'.repeat(5 * mib)}"},"a":2}`
  const p = await peer(body)
  const home = mkhome(p.url)
  // A printable opaque cursor carrying comma, quote, backslash, plus and
  // slash: the real helper fingerprints it, so only exact serialization can
  // re-prove the assembled body.
  const cursor = 'a,b"c\\d+e/f'
  const r = await opencodeSnapshots(localShell).read(home, { op: 'page', session: 'ses_example', cursor })
  expect(r).toMatchObject({ ok: true, unchanged: false, size: canon(JSON.parse(body)).length })
  if (!r.ok || r.unchanged) throw new Error(`unexpected ${JSON.stringify(r)}`)
  const expected = Buffer.from(canon(JSON.parse(body)), 'utf8')
  expect(r.body.length).toBe(expected.length)
  expect(sha(r.body)).toBe(sha(expected))
  const q = '/api/session/ses_example/message?limit=120&cursor=a%2Cb%22c%5Cd%2Be%2Ff'
  // meta (info+page), then two pieces (info+page+info each).
  expect(p.hits.map(h => h.url)).toEqual(['/api/info', q, '/api/info', q, '/api/info', '/api/info', q, '/api/info'])
  expect(p.hits.every(h => h.headers.authorization === basic())).toBe(true)
}, 60000)

it('returns metadata-only unchanged with zero chunk traffic', async () => {
  const calls: string[][] = []
  const fake: ShellExec = async (_s, args = []) => {
    calls.push(args)
    return env({ status: 200, server: hex32, fingerprint: hex64, size: 42, unchanged: true })
  }
  const snap = opencodeSnapshots(fake)
  expect(await snap.read('/home/user', { op: 'session', session: 'ses_example', expect: hex64 }))
    .toEqual({ ok: true, server: hex32, fingerprint: hex64, size: 42, unchanged: true })
  expect(calls).toHaveLength(1)
  expect(calls[0]![0]).toBe(OPENCODE_META)
})

it('refuses unchanged without a caller fingerprint equal to the returned one', async () => {
  // The helper only emits unchanged:true when expect equals its fingerprint;
  // absent or mismatched means a malformed reply, never silent retention.
  for (const req of [{ op: 'session', session: 'ses_example' },
    { op: 'session', session: 'ses_example', expect: 'c'.repeat(64) }]) {
    const calls: string[][] = []
    const fake: ShellExec = async (_s, args = []) => {
      calls.push(args)
      return env({ status: 200, server: hex32, fingerprint: hex64, size: 42, unchanged: true })
    }
    expect(await opencodeSnapshots(fake).read('/home/user', req), JSON.stringify(req))
      .toEqual({ ok: false, error: 'unavailable' })
    expect(calls).toHaveLength(1)
  }
})

it('re-proves the assembled fingerprint, restarts once on a corrupt piece, and never mixes bytes', async () => {
  const canon_ = Buffer.from('{"data":{"blob":"correct canonical bytes"}}', 'utf8')
  const fp = snapFp(hex32, 'ses_example', 'session', '', sha(canon_))
  const corrupt = Buffer.alloc(canon_.length, 'y')
  const calls: string[][] = []
  let metas = 0
  const fake: ShellExec = async (_s, args = []) => {
    calls.push(args)
    if (args[0] === OPENCODE_META) { metas += 1; return env({ status: 200, server: hex32, fingerprint: fp, size: canon_.length, unchanged: false }) }
    const piece = metas === 1 ? corrupt : canon_
    return env({ status: 200, server: hex32, fingerprint: fp, size: canon_.length, offset: 0, piece: piece.toString('base64') })
  }
  const r = await opencodeSnapshots(fake).read('/home/user', { op: 'session', session: 'ses_example' })
  expect(r).toMatchObject({ ok: true, unchanged: false })
  if (!r.ok || r.unchanged) throw new Error(`unexpected ${JSON.stringify(r)}`)
  expect(r.body).toEqual(canon_)
  // Fresh restart: a second metadata read, then offset 0 again. The corrupt
  // piece is fully dropped, never concatenated.
  expect(calls.map(c => c[0])).toEqual([OPENCODE_META, OPENCODE_CHUNK, OPENCODE_META, OPENCODE_CHUNK])
  expect(JSON.parse(calls[3]![2]!).offset).toBe(0)
})

it('restarts on a mid-read change and never carries bytes or context across snapshots', async () => {
  // Two distinct canonical snapshots: different bytes from the first byte,
  // different fingerprint, different server generation. Attempt 1 reads a
  // good 4 MiB prefix of A, then its tail reports the snapshot changed.
  const bodyA = Buffer.from(canon(JSON.parse(`{"a":{"blob":"${'a'.repeat(5 * mib)}"},"z":1}`)), 'utf8')
  const bodyB = Buffer.from(canon(JSON.parse(`{"b":{"blob":"${'b'.repeat(5 * mib + 7)}"},"z":2}`)), 'utf8')
  const serverB = 'c'.repeat(32)
  const fpA = snapFp(hex32, 'ses_example', 'session', '', sha(bodyA))
  const fpB = snapFp(serverB, 'ses_example', 'session', '', sha(bodyB))
  const calls: string[][] = []
  let metas = 0
  const fake: ShellExec = async (_s, args = []) => {
    calls.push(args)
    if (args[0] === OPENCODE_META) {
      metas += 1
      return metas === 1
        ? env({ status: 200, server: hex32, fingerprint: fpA, size: bodyA.length, unchanged: false })
        : env({ status: 200, server: serverB, fingerprint: fpB, size: bodyB.length, unchanged: false })
    }
    const offset = JSON.parse(args[2]!).offset
    if (metas === 1 && offset > 0) return err('snapshot_changed')
    const body = metas === 1 ? bodyA : bodyB
    const server = metas === 1 ? hex32 : serverB
    const fp = metas === 1 ? fpA : fpB
    return env({ status: 200, server, fingerprint: fp, size: body.length, offset, piece: body.subarray(offset, offset + 4 * mib).toString('base64') })
  }
  const r = await opencodeSnapshots(fake).read('/home/user', { op: 'session', session: 'ses_example' })
  expect(r).toMatchObject({ ok: true, unchanged: false, server: serverB, fingerprint: fpB, size: bodyB.length })
  if (!r.ok || r.unchanged) throw new Error(`unexpected ${JSON.stringify(r)}`)
  // Final bytes, hash and context are all B: the good A prefix was dropped
  // at offset 0, never carried into the second attempt's buffer.
  expect(sha(r.body)).toBe(sha(bodyB))
  expect(r.body.subarray(0, 4).toString()).toBe('{"b"')
  expect(calls.map(c => c[0])).toEqual([OPENCODE_META, OPENCODE_CHUNK, OPENCODE_CHUNK, OPENCODE_META, OPENCODE_CHUNK, OPENCODE_CHUNK])
  expect(calls.map(c => c[0] === OPENCODE_CHUNK ? JSON.parse(c[2]!).offset : -1)).toEqual([-1, 0, 4 * mib, -1, 0, 4 * mib])
}, 30000)

it('bounds churn to two attempts and preserves absence vs other errors', async () => {
  let metas = 0
  const fake = (chunkReply: () => ExecResult): ShellExec => async (_s, args = []) =>
    args[0] === OPENCODE_META
      ? (metas += 1, env({ status: 200, server: hex32, fingerprint: hex64, size: 4, unchanged: false }))
      : chunkReply()
  const snap = opencodeSnapshots(fake(() => err('snapshot_changed')))
  expect(await snap.read('/home/user', { op: 'session', session: 'ses_example' })).toEqual({ ok: false, error: 'snapshot_changed' })
  expect(metas).toBe(2)
  // An authoritative absence mid-read is not retried.
  metas = 0
  const gone = opencodeSnapshots(fake(() => env({ status: 404, server: hex32 })))
  expect(await gone.read('/home/user', { op: 'session', session: 'ses_example' })).toEqual({ ok: false, status: 404, server: hex32 })
  expect(metas).toBe(1)
  // Neither is a fixed non-retryable error.
  metas = 0
  const denied = opencodeSnapshots(fake(() => err('auth')))
  expect(await denied.read('/home/user', { op: 'session', session: 'ses_example' })).toEqual({ ok: false, error: 'auth' })
  expect(metas).toBe(1)
})

it('snapshots the request before any await and coalesces only identical work', async () => {
  const empty = snapFp(hex32, 'ses_example', 'session', '', sha(''))
  const seen: string[][] = []
  const pending: ((r: ExecResult) => void)[] = []
  const fake: ShellExec = (_s, args = []) => { seen.push(args); return new Promise<ExecResult>(r => pending.push(r)) }
  const snap = opencodeSnapshots(fake)
  const req: Record<string, unknown> = { op: 'session', session: 'ses_example' }
  const p1 = snap.read('/home/user', req)
  req.session = 'ses_evil'
  const p2 = snap.read('/home/user', { op: 'session', session: 'ses_example' })
  expect(p2).toBe(p1)
  pending[0]!(env({ status: 200, server: hex32, fingerprint: empty, size: 0, unchanged: false }))
  expect(await p1).toMatchObject({ ok: true, unchanged: false, size: 0 })
  expect(JSON.parse(seen[0]![2]!).session).toBe('ses_example')
  // Different cursor, home, known fingerprint or budget never share work.
  const distinct = [
    snap.read('/home/user', { op: 'page', session: 'ses_example', cursor: 'c1' }),
    snap.read('/home/other', { op: 'session', session: 'ses_example' }),
    snap.read('/home/user', { op: 'session', session: 'ses_example', expect: 'c'.repeat(64) }),
    snap.read('/home/user', { op: 'session', session: 'ses_example' }, { timeoutMs: 30000 })
  ]
  expect(distinct.every(p => p !== p1)).toBe(true)
  expect(seen).toHaveLength(5)
  for (let i = 0; i < distinct.length; i++) {
    pending[1 + i]!(env({ status: 404, server: hex32 }))
    expect(await distinct[i]).toEqual({ ok: false, status: 404, server: hex32 })
  }
  await Promise.resolve(); await Promise.resolve() // entry cleanup microtask
  // Bound in-flight keys: the 17th distinct request is refused, not queued.
  const reads: Promise<unknown>[] = []
  for (let i = 0; i < 16; i++) reads.push(snap.read('/home/user', { op: 'session', session: `s${i}` }))
  reads.push(snap.read('/home/user', { op: 'session', session: 's16' }))
  expect(await reads[16]).toEqual({ ok: false, error: 'busy' })
  // Every pending fake read is drained and awaited in cleanup.
  while (pending.length) pending.shift()!(env({ status: 404, server: hex32 }))
  await Promise.all(reads)
})

it('fails closed on the aggregate deadline and holds backpressure until drain', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
  let calls = 0
  let release: ((r: ExecResult) => void) | null = null
  const fake: ShellExec = () => { calls += 1; return new Promise<ExecResult>(r => { release = r }) }
  const snap = opencodeSnapshots(fake)
  const req = { op: 'session', session: 'ses_example' }
  const p1 = snap.read('/home/user', req, { timeoutMs: 10000 })
  await vi.advanceTimersByTimeAsync(10000)
  expect(await p1).toEqual({ ok: false, error: 'unreachable' })
  expect(calls).toBe(1)
  // The timed-out result is retained while the stuck call drains: an
  // identical request coalesces onto it instead of spawning fresh work.
  expect(await snap.read('/home/user', req, { timeoutMs: 10000 })).toEqual({ ok: false, error: 'unreachable' })
  expect(calls).toBe(1)
  // Draining the orphan clears the entry; the late reply can never publish.
  release!(env({ status: 200, server: hex32, fingerprint: hex64, size: 0, unchanged: false }))
  await vi.advanceTimersByTimeAsync(0)
  const empty = snapFp(hex32, 'ses_example', 'session', '', sha(''))
  const p3 = snap.read('/home/user', req, { timeoutMs: 10000 })
  expect(calls).toBe(2)
  release!(env({ status: 200, server: hex32, fingerprint: empty, size: 0, unchanged: false }))
  expect(await p3).toMatchObject({ ok: true, unchanged: false, size: 0 })
})

it('fails closed when the clock passes the deadline before a reply publishes', async () => {
  // A reply can resolve in real time while the monotonic clock has already
  // passed the aggregate deadline (blocked event loop, slow sync work): a
  // resolved continuation can beat the armed-but-unfired timer, yet nothing
  // may publish and no new read may start once the clock says late.
  let now = 1000
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => now)
  try {
    let calls = 0
    // unchanged:true metadata whose winner would publish a retained result.
    const stale: ShellExec = async () => {
      calls += 1
      await Promise.resolve()
      now += 70000
      return env({ status: 200, server: hex32, fingerprint: hex64, size: 3, unchanged: true })
    }
    expect(await opencodeSnapshots(stale).read('/home/user',
      { op: 'session', session: 'ses_example', expect: hex64 }, { timeoutMs: 60000 }))
      .toEqual({ ok: false, error: 'unreachable' })
    // The same late clock on the last piece must block the body publish.
    const body = Buffer.from('abc')
    const fp = snapFp(hex32, 'ses_example', 'session', '', sha(body))
    const piece: ShellExec = async (_s, args = []) => {
      calls += 1
      if (args[0] === OPENCODE_META)
        return env({ status: 200, server: hex32, fingerprint: fp, size: body.length, unchanged: false })
      await Promise.resolve()
      now += 70000
      return env({ status: 200, server: hex32, fingerprint: fp, size: body.length, offset: 0, piece: body.toString('base64') })
    }
    expect(await opencodeSnapshots(piece).read('/home/user',
      { op: 'session', session: 'ses_example' }, { timeoutMs: 60000 }))
      .toEqual({ ok: false, error: 'unreachable' })
    expect(calls).toBe(3)
  } finally { spy.mockRestore() }
})

it('reads the server-wide models catalog with no session field', async () => {
  const body = Buffer.from('{"data":[{"id":"m1","providerID":"acme","name":"Alpha"}]}')
  const fp = snapFp(hex32, '', 'models', '', sha(body))
  const requests: Record<string, unknown>[] = []
  const fake: ShellExec = async (_s, args = []) => {
    requests.push(JSON.parse(String(args?.[2] || '{}')))
    if (args[0] === OPENCODE_META)
      return env({ status: 200, server: hex32, fingerprint: fp, size: body.length, unchanged: false })
    return env({ status: 200, server: hex32, fingerprint: fp, size: body.length, offset: 0, piece: body.toString('base64') })
  }
  const r = await opencodeSnapshots(fake).read('/home/user', { op: 'models' })
  expect(r).toMatchObject({ ok: true, unchanged: false })
  expect((r as { body?: Buffer }).body?.toString('utf8')).toBe(body.toString('utf8'))
  // Both the metadata and the descriptor carry the fixed 'models' op and no
  // session field at all — the catalog is a server-wide read.
  expect(requests).toHaveLength(2)
  for (const req of requests) {
    expect(req.op).toBe('models')
    expect(req.session).toBeUndefined()
    expect(req.cursor).toBeUndefined()
  }
})

it('refuses a models target carrying a session or cursor', async () => {
  for (const req of [{ op: 'models', session: 'ses_example' }, { op: 'models', cursor: 'abc' }])
    expect(await opencodeSnapshots(async () => env({})).read('/home/user', req), JSON.stringify(req))
      .toEqual({ ok: false, error: 'invalid_request' })
})
