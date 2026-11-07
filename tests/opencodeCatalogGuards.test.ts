import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { OPENCODE_CATALOG } from '../server/utils/opencodeCatalog'
import { localShell } from '../server/utils/agentProcesses'

// Remaining helper-level guard matrix on the same owned fixtures: the real
// helper runs through localShell against an owned loopback peer and fixture
// HOME with an inert CLI stub so installed OpenCode can never launch.
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
const mib = 1024 * 1024
const INFO = JSON.stringify({ version: '2.0.27', pid: 10 })

function mkhome(url: string | null) {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-oc-catg-'))
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
// Native pagination: nonempty pages carry an opaque next; exhaustion is an empty page or absent next.
const page = (data: unknown[], next?: string) =>
  JSON.stringify({ data, cursor: next === undefined ? {} : { next, previous: 'back' }, other: 1 })

const read = (home: string, req: Record<string, unknown> = { directory: DIR }) =>
  localShell('exec python3 -X utf8 -c "$1" "$2" "$3"', [OPENCODE_CATALOG, home, JSON.stringify(req)],
    { timeoutMs: 30000, maxBytes: 5 * mib })
const out = (r: Awaited<ReturnType<typeof read>>): Record<string, unknown> =>
  JSON.parse(r.stdout.toString('utf8').trim())

// Every malformed value is an independent case: one failure must never hide
// the behavior of the next control. The pure parser matrix owns row-field
// rules; these are representative real-HTTP refusals plus envelope/traversal
// shapes it cannot see.
const malformed: [string, (n: number) => string][] = [
  ['envelope not dict', () => '[1]'],
  ['body not json', () => 'not json at all'],
  ['data missing', () => JSON.stringify({ cursor: {} })],
  ['data not list', () => JSON.stringify({ data: {}, cursor: {} })],
  ['cursor missing', () => JSON.stringify({ data: [] })],
  ['cursor not object', () => JSON.stringify({ data: [], cursor: 'x' })],
  ['next not string', () => JSON.stringify({ data: [row('ses_a')], cursor: { next: 5 } })],
  ['next overbound', () => JSON.stringify({ data: [row('ses_a')], cursor: { next: 'x'.repeat(257) } })],
  ['next unprintable', () => JSON.stringify({ data: [row('ses_a')], cursor: { next: 'a\tb' } })],
  ['row not dict', () => page([['x']])],
  ['row bad id', () => page([row('bad_id')])],
  ['row missing location', () => page([{ id: 'ses_a' }])],
  ['dup id same page', () => page([row('ses_a'), row('ses_a')])],
  ['dup id across pages', n => n === 0 ? page([row('ses_a')], 'c') : page([row('ses_a')])],
  ['cursor cycle', n => n === 0 ? page([row('ses_a')], 'loop') : page([row('ses_b')], 'loop')],
]
it.each(malformed)('fails malformed: %s', async (_name, body) => {
  const p = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(INFO); return }
    res.end(body(req.url!.includes('cursor=') ? 1 : 0))
  })
  const r = await read(mkhome(p.url))
  expect(r.code).toBe(1)
  // A fixed error and never partial collected rows.
  expect(out(r)).toEqual({ error: 'reply_invalid' })
}, 120000)

