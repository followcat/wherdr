import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { opencodeReadCatalog } from '../server/utils/opencodeReadCatalog'
import { OPENCODE_CATALOG } from '../server/utils/opencodeCatalog'
import { localShell } from '../server/utils/agentProcesses'
import type { ExecResult, ShellExec } from '../server/utils/fsx'

// Same owned-fixture contract as the other OpenCode tests: the real helper
// runs against an owned loopback peer and fixture HOME, with an owned default
// inert CLI stub so no installed OpenCode can ever be launched.
const homes: string[] = []
const servers: http.Server[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  for (const s of servers.splice(0)) await new Promise<void>(resolve => s.close(() => resolve()))
})

async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const hits: http.IncomingMessage[] = []
  const server = http.createServer((req, res) => { hits.push(req); handler(req, res) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits }
}
const basic = () => 'Basic ' + Buffer.from('opencode:fixture-password').toString('base64')
const mib = 1024 * 1024
const INFO = JSON.stringify({ version: '2.0.27', pid: 10 })

function mkhome(url: string | null) {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-oc-rcat-'))
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

const DIR = '/home/user/proj'
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, parentID: null, title: `t-${id}`, location: { directory: DIR, extra: 1 },
  subpath: '', metadata: { ignored: true },
  time: { created: 1000, updated: 2000 }, ...over,
})
// Native pagination: nonempty pages carry an opaque next; exhaustion is an
// empty page or an absent next.
const page = (data: unknown[], next?: string) =>
  JSON.stringify({ data, cursor: next === undefined ? {} : { next, previous: 'back' }, other: 1 })

it('returns one typed unproven observation through the real helper and owned peer', async () => {
  const p = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(INFO); return }
    res.end(req.url!.includes('cursor=') ? page([])
      : page([row('ses_a', { parentID: 'ses_p', fork: { sessionID: 'ses_f' }, subpath: 'sub' }),
              row('ses_b', { subpath: 'nested/dir', time: { created: 5, updated: 9, viewed: 7 } }),
              row('ses_c', { title: '\u{1f600} party', subpath: 'a\u{1f4c1}' })], 'k'))
  })
  const r = await opencodeReadCatalog(localShell, mkhome(p.url), { directory: DIR })
  expect(r).toMatchObject({ ok: true, directory: DIR, pages: 2, exhausted: true,
    consistency: 'unproven', server: expect.stringMatching(/^[a-f0-9]{32}$/),
    fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) })
  if (!r.ok) throw new Error(JSON.stringify(r))
  expect(r.size).toBeGreaterThanOrEqual(2)
  expect(r.rows).toEqual([
    { id: 'ses_a', parent: 'ses_p', fork: 'ses_f', title: 't-ses_a', directory: DIR,
      subpath: 'sub', created: 1000, updated: 2000, viewed: null, idle: null, archived: null },
    { id: 'ses_b', parent: null, fork: null, title: 't-ses_b', directory: DIR,
      subpath: 'nested/dir', created: 5, updated: 9, viewed: 7, idle: null, archived: null },
    { id: 'ses_c', parent: null, fork: null, title: '\u{1f600} party', directory: DIR,
      subpath: 'a\u{1f4c1}', created: 1000, updated: 2000, viewed: null, idle: null, archived: null },
  ])
  expect(p.hits.map(h => h.url)).toEqual(['/api/info',
    '/api/session?directory=%2Fhome%2Fuser%2Fproj&order=desc&limit=100',
    '/api/session?directory=%2Fhome%2Fuser%2Fproj&order=desc&limit=100&cursor=k', '/api/info'])
  expect(p.hits.every(h => h.headers.authorization === basic())).toBe(true)
}, 60000)

