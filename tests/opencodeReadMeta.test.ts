import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { OPENCODE_META } from '../server/utils/opencodeTransport'

// Same owned-fixture contract as opencodeTransport.test.ts: the helper runs
// for real against an owned loopback peer and fixture HOME; every home gets
// the owned default CLI stub (first discovery candidate) so no installed
// OpenCode can ever be launched by a missing-state case.
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
// The default owned peer: a 2.0.27 info and a fixed session/page body.
const peer = (body: Handler | string = '{"data":{"id":"ses_example"}}') => serve((req, res) => {
  if (req.url === '/api/info') { res.end(JSON.stringify({ version: '2.0.27', pid: 10 })); return }
  if (typeof body === 'string') { res.end(body); return }
  body(req, res)
})

const basic = () => 'Basic ' + Buffer.from('opencode:fixture-password').toString('base64')
const REQ = { op: 'session', session: 'ses_example' } as const

function mkhome(url: string | null, extra: Record<string, unknown> = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-oc-meta-'))
  homes.push(home)
  const bin = path.join(home, '.opencode/bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\nexit 42\n', { mode: 0o755 })
  if (url !== null) {
    const dir = path.join(home, '.local/state/opencode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'service.json'), JSON.stringify({ id: 'fixture', version: '2.0.27', url, pid: 10, password: 'fixture-password', ...extra }), { mode: 0o600 })
  }
  return home
}
async function meta(home: string, request: Record<string, unknown> | string, env: NodeJS.ProcessEnv = {}) {
  const body = typeof request === 'string' ? request : JSON.stringify(request)
  try {
    const r = await run('python3', ['-X', 'utf8', '-c', OPENCODE_META, home, body], { env: { ...process.env, HOME: home, XDG_STATE_HOME: '', ...env }, timeout: 15000 })
    return { out: JSON.parse(r.stdout.trim()), raw: r.stdout + r.stderr }
  } catch (error) {
    const e = error as { stdout: string, stderr: string }
    return { out: JSON.parse(e.stdout.trim()), raw: e.stdout + e.stderr }
  }
}

it('reads session metadata with the exact fixed request, Basic auth and zero data bytes', async () => {
  const p = await peer()
  const home = mkhome(p.url)
  const { out, raw } = await meta(home, REQ)
  expect(p.hits.map(h => h.url)).toEqual(['/api/info', '/api/session/ses_example'])
  expect(p.hits.map(h => h.headers.authorization)).toEqual([basic(), basic()])
  expect(out).toEqual({ status: 200, server: expect.stringMatching(/^[a-f0-9]{32}$/),
    fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), size: expect.any(Number), unchanged: false })
  // Metadata only: no body bytes, password, URL or paths ever leave.
  expect(raw).not.toMatch(/fixture-password|127\.0\.0\.1|ses_example|service\.json/)
})

it('requests the initial page and an explicit cursor page with fixed escaping', async () => {
  const p = await peer()
  const home = mkhome(p.url)
  await meta(home, { op: 'page', session: 'ses_example' })
  await meta(home, { op: 'page', session: 'ses_example', cursor: 'ab+cd/e' })
  expect(p.hits.map(h => h.url)).toEqual(['/api/info',
    '/api/session/ses_example/message?limit=120&order=desc',
    '/api/info',
    '/api/session/ses_example/message?limit=120&cursor=ab%2Bcd%2Fe'])
})

it('refuses malformed, unknown-field and oversized requests before any machine work', async () => {
  const p = await peer()
  const home = mkhome(p.url)
  for (const bad of [{ op: 'delete', session: 'ses_example' }, { op: 'session' }, { op: 'session', session: '../x' },
    { op: 'session', session: '' }, { op: 'session', session: 'x'.repeat(200) }, { op: 'session', session: 'a b' },
    { op: 'session', session: '.' }, { op: 'session', session: '..' }, { op: 'session', session: 's.ession' },
    { op: 'session', session: 's\u00e9ssion' },
    { op: 'session', session: 'ses_example', cursor: 'page-only' },
    { op: 'page', session: 'ses_example', cursor: 'has space' }, { op: 'page', session: 'ses_example', cursor: 'x'.repeat(300) },
    { op: 'session', session: 'ses_example', expect: 'zz' }, { op: 'session', session: 'ses_example', extra: 1 },
    'not json', '42', '[1]']) {
    expect(await meta(home, bad as never)).toEqual({ out: { error: 'invalid_request' }, raw: expect.any(String) })
  }
  // The request's own UTF-8 cap applies before JSON parsing.
  expect(await meta(home, `{"op":"session","session":"s","pad":"${'x'.repeat(5000)}"}`)).toEqual({ out: { error: 'invalid_request' }, raw: expect.any(String) })
  expect(p.hits).toHaveLength(0)
})

