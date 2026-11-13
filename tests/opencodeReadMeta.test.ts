import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { OPENCODE_META } from '../server/utils/opencodeTransport'
import { opencodePatchMeta, opencodeReadMeta } from '../server/utils/opencodeReadMeta'
import { localShell } from '../server/utils/agentProcesses'
import type { ExecResult, ShellExec } from '../server/utils/fsx'

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

it('opencodeReadMeta runs the fixed read on the owning machine through ShellExec', async () => {
  const p = await peer()
  const home = mkhome(p.url)
  const r = await opencodeReadMeta(localShell, home, REQ)
  expect(r).toEqual({ ok: true, server: expect.stringMatching(/^[a-f0-9]{32}$/),
    fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), size: expect.any(Number), unchanged: false })
  expect(p.hits.map(h => h.url)).toEqual(['/api/info', '/api/session/ses_example'])
})

it('opencodeReadMeta refuses invalid requests and homes before exec', async () => {
  const calls: string[][] = []
  const fake: ShellExec = async (_script, args = []) => {
    calls.push(args)
    return { code: 0, stdout: Buffer.from('{"status":200,"server":"' + 'a'.repeat(32) + '","fingerprint":"' + 'b'.repeat(64) + '","size":4,"unchanged":false}\n'), stderr: '' }
  }
  for (const bad of [{ op: 'delete', session: 's' }, { op: 'session', session: '../x' },
    { op: 'session', session: 's', extra: 1 }, { op: 'page', session: 's', cursor: 'a b' },
    { op: 'session', session: 's', expect: 'zz' }, 'session', 7]) {
    expect(await opencodeReadMeta(fake, '/home/user', bad as never)).toEqual({ ok: false, error: 'invalid_request' })
  }
  for (const home of ['relative', '/home/user\0x']) {
    expect(await opencodeReadMeta(fake, home, REQ)).toEqual({ ok: false, error: 'unavailable' })
  }
  expect(calls).toHaveLength(0)
})

it('opencodeReadMeta validates the reply envelope byte bound and exact fields', async () => {
  const hex32 = 'a'.repeat(32)
  const hex64 = 'b'.repeat(64)
  const fake = (result: ExecResult): ShellExec => async () => result
  const good = { code: 0, stdout: Buffer.from(`{"status":200,"server":"${hex32}","fingerprint":"${hex64}","size":12,"unchanged":true}\n`), stderr: '' }
  expect(await opencodeReadMeta(fake(good), '/home/user', { ...REQ, expect: hex64 }))
    .toEqual({ ok: true, server: hex32, fingerprint: hex64, size: 12, unchanged: true })
  const missing = { code: 0, stdout: Buffer.from(`{"status":404,"server":"${hex32}"}\n`), stderr: '' }
  expect(await opencodeReadMeta(fake(missing), '/home/user', REQ)).toEqual({ ok: false, status: 404, server: hex32 })
  const denied = { code: 1, stdout: Buffer.from('{"error":"auth"}\n'), stderr: '' }
  expect(await opencodeReadMeta(fake(denied), '/home/user', REQ)).toEqual({ ok: false, error: 'auth' })
  const invalid = { code: 1, stdout: Buffer.from('{"error":"invalid_request"}\n'), stderr: '' }
  expect(await opencodeReadMeta(fake(invalid), '/home/user', REQ)).toEqual({ ok: false, error: 'invalid_request' })
  for (const body of ['not json', `{"status":200,"server":"${hex32}","fingerprint":"${hex64}","size":12,"unchanged":false,"x":1}`,
    `{"status":200,"server":"${hex32}","fingerprint":"xyz","size":12,"unchanged":false}`,
    `{"status":200,"server":"${hex32}","fingerprint":"${hex64}","size":-1,"unchanged":false}`,
    `{"status":200,"server":"${hex32}","fingerprint":"${hex64}","size":99999999,"unchanged":false}`,
    `{"status":99,"server":"${hex32}"}`, `{"status":600,"server":"${hex32}"}`,
    `{"status":200,"server":"${hex32}"}`,
    `{"status":404}`, `{"status":404,"server":"xyz"}`,
    `{"status":200,"server":"${hex32}","fingerprint":"${hex64}","size":12,"unchanged":false}\n{"error":"auth"}`,
    `{"status":404,"server":"${hex32}"}${' '.repeat(8193)}`]) {
    const r = { code: 0, stdout: Buffer.from(body + '\n'), stderr: '' }
    expect(await opencodeReadMeta(fake(r), '/home/user', REQ), body.slice(0, 60)).toEqual({ ok: false, error: 'unavailable' })
  }
  const lost = { code: 255, stdout: Buffer.alloc(0), stderr: 'unreachable' }
  expect(await opencodeReadMeta(fake(lost), '/home/user', REQ)).toEqual({ ok: false, error: 'unreachable' })
  const dead = { code: 127, stdout: Buffer.alloc(0), stderr: 'python3: not found' }
  expect(await opencodeReadMeta(fake(dead), '/home/user', REQ)).toEqual({ ok: false, error: 'unavailable' })
})

// ------------------------------------------------------------------ patch
const MODEL = { id: 'm-1', providerID: 'acme', variant: 'high' } as const