it('refuses invalid homes and requests before exec, and pins fixed argv and bounds', async () => {
  const calls: { script: string, args: string[], opts: { timeoutMs?: number, maxBytes?: number } }[] = []
  const fake: ShellExec = async (script, args = [], opts = {}) => {
    calls.push({ script, args, opts })
    return { code: 1, stdout: Buffer.from('{"error":"auth"}\n'), stderr: '' }
  }
  const good = { directory: DIR }
  for (const bad of [{}, { directory: 'relative' }, { directory: '/ok\0bad' }, { directory: '/ok\tbad' },
    { directory: '/ok\x1fbad' }, { directory: '/ok\x7fbad' }, { directory: '/ok\ud800bad' },
    { directory: ['/x'] }, { directory: '/ok', extra: 1 }, { directory: '/ok', cursor: 'c' },
    { directory: '/ok', maxBytes: 1 }, { directory: `/${'x'.repeat(5000)}` },
    { directory: `/${'x'.repeat(1024)}` }, { directory: `/${'\u00e9'.repeat(512)}` },
    { directory: `/${'\u00e9'.repeat(513)}` },
    ['x'], 'x', 42, null] as unknown[]) {
    expect(await opencodeReadCatalog(fake, '/home/user', bad as never), String(JSON.stringify(bad)).slice(0, 60))
      .toEqual({ ok: false, error: 'invalid_request' })
  }
  for (const home of ['relative', '/home/user\0x', `/${'x'.repeat(2000)}`]) {
    expect(await opencodeReadCatalog(fake, home, good)).toEqual({ ok: false, error: 'unavailable' })
  }
  expect(calls).toHaveLength(0)
  // Hyphenated, unicode-pair and exact-cap-edge paths are valid and exec:
  // '/' + 1023 is 1024 chars/bytes, '/' + 511 accented chars is 512
  // chars/1023 UTF-8 bytes; '/' + 512 accented chars crosses the byte cap.
  for (const directory of ['/home/user/proj-a', '/home/user/pr\u00f3j',
    '/home/user/\u{1f600}dir',
    `/${'x'.repeat(1023)}`, `/${'\u00e9'.repeat(511)}`]) {
    calls.length = 0
    expect(await opencodeReadCatalog(fake, '/home/user', { directory })).toEqual({ ok: false, error: 'auth' })
    expect(calls, directory.slice(0, 30)).toHaveLength(1)
  }
  // A valid call pins the fixed script, argv order, the fixed 30 s outer
  // budget and the fixed 5 MiB reply bound; no caller override exists.
  calls.length = 0
  await opencodeReadCatalog(fake, '/home/user', good)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.script).toBe('exec python3 -X utf8 -c "$1" "$2" "$3"')
  expect(calls[0]!.args).toEqual([OPENCODE_CATALOG, '/home/user', JSON.stringify(good)])
  expect(calls[0]!.opts.timeoutMs).toBe(30000)
  expect(calls[0]!.opts.maxBytes).toBe(5 * mib)
})

