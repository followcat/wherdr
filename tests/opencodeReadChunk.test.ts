import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { opencodePatchMeta, opencodeReadMeta } from '../server/utils/opencodeReadMeta'
import { opencodeReadChunk } from '../server/utils/opencodeReadChunk'
import { OPENCODE_CHUNK } from '../server/utils/opencodeChunk'
import { CHUNK_REPLY_LIMIT, replyObject } from '../server/utils/opencodeTransport'
import { localShell } from '../server/utils/agentProcesses'
import type { ExecResult, ShellExec } from '../server/utils/fsx'

// Same owned-fixture contract as the other OpenCode tests: the real helper
// runs against an owned loopback peer and fixture HOME, with an owned default
// CLI stub so no installed OpenCode can ever be launched.
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
const peer = (body: string = '{"data":{"id":"ses_example"}}') => serve((req, res) => {
  if (req.url === '/api/info') { res.end(JSON.stringify({ version: '2.0.27', pid: 10 })); return }
  res.end(body)
})

const basic = () => 'Basic ' + Buffer.from('opencode:fixture-password').toString('base64')
const REQ = { op: 'session', session: 'ses_example' } as const
const mib = 1024 * 1024

function mkhome(url: string | null) {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-oc-rchunk-'))
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

// Test-side canonicalizer matching the helper's canon(): sorted keys,
// compact separators, ASCII string escapes. Fixtures stay ASCII.
const canon = (v: unknown): string =>
  v === null ? 'null' : typeof v === 'string' ? JSON.stringify(v)
    : typeof v === 'number' || typeof v === 'boolean' ? JSON.stringify(v)
      : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
        : '{' + Object.keys(v as object).sort().map(k => canon(k) + ':' + canon((v as Record<string, unknown>)[k])).join(',') + '}'

it('runs one exact 4 MiB piece through localShell, the helper and the owned peer', async () => {
  const body = `{"z":1,"data":{"blob":"${'x'.repeat(5 * mib)}"},"a":2}`
  const p = await peer(body)
  const home = mkhome(p.url)
  const m = await opencodeReadMeta(localShell, home, REQ)
  if (!m.ok) throw new Error(`meta failed: ${JSON.stringify(m)}`)
  const r = await opencodeReadChunk(localShell, home,
    { ...REQ, server: m.server, fingerprint: m.fingerprint, size: m.size, offset: 0 })
  expect(r).toMatchObject({ ok: true, server: m.server, fingerprint: m.fingerprint, size: m.size, offset: 0 })
  if (!r.ok) throw new Error(`chunk failed: ${JSON.stringify(r)}`)
  const expected = Buffer.from(canon(JSON.parse(body)), 'utf8')
  expect(r.piece.length).toBe(4 * mib)
  // Content proven by hash so a failure never dumps a multi-MiB payload.
  expect(createHash('sha256').update(r.piece).digest('hex'))
    .toBe(createHash('sha256').update(expected.subarray(0, 4 * mib)).digest('hex'))
  expect(p.hits.map(h => h.url)).toEqual(['/api/info', '/api/session/ses_example',
    '/api/info', '/api/session/ses_example', '/api/info'])
  expect(p.hits.every(h => h.headers.authorization === basic())).toBe(true)
}, 60000)

it('serves a patch descriptor through the same fixed session read', async () => {
  // The post-write re-GET is a chunk read on the session's own path bound to
  // the post-patch fingerprint — the whitelisted write never widens the read
  // surface.
  const body = '{"data":{"id":"ses_example","model":{"id":"m-1","providerID":"acme"}}}'
  const p = await peer(body)
  const home = mkhome(p.url)
  const m = await opencodePatchMeta(localShell, home,
    { op: 'patch', session: 'ses_example', model: { id: 'm-1', providerID: 'acme' } })
  if (!m.ok) throw new Error(`patch meta failed: ${JSON.stringify(m)}`)
  const r = await opencodeReadChunk(localShell, home,
    { op: 'patch', session: 'ses_example', server: m.server, fingerprint: m.fingerprint, size: m.size, offset: 0 })
  expect(r).toMatchObject({ ok: true, server: m.server, fingerprint: m.fingerprint, size: m.size, offset: 0 })
  if (!r.ok) throw new Error(`chunk failed: ${JSON.stringify(r)}`)
  expect(r.piece.toString('utf8')).toBe(canon(JSON.parse(body)))
  expect(p.hits.map(h => `${h.method} ${h.url}`)).toEqual(
    ['GET /api/info', 'PATCH /api/session/ses_example', 'GET /api/session/ses_example',
      'GET /api/info', 'GET /api/session/ses_example', 'GET /api/info'])
  expect(p.hits.filter(h => h.method === 'PATCH')).toHaveLength(1)
}, 60000)

it('refuses invalid homes and descriptors before exec, and fixes argv/bounds on valid calls', async () => {
  const calls: { script: string, args: string[], opts: { timeoutMs?: number, maxBytes?: number } }[] = []
  const fake: ShellExec = async (script, args = [], opts = {}) => {
    calls.push({ script, args, opts })
    return { code: 0, stdout: Buffer.alloc(0), stderr: '' }
  }
  const hex32 = 'a'.repeat(32)
  const hex64 = 'b'.repeat(64)
  const good = { op: 'session', session: 'ses_example', server: hex32, fingerprint: hex64, size: 12, offset: 0 }
  for (const bad of [{ ...good, op: 'delete' }, { ...good, extra: 1 }, { ...good, session: '../x' },
    { ...good, session: 's\u00e9ssion' }, { ...good, cursor: 'page-only' }, { ...good, cursor: null },
    { ...good, op: 'page', cursor: null }, { ...good, op: 'page', cursor: 'a b' },
    { ...good, server: 'zz' }, { ...good, fingerprint: 'xx' }, { ...good, size: true }, { ...good, size: 1.5 },
    { ...good, size: -1 }, { ...good, size: NaN }, { ...good, size: Infinity }, { ...good, size: 25 * mib },
    { ...good, offset: -1 }, { ...good, offset: 0.5 }, { ...good, offset: NaN }, { ...good, offset: 13 },
    'not json', 42, null]) {
    expect(await opencodeReadChunk(fake, '/home/user', bad as never), String(JSON.stringify(bad)).slice(0, 60))
      .toEqual({ ok: false, error: 'invalid_request' })
  }
  for (const home of ['relative', '/home/user\0x', `/${'x'.repeat(2000)}`]) {
    expect(await opencodeReadChunk(fake, home, good)).toEqual({ ok: false, error: 'unavailable' })
  }
  expect(calls).toHaveLength(0)
  // A valid call pins the fixed script, argv order and a derived reply bound:
  // 12 raw bytes at offset 0 are 16 base64 chars plus a small fixed envelope.
  await opencodeReadChunk(fake, '/home/user', good, { timeoutMs: 60000 })
  expect(calls).toHaveLength(1)
  expect(calls[0]!.script).toBe('exec python3 -X utf8 -c "$1" "$2" "$3"')
  expect(calls[0]!.args).toEqual([OPENCODE_CHUNK, '/home/user', JSON.stringify(good)])
  expect(calls[0]!.opts.maxBytes).toBe(4 * Math.ceil(12 / 3) + 256)
  expect(calls[0]!.opts.timeoutMs).toBe(30000)
  // The bound follows the expected piece, capped at the 4 MiB helper window.
  await opencodeReadChunk(fake, '/home/user', { ...good, size: 6 * mib, offset: mib }, { timeoutMs: 0 })
  expect(calls[1]!.opts.maxBytes).toBe(4 * Math.ceil(4 * mib / 3) + 256)
  expect(calls[1]!.opts.timeoutMs).toBe(1)
})

it('validates exact success, status and error envelopes against the descriptor', async () => {
  const hex32 = 'a'.repeat(32)
  const hex64 = 'b'.repeat(64)
  const desc = { op: 'session', session: 'ses_example', server: hex32, fingerprint: hex64, size: 5, offset: 0 }
  const fake = (result: ExecResult): ShellExec => async () => result
  const env = (o: Record<string, unknown>) => ({ code: 0, stdout: Buffer.from(JSON.stringify(o) + '\n'), stderr: '' })
  // Canonical success: exactly the descriptor's context, exactly 5 raw bytes.
  expect(await opencodeReadChunk(fake(env({ status: 200, server: hex32, fingerprint: hex64, size: 5, offset: 0, piece: 'QUJDREU=' })), '/home/user', desc))
    .toEqual({ ok: true, server: hex32, fingerprint: hex64, size: 5, offset: 0, piece: Buffer.from('ABCDE') })
  // A terminal offset==size read succeeds with an empty piece.
  expect(await opencodeReadChunk(fake(env({ status: 200, server: hex32, fingerprint: hex64, size: 5, offset: 5, piece: '' })),
    '/home/user', { ...desc, offset: 5 }))
    .toEqual({ ok: true, server: hex32, fingerprint: hex64, size: 5, offset: 5, piece: Buffer.alloc(0) })
  // Any mixed context is not this descriptor's piece.
  for (const diff of [{ server: 'c'.repeat(32) }, { fingerprint: 'd'.repeat(64) }, { size: 6 }, { offset: 4 }]) {
    const r = env({ status: 200, server: hex32, fingerprint: hex64, size: 5, offset: 0, piece: 'QUJDREU=', ...diff })
    expect(await opencodeReadChunk(fake(r), '/home/user', desc), JSON.stringify(diff)).toEqual({ ok: false, error: 'unavailable' })
  }
  // HTTP absence/error must still carry the expected server generation.
  expect(await opencodeReadChunk(fake(env({ status: 404, server: hex32 })), '/home/user', desc)).toEqual({ ok: false, status: 404, server: hex32 })
  expect(await opencodeReadChunk(fake(env({ status: 404, server: 'c'.repeat(32) })), '/home/user', desc)).toEqual({ ok: false, error: 'unavailable' })
  for (const e of ['snapshot_changed', 'invalid_request', 'too_large', 'auth', 'unreachable', 'helper_error']) {
    const r = { code: 1, stdout: Buffer.from(`{"error":"${e}"}\n`), stderr: '' }
    expect(await opencodeReadChunk(fake(r), '/home/user', desc), e).toEqual({ ok: false, error: e })
  }
  const forged = { code: 1, stdout: Buffer.from('{"error":"service_rooted"}\n'), stderr: '' }
  expect(await opencodeReadChunk(fake(forged), '/home/user', desc)).toEqual({ ok: false, error: 'unavailable' })
  // Malformed, mixed-field, secret-carrying and multi-JSON replies fail closed.
  for (const body of ['not json',
    `{"status":200,"server":"${hex32}","fingerprint":"${hex64}","size":5,"offset":0,"piece":"QUJDREU=","x":1}`,
    `{"status":200,"server":"${hex32}","fingerprint":"${hex64}","size":5,"offset":0,"piece":"QUJDREU=","password":"fixture"}`,
    `{"status":200,"server":"${hex32}","fingerprint":"${hex64}","size":5,"offset":0}`,
    `{"status":200,"server":"${hex32}"}`,
    `{"status":99,"server":"${hex32}"}`, `{"status":600,"server":"${hex32}"}`, `{"status":404}`, `{"status":404,"server":"xyz"}`,
    `{"status":404,"server":"${hex32}","piece":"AAAA"}`,
    `{"status":200,"server":"${hex32}","fingerprint":"${hex64}","size":5,"offset":0,"piece":"QUJDREU="}\n{"error":"auth"}`]) {
    const r = { code: 0, stdout: Buffer.from(body + '\n'), stderr: '' }
    expect(await opencodeReadChunk(fake(r), '/home/user', desc), body.slice(0, 60)).toEqual({ ok: false, error: 'unavailable' })
  }
  // A success shape under a nonzero code is no success; bytes past the
  // derived bound are refused before decode.
  const wrongCode = { code: 1, stdout: Buffer.from(`{"status":200,"server":"${hex32}","fingerprint":"${hex64}","size":5,"offset":0,"piece":"QUJDREU="}\n`), stderr: '' }
  expect(await opencodeReadChunk(fake(wrongCode), '/home/user', desc)).toEqual({ ok: false, error: 'unavailable' })
  const padded = { code: 0, stdout: Buffer.from(`{"status":200,"server":"${hex32}","fingerprint":"${hex64}","size":5,"offset":0,"piece":"QUJDREU="}${' '.repeat(400)}\n`), stderr: '' }
  expect(await opencodeReadChunk(fake(padded), '/home/user', desc)).toEqual({ ok: false, error: 'unavailable' })
  // Transport and missing-Python diagnostics stay on the machine.
  expect(await opencodeReadChunk(fake({ code: 255, stdout: Buffer.alloc(0), stderr: 'unreachable' }), '/home/user', desc))
    .toEqual({ ok: false, error: 'unreachable' })
  expect(await opencodeReadChunk(fake({ code: 127, stdout: Buffer.alloc(0), stderr: 'python3: not found' }), '/home/user', desc))
    .toEqual({ ok: false, error: 'unavailable' })
})

it('accepts only canonical base64 for exactly the expected byte count', async () => {
  const hex32 = 'a'.repeat(32)
  const hex64 = 'b'.repeat(64)
  const desc = { op: 'session', session: 'ses_example', server: hex32, fingerprint: hex64, size: 5, offset: 0 }
  const fake = (piece: unknown): ShellExec => async () => ({
    code: 0,
    stdout: Buffer.from(`{"status":200,"server":"${hex32}","fingerprint":"${hex64}","size":5,"offset":0,"piece":${JSON.stringify(piece)}}\n`),
    stderr: ''
  })
  expect(await opencodeReadChunk(fake('QUJDREU='), '/home/user', desc)).toMatchObject({ ok: true })
  // Truncation, wrong length, whitespace, stray alphabet, wrong padding and
  // noncanonical unused low bits all fail; Buffer.from('base64') alone would
  // silently decode several of these.
  for (const piece of ['QUJDREU', 'QUJDREU==', 'QUJDREUA', 'QUJDRE==', 'QUJDREV=', 'QUJDRE!B', 'QUJD EU=', 'QUJD', 5, null]) {
    expect(await opencodeReadChunk(fake(piece), '/home/user', desc), String(piece)).toEqual({ ok: false, error: 'unavailable' })
  }
  // 1 byte: canonical 'YQ==' is accepted; 'YR==' carries nonzero unused low
  // bits under the same '==' padding and permissive decoders keep it.
  const one = { ...desc, size: 1, offset: 0 }
  const fake1 = (piece: unknown): ShellExec => async () => ({
    code: 0,
    stdout: Buffer.from(`{"status":200,"server":"${hex32}","fingerprint":"${hex64}","size":1,"offset":0,"piece":${JSON.stringify(piece)}}\n`),
    stderr: ''
  })
  expect(await opencodeReadChunk(fake1('YQ=='), '/home/user', one))
    .toEqual({ ok: true, server: hex32, fingerprint: hex64, size: 1, offset: 0, piece: Buffer.from('a') })
  expect(await opencodeReadChunk(fake1('YR=='), '/home/user', one)).toEqual({ ok: false, error: 'unavailable' })
  // 3 bytes: a whole group, no padding at all.
  const three = { ...desc, size: 3, offset: 0 }
  const fake3 = (piece: unknown): ShellExec => async () => ({
    code: 0,
    stdout: Buffer.from(`{"status":200,"server":"${hex32}","fingerprint":"${hex64}","size":3,"offset":0,"piece":${JSON.stringify(piece)}}\n`),
    stderr: ''
  })
  expect(await opencodeReadChunk(fake3('QUJD'), '/home/user', three))
    .toEqual({ ok: true, server: hex32, fingerprint: hex64, size: 3, offset: 0, piece: Buffer.from('ABC') })
  expect(await opencodeReadChunk(fake3('QUJD='), '/home/user', three)).toEqual({ ok: false, error: 'unavailable' })
})

it('bounds replyObject by an explicit limit only inside the fixed ceiling', () => {
  const r = { code: 0, stdout: Buffer.from('{"error":"auth"}\n'), stderr: '' }
  // The default and valid explicit limits still parse valid JSON.
  expect(replyObject(r)).toEqual({ error: 'auth' })
  expect(replyObject(r, r.stdout.length)).toEqual({ error: 'auth' })
  expect(replyObject(r, CHUNK_REPLY_LIMIT)).toEqual({ error: 'auth' })
  // Zero, negative, fractional, non-finite and over-ceiling limits are
  // refused outright, and the byte bound itself still applies.
  for (const limit of [0, -1, 1.5, NaN, Infinity, -Infinity, CHUNK_REPLY_LIMIT + 1, 1e18, r.stdout.length - 1]) {
    expect(replyObject(r, limit), String(limit)).toBeNull()
  }
})
