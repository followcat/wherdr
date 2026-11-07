import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { OPENCODE_CATALOG } from '../server/utils/opencodeCatalog'
import { localShell } from '../server/utils/agentProcesses'

// Same owned-fixture contract: the real helper runs through localShell
// against an owned loopback peer and fixture HOME with an inert CLI stub
// so installed OpenCode can never launch. Helper-level contract only.
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
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-oc-cat-'))
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
// A native session row; extra producer fields must be tolerated, reduced.
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, parentID: null, title: `t-${id}`, location: { directory: DIR, extra: 1 },
  subpath: '', metadata: { ignored: true },
  time: { created: 1000, updated: 2000 }, ...over,
})
// Native pagination: nonempty pages carry an opaque next; exhaustion is an empty page or absent next.
const page = (data: unknown[], next?: string) =>
  JSON.stringify({ data, cursor: next === undefined ? {} : { next, previous: 'back' }, other: 1 })

// Run the fixed helper directly: parse the one JSON envelope it may emit.
const read = (home: string, req: Record<string, unknown> = { directory: DIR }) =>
  localShell('exec python3 -X utf8 -c "$1" "$2" "$3"', [OPENCODE_CATALOG, home, JSON.stringify(req)],
    { timeoutMs: 30000, maxBytes: 5 * mib })
const out = (r: Awaited<ReturnType<typeof read>>): Record<string, unknown> =>
  JSON.parse(r.stdout.toString('utf8').trim())

it('walks a fixed bounded catalog end to end with opaque cursors', async () => {
  const rows = [row('ses_root'), row('ses_child', { parentID: 'ses_root', subpath: 'sub' }),
    row('ses_arch', { time: { created: 900, updated: 3000, viewed: 2500, archived: 4000 } }),
    row('ses_fork', { fork: { sessionID: 'ses_parent', boundary: { i: 1 } } })]
  const p = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(INFO); return }
    const c = new URL(req.url!, 'http://x').searchParams.get('cursor')
    if (c === null) res.end(page(rows, 'cur/1+"x"'))
    else if (c === 'cur/1+"x"') res.end(page([row('ses_old', { time: { created: 10, updated: 20, idle: 30 } })], 'next,2'))
    else if (c === 'next,2') res.end(JSON.stringify({ data: [], cursor: { next: null, previous: null } }))
    else { res.statusCode = 500; res.end() }
  })
  const r = await read(mkhome(p.url))
  const o = out(r)
  expect(r.code).toBe(0)
  // Bounded rows/pages/exhaustion + the unproven discriminant only: no
  // complete or selection-authorizing field may exist.
  expect(Object.keys(o).sort()).toEqual(
    ['consistency', 'directory', 'exhausted', 'fingerprint', 'pages', 'rows', 'server', 'size', 'status'])
  expect(o).toMatchObject({ status: 200, directory: DIR, pages: 3, exhausted: true, consistency: 'unproven' })
  expect(o.server).toMatch(/^[a-f0-9]{32}$/)
  expect(o.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  // Parent/child, fork, archived and idle/viewed distinctions are preserved.
  expect((o.rows as Record<string, unknown>[]).map(x => [x.id, x.parent, x.fork, x.archived, x.idle])).toEqual([
    ['ses_root', null, null, null, null], ['ses_child', 'ses_root', null, null, null],
    ['ses_arch', null, null, 4000, null], ['ses_fork', null, 'ses_parent', null, null],
    ['ses_old', null, null, null, 30]])
  const q = `/api/session?directory=${encodeURIComponent(DIR)}&order=desc&limit=100`
  expect(p.hits.map(h => h.url)).toEqual(['/api/info', q, `${q}&cursor=cur%2F1%2B%22x%22`, `${q}&cursor=next%2C2`, '/api/info'])
  expect(p.hits.every(h => h.headers.authorization === basic())).toBe(true)
}, 60000)