it('validates exact envelopes and rows atomically, never partial data', async () => {
  const hex32 = 'a'.repeat(32)
  const hex64 = 'b'.repeat(64)
  const req = { directory: DIR }
  const fake = (result: ExecResult): ShellExec => async () => result
  const env = (o: Record<string, unknown>) => ({ code: 0, stdout: Buffer.from(JSON.stringify(o) + '\n'), stderr: '' })
  const r1 = { id: 'ses_a', parent: null, fork: null, title: 't-a', directory: DIR, subpath: '',
    created: 1000, updated: 2000, viewed: null, idle: null, archived: null }
  const good = { status: 200, server: hex32, fingerprint: hex64, directory: DIR, pages: 1,
    size: 2, rows: [] as Record<string, unknown>[], exhausted: true, consistency: 'unproven' }
  expect(await opencodeReadCatalog(fake(env(good)), '/home/user', req))
    .toEqual({ ok: true, server: hex32, fingerprint: hex64, directory: DIR, pages: 1,
      size: 2, rows: [], exhausted: true, consistency: 'unproven' })
  const withRows = { ...good, rows: [r1], size: 100 }
  expect(await opencodeReadCatalog(fake(env(withRows)), '/home/user', req))
    .toMatchObject({ ok: true, rows: [r1] })
  // A valid astral pair is well-formed text the Python contract accepts.
  const pair = { ...r1, title: '\u{1f600} party', subpath: 'a\u{1f4c1}' }
  expect(await opencodeReadCatalog(fake(env({ ...withRows, rows: [pair] })), '/home/user', req))
    .toMatchObject({ ok: true, rows: [pair] })
  for (const bad of [
    { ...good, x: 1 }, { ...good, complete: true }, { ...good, consistency: 'proven' },
    { ...good, exhausted: false }, { ...good, directory: '/elsewhere' },
    { ...good, server: 'zz' }, { ...good, fingerprint: 'x'.repeat(64) }, { ...good, fingerprint: hex64.slice(1) },
    { ...good, pages: 0 }, { ...good, pages: 9 }, { ...good, pages: 1.5 }, { ...good, pages: '2' },
    { ...good, size: 0 }, { ...good, size: 1 }, { ...good, size: 4 * mib + 1 }, { ...good, size: 1.5 },
    { ...good, rows: 'x' }, { ...good, rows: null },
    { ...withRows, rows: [r1, r1] },
    { ...withRows, rows: [{ ...r1, x: 1 }] },
    { ...withRows, rows: [{ id: 'ses_a' }] },
    { ...withRows, rows: [{ ...r1, id: 'bad_id' }] },
    { ...withRows, rows: [{ ...r1, parent: 'nope' }] },
    { ...withRows, rows: [{ ...r1, fork: 'bad' }] },
    { ...withRows, rows: [{ ...r1, title: '\0' }] },
    { ...withRows, rows: [{ ...r1, title: 'x'.repeat(1025) }] },
    { ...withRows, rows: [{ ...r1, title: '\ud800' }] },
    { ...withRows, rows: [{ ...r1, title: 5 }] },
    { ...withRows, rows: [{ ...r1, directory: 'rel' }] },
    { ...withRows, rows: [{ ...r1, directory: '/ok\nbad' }] },
    { ...withRows, rows: [{ ...r1, subpath: 'x'.repeat(1025) }] },
    { ...withRows, rows: [{ ...r1, created: -1 }] },
    { ...withRows, rows: [{ ...r1, updated: 8640000000000001 }] },
    { ...withRows, rows: [{ ...r1, updated: 'x' }] },
    { ...withRows, rows: [{ ...r1, created: true }] },
    { ...withRows, rows: [{ ...r1, updated: null }] },
    { ...withRows, rows: [{ ...r1, viewed: -1 }] },
    { ...withRows, rows: [{ ...r1, archived: true }] },
    { ...withRows, rows: Array(513).fill(r1) },
  ]) {
    expect(await opencodeReadCatalog(fake(env(bad)), '/home/user', req), JSON.stringify(bad).slice(0, 80))
      .toEqual({ ok: false, error: 'unavailable' })
  }
  // An HTTP status is an absence with an opaque generation, nothing more.
  expect(await opencodeReadCatalog(fake(env({ status: 404, server: hex32 })), '/home/user', req))
    .toEqual({ ok: false, status: 404, server: hex32 })
  for (const bad of [{ status: 404, server: 'xx' }, { status: 404 }, { status: 99, server: hex32 },
    { status: 600, server: hex32 }, { status: 200, server: hex32 }, { status: '404', server: hex32 },
    { status: 404, server: hex32, rows: [] }]) {
    expect(await opencodeReadCatalog(fake(env(bad)), '/home/user', req), JSON.stringify(bad))
      .toEqual({ ok: false, error: 'unavailable' })
  }
  // The fixed error union only; unknown keys and secrets stay private.
  for (const e of ['not_running', 'state_invalid', 'url_unsafe', 'unsupported', 'credentials',
    'unreachable', 'auth', 'reply_invalid', 'helper_error', 'invalid_request', 'too_large',
    'snapshot_changed']) {
    const r = { code: 1, stdout: Buffer.from(`{"error":"${e}"}\n`), stderr: '' }
    expect(await opencodeReadCatalog(fake(r), '/home/user', req), e).toEqual({ ok: false, error: e })
  }
  for (const body of ['{"error":"service_rooted"}', 'not json', '',
    JSON.stringify({ status: 200, server: hex32, fingerprint: hex64, directory: DIR,
      pages: 1, size: 2, rows: [], exhausted: true, consistency: 'unproven' }) + '\n{"error":"auth"}']) {
    const r = { code: body === '' ? 0 : 1, stdout: Buffer.from(body + '\n'), stderr: '' }
    expect(await opencodeReadCatalog(fake(r), '/home/user', req), body.slice(0, 40))
      .toEqual({ ok: false, error: 'unavailable' })
  }
  // A success shape under a nonzero code is no success.
  const wrongCode = { code: 1, stdout: Buffer.from(JSON.stringify({ status: 200, server: hex32, fingerprint: hex64,
    directory: DIR, pages: 1, size: 2, rows: [], exhausted: true, consistency: 'unproven' }) + '\n'), stderr: '' }
  expect(await opencodeReadCatalog(fake(wrongCode), '/home/user', req)).toEqual({ ok: false, error: 'unavailable' })
  // The byte ceiling itself is the control: valid JSON with trailing
  // whitespace still parses, so only the bound can refuse the +1 case.
  const authBody = Buffer.from('{"error":"auth"}\n')
  const atLimit = { code: 1, stdout: Buffer.concat([authBody, Buffer.alloc(5 * mib - authBody.length, 32)]), stderr: '' }
  expect(await opencodeReadCatalog(fake(atLimit), '/home/user', req)).toEqual({ ok: false, error: 'auth' })
  const overLimit = { code: 1, stdout: Buffer.concat([authBody, Buffer.alloc(5 * mib - authBody.length + 1, 32)]), stderr: '' }
  expect(await opencodeReadCatalog(fake(overLimit), '/home/user', req)).toEqual({ ok: false, error: 'unavailable' })
  // Transport failure statuses and a thrown exec stay typed.
  expect(await opencodeReadCatalog(fake({ code: 255, stdout: Buffer.alloc(0), stderr: 'ssh' }), '/home/user', req))
    .toEqual({ ok: false, error: 'unreachable' })
  expect(await opencodeReadCatalog(fake({ code: 124, stdout: Buffer.alloc(0), stderr: 'killed' }), '/home/user', req))
    .toEqual({ ok: false, error: 'unreachable' })
  expect(await opencodeReadCatalog((async () => { throw new Error('spawn refused') }) as ShellExec, '/home/user', req))
    .toEqual({ ok: false, error: 'unavailable' })
})