it('keeps the fingerprint stable across JSON key order and isolates its inputs', async () => {
  // One mutable peer: same home, registration and pid, so the server
  // generation is constant and only the served body can move the fingerprint.
  let body = '{"data":{"id":"ses_example"},"a":1,"b":{"c":2}}'
  const p = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(JSON.stringify({ version: '2.0.27', pid: 10 })); return }
    res.end(body)
  })
  const home = mkhome(p.url)
  const one = (await meta(home, REQ)).out
  body = '{"b":{"c":2},"a":1,"data":{"id":"ses_example"}}'
  expect((await meta(home, REQ)).out.fingerprint).toBe(one.fingerprint)
  // A data change at the same origin and generation must still move it.
  body = '{"data":{"id":"ses_example"},"a":1,"b":{"c":3}}'
  expect((await meta(home, REQ)).out.fingerprint).not.toBe(one.fingerprint)
  body = '{"data":{"id":"ses_example"},"a":1,"b":{"c":2}}'
  expect((await meta(home, { op: 'session', session: 'ses_other' })).out.fingerprint).not.toBe(one.fingerprint)
  expect((await meta(home, { op: 'page', session: 'ses_example' })).out.fingerprint).not.toBe(one.fingerprint)
  expect((await meta(home, { op: 'page', session: 'ses_example', cursor: 'ab' })).out.fingerprint).not.toBe(one.fingerprint)
  const restarted = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(JSON.stringify({ version: '2.0.27', pid: 11 })); return }
    res.end(body)
  })
  expect((await meta(mkhome(restarted.url), REQ)).out.fingerprint).not.toBe(one.fingerprint)
})

it('compares a supplied fingerprint so an unchanged poll carries no data', async () => {
  const p = await peer()
  const home = mkhome(p.url)
  const first = (await meta(home, REQ)).out
  const again = (await meta(home, { ...REQ, expect: first.fingerprint })).out
  expect(again).toEqual({ status: 200, server: first.server, fingerprint: first.fingerprint, size: first.size, unchanged: true })
  expect(JSON.stringify(again)).not.toContain('ses_example')
  expect((await meta(home, { ...REQ, expect: 'a'.repeat(64) })).out.unchanged).toBe(false)
})

it('bounds raw and canonical reads on the machine', async () => {
  const mib = 1024 * 1024
  // Exactly 24 MiB is still a read; one byte over it is not.
  const exact = await peer(`["${'x'.repeat(24 * mib - 4)}"]`)
  const home = mkhome(exact.url)
  expect((await meta(home, REQ)).out).toMatchObject({ status: 200, unchanged: false })
  const over = await peer(`["${'x'.repeat(24 * mib - 2)}"]`)
  expect((await meta(mkhome(over.url), REQ)).out).toEqual({ error: 'too_large' })
  // Canonical bytes can outgrow valid raw bytes: the canonical form
  // escapes non-ASCII, so a body well under the raw ceiling still
  // crosses the canonical one while encoding.
  const wide = await peer(JSON.stringify('\u00e9'.repeat(9 * mib)))
  expect((await meta(mkhome(wide.url), REQ)).out).toEqual({ error: 'too_large' })
}, 60000)

it('keeps absence, server errors, malformed bodies and transport failures distinct', async () => {
  const p = await peer()
  const home = mkhome(p.url)
  for (const status of [404, 503]) {
    const down = await serve((req, res) => {
      if (req.url === '/api/info') { res.end(JSON.stringify({ version: '2.0.27', pid: 10 })); return }
      res.statusCode = status; res.end()
    })
    const { out } = await meta(mkhome(down.url), REQ)
    expect(out).toEqual({ status, server: expect.stringMatching(/^[a-f0-9]{32}$/) })
  }
  const bad = await peer('not json')
  expect((await meta(mkhome(bad.url), REQ)).out).toEqual({ error: 'reply_invalid' })
  // NaN/Infinity literals and overflowed exponents are not standard JSON and
  // have no canonical form to hash.
  for (const body of ['{"x":NaN}', '[Infinity]', '{"x":1e999}']) {
    const odd = await peer(body)
    expect((await meta(mkhome(odd.url), REQ)).out, body).toEqual({ error: 'reply_invalid' })
  }
  const denied = await serve((req, res) => { res.statusCode = 401; res.end() })
  expect((await meta(mkhome(denied.url), REQ)).out).toEqual({ error: 'auth' })
  const gone = await peer()
  const down = gone.url
  await gone.close()
  expect((await meta(mkhome(down), REQ)).out).toEqual({ error: 'unreachable' })
})