it('binds the fingerprint to the opaque traversal path, never decoding it', async () => {
  // Every nonempty page carries an opaque next and each walk ends on the
  // native empty page; only the cursor bytes and page cuts vary.
  const served = [row('ses_a'), row('ses_b'), row('ses_c')]
  let mode = 0
  const cuts: Record<number, [string | null, unknown[], string?][]> = {
    0: [[null, served, 'k0'], ['k0', [], undefined]],
    1: [[null, served.slice(0, 1), 'X'], ['X', served.slice(1), 'X2'], ['X2', [], undefined]],
    2: [[null, served.slice(0, 2), 'Y'], ['Y', served.slice(2), 'Y2'], ['Y2', [], undefined]],
    3: [[null, served.slice(0, 1), 'Z'], ['Z', served.slice(1), 'Z2'], ['Z2', [], undefined]],
  }
  const p = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(INFO); return }
    const c = new URL(req.url!, 'http://x').searchParams.get('cursor')
    const step = cuts[mode]!.find(([need]) => need === c)
    if (!step) { res.statusCode = 500; res.end(); return }
    res.end(page(step[1], step[2]))
  })
  const home = mkhome(p.url)
  const one = out(await read(home))
  mode = 1
  const two = out(await read(home)); const two2 = out(await read(home))
  mode = 2
  const three = out(await read(home))
  mode = 3
  const alt = out(await read(home))
  expect(one.pages).toBe(2)
  expect(two.pages).toBe(3)
  // Different traversal = distinct fingerprints; re-walked = identical.
  expect(two.fingerprint).not.toBe(one.fingerprint)
  expect(three.fingerprint).not.toBe(two.fingerprint)
  expect(alt.fingerprint).not.toBe(two.fingerprint)
  expect(two2.fingerprint).toBe(two.fingerprint)
}, 60000)

it('misses a row that moves ahead of the cursor mid-walk: exhaustion stays unproven', async () => {
  // The hidden-row witness with a real service-side store: after page 1
  // anchors past ses_a, the fixture moves ses_moved ahead of the cursor and
  // the keyset predicate can never surface it again. The walk still
  // exhausts under one generation: 'unproven', no candidate set.
  const store = [row('ses_moved', { time: { created: 10, updated: 1500 } }),
    row('ses_a', { time: { created: 20, updated: 2000 } }),
    row('ses_b', { time: { created: 30, updated: 1000 } })]
  const byTime = (r: { time: { updated: number } }) => r.time.updated
  const listed = () => store.slice().sort((x, y) => byTime(y) - byTime(x))
  let mutated = false
  const p = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(INFO); return }
    const c = new URL(req.url!, 'http://x').searchParams.get('cursor')
    if (c === null) {
      const first = listed().slice(0, 1)
      res.end(page(first, `at-${byTime(first[0]!)}`))
      mutated = true
      store[0]!.time.updated = 9999
      return
    }
    const anchor = Number(c.slice(3))
    const tail = listed().filter(r => byTime(r) < anchor)
    res.end(page(tail, tail.length ? `at-${byTime(tail[tail.length - 1]!)}` : undefined))
  })
  const o = out(await read(mkhome(p.url)))
  // The owned mutation happened and the service still holds the row; the
  // observation simply cannot include it.
  expect(mutated).toBe(true)
  expect(store.map(x => x.id)).toContain('ses_moved')
  expect(byTime(store[0]!)).toBe(9999)
  expect(o).toMatchObject({ status: 200, consistency: 'unproven', exhausted: true, pages: 3 })
  expect((o.rows as { id: string }[]).map(x => x.id)).toEqual(['ses_a', 'ses_b'])
  expect(p.hits.filter(h => h.url === '/api/info')).toHaveLength(2)
}, 60000)

// A trickled body keeps every socket recv under the request timeout while
// monotonic time crosses the deadline: only the aggregate gate stops it.
// `done` records a completed stream; the interval dies with the response.
const trickled = (res: http.ServerResponse, body: string, done: { finished: boolean }) => {
  let i = 0
  const t = setInterval(() => {
    if (i >= body.length) { done.finished = true; res.end(); return }
    res.write(body.slice(i, i + 2)); i += 2
  }, 800)
  res.on('close', () => clearInterval(t))
}
const PAD = 'x'.repeat(24)