// Each bound is independent at its exact edge.
const bounded: [string, (n: number, res: http.ServerResponse) => void, Record<string, unknown>][] = [
  // 7 nonempty pages + a native empty page: 8 requests, success.
  ['8 requests edge', (n, res) => res.end(n < 7 ? page([row(`ses_${n}`)], `c${n}`) : page([])),
    { status: 200, pages: 8 }],
  // Content that never ends is refused before the ninth read: 8 reads made.
  ['9th attempt refused', (n, res) => res.end(page([row(`ses_${n}`)], `c${n}`)),
    { error: 'too_large', catalogHits: 8 }],
  // Row caps with the native limit=100 shape: 512 rows land on six data
  // pages (100x5 + 12) then an empty exhaustion page -- seven requests.
  ['512 rows edge', (n, res) => res.end(n < 6
      ? page(Array.from({ length: Math.min(100, 512 - n * 100) },
          (_x, i) => row(`ses_${n * 100 + i}`)), `c${n}`) : page([])),
    { status: 200, pages: 7, rowsCount: 512 }],
  // The cap crosses during the sixth data page: exactly 513 rows exist
  // (100x5 + 13), then an empty exhaustion page if a wrong cap continued.
  ['513 rows refused', (n, res) => res.end(n < 6
      ? page(Array.from({ length: n < 5 ? 100 : 13 },
          (_x, i) => row(`ses_${n * 100 + i}`)), `c${n}`) : page([])),
    { error: 'too_large', catalogHits: 6 }],
  ['24 MiB page edge', (_n, res) => {
    const h = '{"data":[],"cursor":{},"pad":"'
    res.end(h + 'x'.repeat(24 * mib - h.length - 2) + '"}')
  }, { status: 200 }],
  ['24 MiB+1 refused', (_n, res) => {
    const h = '{"data":[],"cursor":{},"pad":"'
    res.end(h + 'x'.repeat(24 * mib - h.length - 2 + 1) + '"}')
  }, { error: 'too_large' }],
  // Summed raw over the aggregate: distinct nonempty rows and cursors so no
  // loop or empty shortcut can mask the byte budget.
  ['summed raw refused', (n, res) => res.end(page([row(`ses_${n}`)], `c${n}`)
    .replace('"other":1', `"pad":"${'x'.repeat(13 * mib)}","other":1`)), { error: 'too_large' }],
]
it.each(bounded)('bounds: %s', async (_name, handler, expected) => {
  let n = 0
  const p = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(INFO); return }
    handler(n++, res)
  })
  const o = out(await read(mkhome(p.url)))
  const { rowsCount, catalogHits, ...match } = expected
  if ('error' in expected) expect(o).toEqual({ error: expected.error })
  else expect(o).toMatchObject(match)
  if (rowsCount !== undefined) expect((o.rows as unknown[]).length).toBe(rowsCount)
  if (catalogHits !== undefined)
    expect(p.hits.filter(h => h.url !== '/api/info')).toHaveLength(catalogHits as number)
}, 120000)

it('fingerprints track observed content, context and generation, never completeness', async () => {
  let served: Record<string, unknown>[] = [row('ses_a')]
  let pid = 10
  const p = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(JSON.stringify({ version: '2.0.27', pid })); return }
    res.end(req.url!.includes('cursor=') ? page([]) : page(served, 'k'))
  })
  const home = mkhome(p.url)
  const a = out(await read(home)); const a2 = out(await read(home))
  expect(a.fingerprint).toBe(a2.fingerprint)
  // The same reduced row under a different raw key order: reduction and
  // canon normalize it -- identical fingerprint.
  served = [{ title: 't-ses_a', subpath: '', parentID: null, id: 'ses_a',
    metadata: { ignored: true }, location: { extra: 1, directory: DIR },
    time: { updated: 2000, created: 1000 } }]
  expect(out(await read(home)).fingerprint).toBe(a.fingerprint)
  // Churn: a row's updated moves between walks -- the fingerprint observes
  // the change; neither walk is a proven candidate set.
  served = [row('ses_a', { time: { created: 1000, updated: 3000 } })]
  const churn = out(await read(home))
  expect(churn.fingerprint).not.toBe(a.fingerprint)
  // Same rows under a different exact directory are a different context.
  expect(out(await read(home, { directory: '/home/user/other' })).fingerprint).not.toBe(churn.fingerprint)
  // A different generation is a different fingerprint and server.
  pid = 20
  const regen = out(await read(home))
  expect(regen.server).not.toBe(a.server)
  expect(regen.fingerprint).not.toBe(a.fingerprint)
}, 60000)

it('rejects an owned registration mutation during the walk, same endpoint and credentials', async () => {
  // The owned service.json is rewritten mid-walk at the same URL, pid and
  // password; revalidation discovers a different registration and refuses
  // -- never mixed rows from two registrations.
  let svc = '', swapped = false
  const p = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(INFO); return }
    if (!req.url!.includes('cursor=')) {
      res.end(page([row('ses_a')], 'c'))
      writeFileSync(svc, JSON.stringify({ id: 'fixture2', version: '2.0.27', url: p.url, pid: 10, password: 'fixture-password' }))
      swapped = true
      return
    }
    res.end(page([]))
  })
  const home = mkhome(p.url)
  svc = path.join(home, '.local/state/opencode/service.json')
  const r = await read(home)
  expect(swapped).toBe(true)
  expect(JSON.parse(readFileSync(svc, 'utf8')).id).toBe('fixture2')
  expect(r.code).toBe(1)
  expect(out(r)).toEqual({ error: 'snapshot_changed' })
}, 60000)