it('PATCHes the session path with the exact whitelisted body, then re-GETs it', async () => {
  const patches: { url?: string, method?: string, auth?: string, body: string }[] = []
  const p = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(JSON.stringify({ version: '2.0.27', pid: 10 })); return }
    if (req.method === 'PATCH') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => { patches.push({ url: req.url, method: req.method, auth: req.headers.authorization, body }); res.end('{"data":{"id":"ses_example","model":{"id":"m-1","providerID":"acme","variant":"high"}}}') })
      return
    }
    res.end('{"data":{"id":"ses_example","model":{"id":"m-1","providerID":"acme","variant":"high"}}}')
  })
  const home = mkhome(p.url)
  const { out, raw } = await meta(home, { op: 'patch', session: 'ses_example', model: MODEL })
  expect(out).toEqual({ status: 200, server: expect.stringMatching(/^[a-f0-9]{32}$/),
    fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), size: expect.any(Number), unchanged: false })
  // One write only: PATCH on the session's own fixed path, Basic auth, the
  // exact {model:{id,providerID,variant}} body — then the re-GET that proves
  // the post-patch descriptor.
  expect(patches).toEqual([{ url: '/api/session/ses_example', method: 'PATCH', auth: basic(),
    body: '{"model": {"id": "m-1", "providerID": "acme", "variant": "high"}}' }])
  expect(p.hits.map(h => `${h.method} ${h.url}`)).toEqual(
    ['GET /api/info', 'PATCH /api/session/ses_example', 'GET /api/session/ses_example'])
  expect(raw).not.toMatch(/fixture-password|127\.0\.0\.1|service\.json/)
})

it('refuses malformed patch requests and keeps reads free of writes', async () => {
  const p = await peer()
  const home = mkhome(p.url)
  for (const bad of [{ op: 'patch' }, { op: 'patch', session: 'ses_example' },
    { op: 'patch', session: '../x', model: MODEL }, { op: 'patch', session: 'ses_example', model: MODEL, expect: 'a'.repeat(64) },
    { op: 'patch', session: 'ses_example', model: MODEL, cursor: 'x' }, { op: 'patch', session: 'ses_example', model: MODEL, extra: 1 },
    { op: 'patch', session: 'ses_example', model: 'm-1' }, { op: 'patch', session: 'ses_example', model: { id: 'm-1' } },
    { op: 'patch', session: 'ses_example', model: { providerID: 'acme' } },
    { op: 'patch', session: 'ses_example', model: { id: '', providerID: 'acme' } },
    { op: 'patch', session: 'ses_example', model: { id: 'm-1', providerID: 'acme', variant: 3 } },
    { op: 'patch', session: 'ses_example', model: { id: 'm-1', providerID: 'acme', path: '/api/config' } },
    { op: 'patch', session: 'ses_example', model: { id: 'm-1', providerID: 'acme', variant: 'x'.repeat(300) } },
    { op: 'patch', session: 'ses_example', model: { id: 'm-1', providerID: 'acme', variant: 'x\ny' } },
    { op: 'session', session: 'ses_example', model: MODEL },
    { op: 'models', model: MODEL }]) {
    expect(await meta(home, bad as never), JSON.stringify(bad)).toEqual({ out: { error: 'invalid_request' }, raw: expect.any(String) })
  }
  expect(p.hits).toHaveLength(0)
})

it('maps PATCH absence, auth and server errors through the same fixed envelope', async () => {
  for (const code of [401, 403, 404, 500]) {
    const p = await serve((req, res) => {
      if (req.url === '/api/info') { res.end(JSON.stringify({ version: '2.0.27', pid: 10 })); return }
      res.writeHead(code).end()
    })
    const home = mkhome(p.url)
    const { out } = await meta(home, { op: 'patch', session: 'ses_example', model: MODEL })
    // 401/403 are auth on the machine; every other status is a fixed
    // absence descriptor — the post-patch GET never runs on a failed write.
    if (code === 401 || code === 403)
      expect(out).toEqual({ error: 'auth' })
    else
      expect(out).toEqual({ status: code, server: expect.stringMatching(/^[a-f0-9]{32}$/) })
    expect(p.hits.filter(h => h.method === 'GET' && h.url === '/api/session/ses_example')).toHaveLength(0)
  }
})

it('opencodePatchMeta refuses read-shape and malformed requests before exec', async () => {
  const calls: string[][] = []
  const fake: ShellExec = async (_script, args = []) => {
    calls.push(args)
    return { code: 0, stdout: Buffer.from('{"status":200,"server":"' + 'a'.repeat(32) + '","fingerprint":"' + 'b'.repeat(64) + '","size":4,"unchanged":false}\n'), stderr: '' }
  }
  for (const bad of [REQ, { op: 'patch', session: 'ses_example' },
    { op: 'patch', session: 'ses_example', model: { id: 'm', providerID: 'p', extra: 1 } },
    { op: 'patch', session: 'ses_example', model: MODEL, expect: 'b'.repeat(64) },
    'patch', 7, { op: 'patch', session: 'ses_example', model: MODEL, x: 1 }]) {
    expect(await opencodePatchMeta(fake, '/home/user', bad as never)).toEqual({ ok: false, error: 'invalid_request' })
  }
  // A write never enters through the read wrapper.
  expect(await opencodeReadMeta(fake, '/home/user', { op: 'patch', session: 'ses_example' })).toEqual({ ok: false, error: 'invalid_request' })
  expect(await opencodeReadMeta(fake, '/home/user', { op: 'patch', session: 'ses_example', model: MODEL })).toEqual({ ok: false, error: 'invalid_request' })
  const good = await opencodePatchMeta(fake, '/home/user', { op: 'patch', session: 'ses_example', model: MODEL })
  expect(good).toMatchObject({ ok: true, server: 'a'.repeat(32) })
  expect(calls).toHaveLength(1)
})