it('aborts a mid-walk blocked read at the aggregate deadline, before the body completes', async () => {
  // Page 2's reply needs ~22s of trickle; the inner deadline must abort the read near 20s.
  const done = { finished: false }
  const mid = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(INFO); return }
    if (new URL(req.url!, 'http://x').searchParams.get('cursor') === null) { res.end(page([row('ses_a')], 'c2')); return }
    trickled(res, `{"data":[],"cursor":{},"pad":"${PAD}"}`, done)
  })
  const t0 = Date.now()
  const r = await read(mkhome(mid.url))
  const elapsed = Date.now() - t0
  expect(r.code).toBe(1)
  expect(out(r)).toEqual({ error: 'unreachable' })
  expect(done.finished).toBe(false)
  expect(elapsed).toBeLessThan(23000)
}, 120000)

it('aborts a blocked revalidation read at the aggregate deadline, before the body completes', async () => {
  // The walk exhausts fast; the second /api/info body needs ~25s of trickle.
  const done = { finished: false }
  let infos = 0
  const tail = await serve((req, res) => {
    if (req.url === '/api/info') {
      infos += 1
      if (infos === 1) { res.end(INFO); return }
      trickled(res, `{"version":"2.0.27","pid":10,"pad":"${PAD}"}`, done)
      return
    }
    res.end(req.url!.includes('cursor=') ? page([]) : page([row('ses_a')], 'x'))
  })
  const t0 = Date.now()
  const r = await read(mkhome(tail.url))
  const elapsed = Date.now() - t0
  expect(r.code).toBe(1)
  expect(out(r)).toEqual({ error: 'unreachable' })
  expect(done.finished).toBe(false)
  expect(elapsed).toBeLessThan(23000)
}, 120000)

// Representative fixed-bug refusals; the broad envelope matrix is a later
// bounded test unit on the committed helper.
const malformed: [string, string][] = [
  // Absent or explicit null next is proven exhaustion; a non-string
  // non-null value is malformed.
  ['next non-string', JSON.stringify({ data: [], cursor: { next: 5 } })],
  // Producer semantics: an empty page never carries a continuation.
  ['empty page with next', JSON.stringify({ data: [], cursor: { next: 'x' } })],
]
it.each(malformed)('fails malformed: %s', async (_name, body) => {
  const p = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(INFO); return }
    res.end(body)
  })
  const r = await read(mkhome(p.url))
  expect(r.code).toBe(1)
  expect(out(r)).toEqual({ error: 'reply_invalid' })
}, 120000)

it('bounds the aggregate read itself, not only the summed total', async () => {
  // Page 1 spends 13 MiB of the 24 MiB aggregate on one real row; page 2 is
  // drain-paced so unsent bytes measure where the client stopped reading.
  // A full-page read would let the stream run to ~24 MiB or beyond.
  let calls = 0, sent = 0, closed = false
  const TOTAL2 = 30 * mib, CHUNK = 65536
  const p = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(INFO); return }
    calls += 1
    if (calls === 1) {
      res.end(page([row('ses_a')], 'a').replace('"other":1', `"pad":"${'x'.repeat(13 * mib)}","other":1`))
      return
    }
    res.on('close', () => { closed = true })
    const feed = () => {
      while (!closed && !res.writableEnded && sent < TOTAL2) {
        sent += CHUNK
        if (!res.write('x'.repeat(CHUNK))) { res.once('drain', feed); return }
      }
    }
    feed()
  })
  const r = await read(mkhome(p.url))
  expect(r.code).toBe(1)
  expect(out(r)).toEqual({ error: 'too_large' })
  expect(sent).toBeLessThan(20 * mib)
}, 120000)

it('bounds canonical bytes, not only raw page bytes', async () => {
  // Escape expansion is real: 512 heavy rows canonicalize past 4 MiB inside
  // the row count and raw page bound.
  const heavy = (i: number) => row(`ses_${i}`, {
    title: '\u00e9'.repeat(512), location: { directory: '/' + '\u00e9'.repeat(500) },
    subpath: '\u00e9'.repeat(500) })
  const p = await serve((req, res) => {
    if (req.url === '/api/info') { res.end(INFO); return }
    if (req.url!.includes('cursor=')) { res.end(page([])); return }
    res.end(page(Array.from({ length: 512 }, (_x, i) => heavy(i)), 'c1'))
  })
  const r = await read(mkhome(p.url))
  expect(r.code).toBe(1)
  expect(out(r)).toEqual({ error: 'too_large' })
}, 120000)