it('discards the whole observation when the info pid changes mid-walk', async () => {
  let pid = 10
  let catalogs = 0
  const p = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(JSON.stringify({ version: '2.0.27', pid })); return }
    catalogs += 1
    if (catalogs === 1) { res.end(page([row('ses_a')], 'c2')); pid = 20; return }
    res.end(page([]))
  })
  const r = await read(mkhome(p.url))
  expect(r.code).toBe(1)
  expect(out(r)).toEqual({ error: 'snapshot_changed' })
}, 60000)

it.each([401, 403])('auth %s after valid info: fixed error, no rows', async status => {
  const p = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(INFO); return }
    res.statusCode = status; res.end()
  })
  const r = await read(mkhome(p.url))
  expect(r.code).toBe(1)
  expect(out(r)).toEqual({ error: 'auth' })
}, 60000)

it('keeps request, status and transport distinctions exact', async () => {
  const home = mkhome(null)
  // Invalid requests never reach the machine: fixed shape only.
  for (const req of [{}, { directory: 'relative' }, { directory: '/ok\0bad' },
    { directory: '/ok\tbad' }, { directory: '/ok\x1fbad' }, { directory: '/ok\x7fbad' },
    { directory: ['/x'] }, { directory: '/ok', extra: 1 }, { directory: '/ok', cursor: 'c' },
    { directory: `/${'x'.repeat(5000)}` }, ['x'] as unknown as Record<string, unknown>]) {
    const r = await localShell('exec python3 -X utf8 -c "$1" "$2" "$3"',
      [OPENCODE_CATALOG, home, JSON.stringify(req)], { timeoutMs: 15000, maxBytes: 8192 })
    expect(out(r), JSON.stringify(req)).toEqual({ error: 'invalid_request' })
  }
  // A hyphenated absolute directory is a valid request: it reaches the
  // query, url-encoded exactly.
  const hy = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(INFO); return }
    res.end(req.url!.includes('cursor=') ? page([]) : page([row('ses_a')], 'k'))
  })
  const o = out(await read(mkhome(hy.url), { directory: '/home/user/proj-a' }))
  expect(o).toMatchObject({ status: 200, directory: '/home/user/proj-a' })
  expect(hy.hits[1]!.url).toBe('/api/session?directory=%2Fhome%2Fuser%2Fproj-a&order=desc&limit=100')
  // Status/auth/absence distinctions.
  const p404 = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(INFO); return }
    res.statusCode = 404; res.end()
  })
  const r404 = await read(mkhome(p404.url))
  expect(r404.code).toBe(0)
  expect(out(r404)).toEqual({ status: 404, server: expect.stringMatching(/^[a-f0-9]{32}$/) })
  // A mid-walk status never returns partial rows.
  let hits = 0
  const half = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(INFO); return }
    hits += 1
    if (hits === 1) { res.end(page([row('ses_a')], 'c2')); return }
    res.statusCode = 500; res.end()
  })
  const r500 = await read(mkhome(half.url))
  expect(r500.code).toBe(0)
  expect(out(r500)).toEqual({ status: 500, server: expect.stringMatching(/^[a-f0-9]{32}$/) })
  // No service at all.
  const rNone = await read(mkhome(null))
  expect(rNone.code).toBe(1)
  expect(out(rNone)).toEqual({ error: 'not_running' })
  // A dead loopback stays unreachable.
  const dead = http.createServer((_q, res) => res.end())
  await new Promise<void>(resolve => dead.listen(0, '127.0.0.1', resolve))
  const deadUrl = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`
  await new Promise<void>(resolve => dead.close(() => resolve()))
  const rDead = await read(mkhome(deadUrl))
  expect(rDead.code).toBe(1)
  expect(out(rDead)).toEqual({ error: 'unreachable' })
}, 120000)