it('binds the reply directory to the request as sent, not a mutable caller object', async () => {
  const hex32 = 'a'.repeat(32)
  const hex64 = 'b'.repeat(64)
  const env = (o: Record<string, unknown>) => ({ code: 0, stdout: Buffer.from(JSON.stringify(o) + '\n'), stderr: '' })
  const req = { directory: DIR }
  // A caller mutating its own object between exec and reply validation must
  // never make a forged directory match: the bound is the value submitted.
  const mutating: ShellExec = async () => {
    req.directory = '/forged-elsewhere'
    return env({ status: 200, server: hex32, fingerprint: hex64, directory: '/forged-elsewhere',
      pages: 1, size: 2, rows: [], exhausted: true, consistency: 'unproven' })
  }
  expect(await opencodeReadCatalog(mutating, '/home/user', req))
    .toEqual({ ok: false, error: 'unavailable' })
})

it('reads real missing python, no service, status and dead peer through the helper', async () => {
  // An actual subprocess with python3 scrubbed from PATH: /bin/sh still
  // launches, `exec python3` inside fails -- a genuine shell 127, not a mock.
  const missing: ShellExec = (script, args = [], opts = {}) => new Promise(resolve => {
    execFile('/bin/sh', ['-c', script, 'sh', ...args], {
      timeout: opts.timeoutMs ?? 15000, encoding: 'buffer',
      maxBuffer: (opts.maxBytes ?? 4 * mib) + 64 * 1024,
      env: { ...process.env, PATH: '/nonexistent-fixture-dir' },
    }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: unknown, killed?: boolean }) | null
      resolve({ code: !e ? 0 : e.killed ? 124 : typeof e.code === 'number' ? e.code : 1,
        stdout: stdout as Buffer, stderr: String(stderr || '') })
    })
  })
  expect(await opencodeReadCatalog(missing, mkhome(null), { directory: DIR }))
    .toEqual({ ok: false, error: 'unavailable' })
  // Real helper, no service.json: the fixed error reaches the typed union.
  expect(await opencodeReadCatalog(localShell, mkhome(null), { directory: DIR }))
    .toEqual({ ok: false, error: 'not_running' })
  // Real HTTP status passthrough: an absence with an opaque generation.
  const p404 = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(INFO); return }
    res.statusCode = 404; res.end()
  })
  expect(await opencodeReadCatalog(localShell, mkhome(p404.url), { directory: DIR }))
    .toMatchObject({ ok: false, status: 404, server: expect.stringMatching(/^[a-f0-9]{32}$/) })
  // A dead owned loopback stays unreachable through the real helper.
  const dead = http.createServer((_q, res) => res.end())
  await new Promise<void>(resolve => dead.listen(0, '127.0.0.1', resolve))
  const deadUrl = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`
  await new Promise<void>(resolve => dead.close(() => resolve()))
  expect(await opencodeReadCatalog(localShell, mkhome(deadUrl), { directory: DIR }))
    .toEqual({ ok: false, error: 'unreachable' })
}, 60000)
