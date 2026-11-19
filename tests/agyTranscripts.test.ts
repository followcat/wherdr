import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { fieldOf } from '../server/utils/agyProtobuf'
import { createTranscripts } from '../server/utils/transcripts'
import {
  agyAnchorOf, agyHeadOf, agyToolSummary, agyUserText, conversationPath, createAgyTranscripts, hasStep,
  parseAgyStep, prefixOf, sweepAgyCopies, takeVisible, type AgyDoc, type AgyStep,
} from '../server/utils/agyTranscripts'
import { AGY_SESSION, openAgyFixture, stepBlobs, writeAgyFixture, writeAgySummaries } from './helpers/agy-fixture.mjs'
import { type MachineFs, createShellFs } from '../server/utils/fsx'

const homes: string[] = []
const keepers: { close: () => void }[] = []
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-agy-'))
  homes.push(home)
  return { home, reader: createTranscripts({ home, herdr: async () => ({}) }) }
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const k of keepers.splice(0)) k.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
const pane = { id: 'p1', agent: 'agy', cwd: '/work/acme-shop', agentSession: AGY_SESSION }

// The wire blobs of one row, decoded back through parseAgyStep.
function step(row: Record<string, unknown>, idx: number): AgyStep | null {
  const { type, metadata, payload } = stepBlobs(row, idx)
  return parseAgyStep(idx, type, Number(row.status ?? 3), metadata, payload, null)
}

const doc = (steps: AgyStep[], results: [string, { out: string, error: boolean }][] = []): AgyDoc =>
  ({ file: 'conv.db', model: null, steps, results: new Map(results), fingerprints: new Map(steps.map(s => [s.idx, `fp${s.idx}`])) })

it('decodes user, agent (thinking and calls), observation and error steps', () => {
  const user = step({ role: 'user', text: 'Review the date parser' }, 0)
  const agent = step({ role: 'agent', text: 'Done', thinking: 'Check edge cases', calls: [{ id: 'call-1', name: 'run_command', args: JSON.stringify({ CommandLine: 'npm test' }) }] }, 1)
  const obs = step({ role: 'obs', resultOf: 'call-1', out: '12 passed' }, 2)
  const error = step({ role: 'error', text: 'The model produced an invalid tool call.' }, 3)
  expect(user).toMatchObject({ role: 'user', text: 'Review the date parser', ts: '2026-02-02T12:00:00.000Z' })
  expect(agent).toMatchObject({ role: 'agent', text: 'Done', thinking: 'Check edge cases', calls: [{ id: 'call-1', name: 'run_command' }] })
  expect(obs).toMatchObject({ role: 'obs', resultOf: 'call-1', out: '12 passed' })
  expect(error).toMatchObject({ role: 'error', text: 'The model produced an invalid tool call.', error: true })
  expect(agent?.ms).toBe(0) // identical start/end Timestamps still give a duration
})

it('unwraps <USER_REQUEST> and drops machine context from a user prompt', () => {
  const f19 = fieldOf(stepBlobs({ role: 'user', text: '<USER_REQUEST>\nFix the webhook retries\n</USER_REQUEST>\n<workspace>\n/home/user/acme-shop\n</workspace>' }, 0).payload, 19)
  expect(agyUserText(f19)).toBe('Fix the webhook retries')
  const direct = fieldOf(stepBlobs({ role: 'user', text: 'Plain prompt' }, 0).payload, 19)
  expect(agyUserText(direct)).toBe('Plain prompt')
})

it('marks failed agent steps and internal steps hidden', () => {
  const failed = step({ role: 'agent', text: 'Stopped', status: 6 }, 0)
  const hidden = step({ role: 'hidden', type: 101 }, 1)
  const system = step({ role: 'hidden', type: 23 }, 2)
  expect(failed).toMatchObject({ role: 'agent', error: true })
  expect(hidden).toMatchObject({ role: 'hidden' })
  expect(system).toMatchObject({ role: 'hidden' })
})

it('survives torn and unknown-wire protobuf fields', () => {
  // Truncated length, then a group wire type: the field list ends, no throw.
  const meta = Buffer.from([0xfa, 0xff, 0x01, 0x0b])
  expect(parseAgyStep(9, 23, 3, meta, meta, null)).toMatchObject({ role: 'hidden' })
  expect(parseAgyStep(9, 15, 3, meta, meta, null)).toBeNull()
  expect(parseAgyStep(9, 14, 3, Buffer.from([0x80]), stepBlobs({ role: 'user', text: 'Intact' }, 0).payload, null))
    .toMatchObject({ role: 'user', text: 'Intact' })
})

it('summarizes a tool call from its best-known argument', () => {
  expect(agyToolSummary('run_command', JSON.stringify({ CommandLine: 'npm test' }))).toBe('npm test')
  expect(agyToolSummary('read_file', JSON.stringify({ Path: '/home/user/a.ts' }))).toBe('/home/user/a.ts')
  expect(agyToolSummary('grep_search', JSON.stringify({ Query: 'retry' }))).toBe('retry')
  expect(agyToolSummary('run_command', 'not json')).toBe('run_command')
  expect(agyToolSummary('read_file', '{}')).toBe('read_file')
})

it('pages backwards over the visible items', () => {
  const steps: AgyStep[] = []
  for (let i = 0; i < 140; i++) {
    steps.push(step({ role: 'user', text: `Request ${i + 1}` }, i * 2)!)
    steps.push(step({ role: 'agent', text: `Reply ${i + 1}` }, i * 2 + 1)!)
  }
  const d = doc(steps)
  const page = takeVisible(steps, d, 120)
  expect(page.items.length).toBe(120)
  expect(page.items.at(-1)?.text).toBe('Reply 140')
  expect(page.start).toBe(steps.find(s => s.text === 'Request 81')!.idx)
  // An earlier page ends just before the kept start.
  const older = takeVisible(steps.slice(0, steps.findIndex(s => s.idx >= page.start)), d, 120)
  expect(older.items.at(-1)?.text).toBe('Reply 80')
})

it('describes page anchors in the token helpers', () => {
  const steps = [step({ role: 'user', text: 'One' }, 0)!, step({ role: 'agent', text: 'Two' }, 1)!]
  const d = doc(steps)
  expect(prefixOf(d, 0)).toMatch(/^[0-9a-f]{12}$/)
  expect(prefixOf(d, 0)).not.toBe(prefixOf(d, 1))
  expect(agyHeadOf(`conv.db:4096:null:abcdef123456/0.${prefixOf(d, 0)}`)).toEqual({ file: 'conv.db', size: 4096, from: null, gen: 'abcdef123456' })
  expect(agyHeadOf('junk')).toBeNull()
  expect(agyAnchorOf(`conv.db:4096:null:abcdef123456/0.${prefixOf(d, 0)}`)).toEqual({ start: 0, hash: prefixOf(d, 0) })
  expect(agyAnchorOf('conv.db:1:null:abcdef123456')).toBeNull()
  expect(hasStep(steps, 0)).toBe(true)
  expect(hasStep(steps, 1)).toBe(true)
  expect(hasStep(steps, 42)).toBe(false)
})

it('resolves the conversation path under the data dir, honoring ANTIGRAVITY_APP_DATA_DIR', () => {
  const { home } = fixture()
  const file = path.join(home, '.gemini', 'antigravity-cli', 'conversations', `${AGY_SESSION}.db`)
  expect(conversationPath(home, AGY_SESSION, false)).toBe(file)
  vi.stubEnv('ANTIGRAVITY_APP_DATA_DIR', path.join(home, 'custom-data'))
  expect(conversationPath(home, AGY_SESSION, true)).toBe(path.join(home, 'custom-data', 'conversations', `${AGY_SESSION}.db`))
  expect(conversationPath(home, 'not-a-uuid', false)).toBeNull()
  expect(conversationPath(home, '', false)).toBeNull()
})

// ------------------------------------------------------------ reader (I/O)

it('reads a user prompt, the reply, its thinking and its tool call with the paired result', async () => {
  const { home, reader } = fixture()
  writeAgyFixture(home, { rows: [
    { role: 'user', text: 'Review the date parser' },
    { role: 'agent', thinking: 'Check the edge cases first.', calls: [{ id: 'call-1', name: 'run_command', args: JSON.stringify({ CommandLine: 'npm test' }) }] },
    { role: 'obs', resultOf: 'call-1', out: '12 passed' },
    { role: 'agent', text: '**All twelve tests pass.**' },
  ] })
  const r = await reader.chat(pane)
  expect(r.available).toBe(true)
  const items = r.items!
  expect(items[0]).toMatchObject({ role: 'user', text: 'Review the date parser' })
  expect(items[1]).toMatchObject({ role: 'thinking', text: 'Check the edge cases first.' })
  const tool = items.find(i => i.role === 'tool')
  expect(tool).toMatchObject({ name: 'run_command', text: 'npm test', out: '12 passed' })
  expect(items.at(-1)).toMatchObject({ role: 'assistant', text: '**All twelve tests pass.**' })
})

it('skips malformed protobuf rows in a stored conversation', async () => {
  const { home, reader } = fixture()
  writeAgyFixture(home, { rows: [
    { role: 'user', text: 'First' },
    { role: 'agent', text: 'Reply one' },
  ] })
  // A torn protobuf row (truncated length, unknown wire type) cannot abort the read.
  const file = path.join(home, '.gemini/antigravity-cli/conversations', `${AGY_SESSION}.db`)
  const db = new DatabaseSync(file)
  db.prepare('INSERT INTO steps (idx, step_type, status, has_subtrajectory, metadata, error_details, permissions, task_details, render_info, step_payload, step_format) VALUES (?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, ?, 0)')
    .run(99, 15, 3, Buffer.from([0x80]), Buffer.from([0xfa, 0xff, 0x01, 0x0b]))
  db.close()
  const items = (await reader.chat(pane)).items!
  expect(items.map(i => i.role)).toEqual(['user', 'assistant'])
  expect(items[0]?.text).toBe('First')
})

it('maps error steps to an error notice', async () => {
  const { home, reader } = fixture()
  writeAgyFixture(home, { rows: [
    { role: 'user', text: 'Try this' },
    { role: 'error', text: 'The model produced an invalid tool call.' },
  ] })
  const items = (await reader.chat(pane)).items!
  expect(items.at(-1)).toMatchObject({ role: 'notice', name: 'error', error: true, text: 'The model produced an invalid tool call.' })
})

it('reads a closed database without leaving sidecars next to it', async () => {
  const { home, reader } = fixture()
  // agy leaves a WAL-mode database behind, its sidecars removed on close.
  const live = openAgyFixture(home, { wal: true, rows: [{ role: 'user', text: 'Closed conversation' }] })
  live.close()
  const file = live.file
  expect(existsSync(`${file}-wal`)).toBe(false)
  expect(existsSync(`${file}-shm`)).toBe(false)
  expect((await reader.chat(pane)).items?.[0]?.text).toBe('Closed conversation')
  // node:sqlite writes a -wal and a -shm on a read-only open: agy's own folder
  // must stay exactly as agy left it.
  expect(existsSync(`${file}-wal`)).toBe(false)
  expect(existsSync(`${file}-shm`)).toBe(false)
})

it('reads committed WAL frames of a live conversation database', async () => {
  const { home, reader } = fixture()
  const live = openAgyFixture(home, { wal: true, rows: [{ role: 'user', text: 'First request' }] })
  keepers.push(live)
  expect((await reader.chat(pane)).items?.[0]?.text).toBe('First request')
  live.append([{ role: 'agent', text: 'Late reply' }])
  const r = await reader.chat(pane)
  expect(r.items?.map(i => i.text)).toEqual(['First request', 'Late reply'])
})

it('reads a remote conversation through a shell filesystem', async () => {
  const { home } = fixture()
  writeAgyFixture(home, { rows: [
    { role: 'user', text: 'Remote request' },
    { role: 'agent', text: 'Remote reply' },
  ] })
  const exec = async (script: string, args: string[] = []) => await new Promise<{ code: number, stdout: Buffer, stderr: string }>((resolve) => {
    execFile('sh', ['-c', script, 'sh', ...args], { encoding: 'buffer' }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout, stderr: stderr.toString() })
    })
  })
  const remote = createAgyTranscripts({ home, fs: createShellFs(exec, { statTtlMs: 0 }) })
  const r = await remote.chat(pane)
  expect(r.items?.map(i => i.text)).toEqual(['Remote request', 'Remote reply'])
})

it('paginates older pages and reports rewrites', async () => {
  const { home, reader } = fixture()
  const rows = []
  for (let i = 0; i < 140; i++) rows.push({ role: 'user', text: `Request ${i + 1}` }, { role: 'agent', text: `Reply ${i + 1}` })
  writeAgyFixture(home, { rows })
  const first = await reader.chat(pane)
  expect(first.items?.length).toBeLessThanOrEqual(120)
  expect(first.start).toBeGreaterThan(0)
  const older = await reader.chat(pane, { before: first.start })
  expect(older.older).toBe(true)
  expect(older.items?.length).toBeGreaterThan(0)
  // 280 items in 140 user/reply pairs: the older page ends just before the tail.
  expect(older.items?.at(-1)?.text).toBe('Reply 80')
  expect(older.items?.[0]?.text).toBe('Request 21')
  // A start that cannot exist is a rewrite, not an error.
  const gone = await reader.chat(pane, { before: 99999 })
  expect(gone).toMatchObject({ older: true, items: [], rewritten: true })
})

it('reports an unchanged token and serves increments', async () => {
  const { home, reader } = fixture()
  const live = openAgyFixture(home, { wal: true, rows: [
    { role: 'user', text: 'One' },
    { role: 'agent', text: 'Reply one' },
  ] })
  keepers.push(live)
  const first = await reader.chat(pane)
  expect(first.token).toBeTruthy()
  const same = await reader.chat(pane, { since: first.token })
  expect(same.unchanged).toBe(true)
  live.append([{ role: 'agent', text: 'Reply two' }])
  const next = await reader.chat(pane, { since: first.token })
  expect(next.unchanged).toBeUndefined()
  expect(next.items?.at(-1)?.text).toBe('Reply two')
})

it('searches user and assistant texts with excerpts', async () => {
  const { home, reader } = fixture()
  writeAgyFixture(home, { rows: [
    { role: 'user', text: 'Fix the payment webhook retries' },
    { role: 'agent', text: 'The retries now back off exponentially.' },
  ] })
  const hits = await reader.search({ ...pane }, 'retries', Date.now() + 5000)
  expect(hits.hits.length).toBe(2)
  expect(hits.hits[0]).toMatchObject({ role: 'assistant' })
  expect(hits.hits[1]).toMatchObject({ role: 'user' })
  expect(hits.kind).toBe('agy')
})

it('extracts the model from gen_metadata', async () => {
  const { home, reader } = fixture()
  writeAgyFixture(home, { model: 'gemini-3-pro-test', modelLabel: 'Gemini 3 Pro (test)', rows: [{ role: 'user', text: 'Hi' }] })
  const model = await reader.model(pane)
  expect(model).toMatchObject({ id: 'gemini-3-pro-test', label: 'Gemini 3 Pro (test)' })
})

it('returns not_found for a missing database and fails open on transient errors', async () => {
  const { home, reader } = fixture()
  expect(await reader.chat({ ...pane, agentSession: '99999999-8888-4777-8666-555555555555' })).toMatchObject({ available: false, reason: 'not_found' })
  // A non-database file is a read error, not a missing session.
  const dir = path.join(home, '.gemini/antigravity-cli/conversations')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${AGY_SESSION}.db`), 'not sqlite')
  await expect(reader.chat(pane)).rejects.toThrow()
})

it('never guesses a session from the summaries index', async () => {
  const { home } = fixture()
  // A top-level live conversation claims this folder, and its database exists.
  writeAgySummaries(home, [{ id: AGY_SESSION, uris: ['/home/user/acme-shop'], modified: '2026-02-02T12:05:00Z' }])
  writeAgyFixture(home, { rows: [{ role: 'user', text: 'Hi' }] })
  // The live agy process holds no conversation file open (the scan reads this
  // test process's own descriptors) and its launch line carries no flag: the
  // summaries row must not stand in and put an older conversation on screen.
  const t = createTranscripts({
    home,
    herdr: async () => ({ process_info: { foreground_processes: [{ name: 'agy', pid: process.pid }] } }),
  })
  expect(await t.chat({ id: 'p1', agent: 'agy', cwd: '/home/user/acme-shop' })).toMatchObject({ available: false, reason: 'not_found' })
})

// A remote filesystem over an in-memory store: `read` bytes are counted like
// data transferred over SSH, `sync` reloads a fixture file's real bytes after
// the remote moved (the store mtime is bumped so a rewrite is another
// generation), `setHook` can move the store in the middle of a copy, and
// `failReads` answers a chosen read short.
function remoteMachine() {
  const store = new Map<string, { buf: Buffer, mtimeMs: number, ino: number }>()
  const bytes = new Map<string, number>()
  let clock = 1000
  let ino = 100
  let hook: ((p: string) => void) | null = null
  let shortLeft = 0
  let shortWhen: ((p: string, start: number, len: number) => boolean) | null = null
  const enoent = (p: string) => Object.assign(new Error(`not found: ${p}`), { code: 'ENOENT' })
  const fs: MachineFs = {
    async stat(p) {
      const f = store.get(p)
      if (!f) throw enoent(p)
      return { size: f.buf.length, mtimeMs: f.mtimeMs, isFile: true, isDir: false, ino: f.ino }
    },
    statMany: ps => Promise.all(ps.map(p => fs.stat(p).catch(() => null))),
    readdir: async () => [],
    readFile: async () => '',
    async read(p, start, len) {
      const f = store.get(p)
      if (!f) throw enoent(p)
      bytes.set(p, (bytes.get(p) ?? 0) + len)
      let out = Buffer.from(f.buf.subarray(start, start + len))
      hook?.(p)
      if (shortLeft > 0 && shortWhen?.(p, start, len)) {
        shortLeft--
        out = out.subarray(0, Math.max(0, out.length - 1))
      }
      return out
    },
  }
  return {
    fs, bytes, store,
    sizeOf: (p: string) => store.get(p)?.buf.length ?? 0,
    sync: (p: string) => {
      if (!existsSync(p)) return store.delete(p)
      store.set(p, { buf: readFileSync(p), mtimeMs: clock += 10, ino: store.get(p)?.ino ?? (ino += 7) })
    },
    // Store bytes that are not a whole file (a WAL seen mid-write).
    put: (p: string, buf: Buffer) => {
      store.set(p, { buf: Buffer.from(buf), mtimeMs: clock += 10, ino: store.get(p)?.ino ?? (ino += 7) })
    },
    setHook: (h: typeof hook) => { hook = h },
    // The next `n` reads that `when` picks out lose their last byte.
    failReads: (n: number, when: (p: string, start: number, len: number) => boolean) => { shortLeft = n; shortWhen = when },
  }
}

it('retries a remote read that moved under the copy', async () => {
  const { home } = fixture()
  const live = openAgyFixture(home, { wal: true, rows: [
    { role: 'user', text: 'First request' },
    { role: 'agent', text: 'First reply' },
  ] })
  keepers.push(live)
  const remote = remoteMachine()
  remote.sync(live.file)
  remote.sync(`${live.file}-wal`)
  const agy = createAgyTranscripts({ home, fs: remote.fs })

  // The main file is checkpointed (and the WAL grows) right after the first
  // chunk of the copy: the read restarts and returns the final state.
  let swapped = false
  remote.setHook(p => {
    if (p !== live.file || swapped) return
    swapped = true
    live.append([{ role: 'agent', text: 'Second reply' }])
    live.db.exec('PRAGMA wal_checkpoint(FULL)')
    remote.sync(live.file)
    remote.sync(`${live.file}-wal`)
  })
  const r = await agy.chat(pane)
  expect(r.items?.map(i => i.text)).toEqual(['First request', 'First reply', 'Second reply'])
  expect(remote.bytes.get(live.file) ?? 0).toBeGreaterThan(remote.sizeOf(live.file)) // copied again after the move
})

it('recopies the whole WAL after a full copy failed part-way', async () => {
  const { home } = fixture()
  const live = openAgyFixture(home, { wal: true, rows: [
    { role: 'user', text: 'First request' },
    { role: 'agent', text: 'First reply' },
  ] })
  keepers.push(live)
  const remote = remoteMachine()
  remote.sync(live.file)
  remote.sync(`${live.file}-wal`)
  const agy = createAgyTranscripts({ home, fs: remote.fs })
  const walFile = `${live.file}-wal`

  // A transaction spills about a megabyte of frames, and the kept copy takes
  // them; the WAL stays under the 4 MiB copy chunk.
  live.db.exec('PRAGMA cache_size=1')
  live.db.exec('BEGIN; SAVEPOINT spill')
  live.append([{ role: 'agent', text: `Spilled ${'x'.repeat(1_000_000)}` }])
  remote.sync(walFile)
  expect((await agy.chat(pane)).items?.map(i => i.text)).toEqual(['First request', 'First reply'])
  expect(remote.sizeOf(walFile)).toBeLessThan(4 * 1024 * 1024)

  // Rewinding the savepoint makes the transaction write over those frames and
  // commit a WAL of over 5 MiB on top: the kept frame is stale, so the next
  // read must ship the whole WAL, in two chunks.
  live.db.exec('ROLLBACK TO spill; RELEASE spill')
  live.append([{ role: 'agent', text: `Rewritten ${'y'.repeat(5_000_000)}` }, { role: 'agent', text: 'Final reply' }])
  live.db.exec('COMMIT')
  remote.sync(walFile)
  expect(remote.sizeOf(walFile)).toBeGreaterThan(4 * 1024 * 1024)

  // The second chunk comes back one byte short: that attempt fails as `moved`
  // after the first chunk was already written to the kept file. The retry must
  // not append a tail to what the failed copy left behind.
  remote.failReads(1, (p, start) => p === walFile && start >= 4 * 1024 * 1024)
  const r = await agy.chat(pane)
  expect(r.items?.length).toBe(4)
  expect(r.items?.[2]?.text.startsWith('Rewritten')).toBe(true)
  expect(r.items?.[3]?.text).toBe('Final reply')
})

it('keeps a remote base copy and ships only the grown WAL tail', async () => {
  const { home } = fixture()
  const live = openAgyFixture(home, { wal: true, rows: [
    { role: 'user', text: 'First request' },
    { role: 'agent', text: 'First reply' },
  ] })
  keepers.push(live)
  const remote = remoteMachine()
  remote.sync(live.file)
  remote.sync(`${live.file}-wal`)
  const agy = createAgyTranscripts({ home, fs: remote.fs })
  const walFile = `${live.file}-wal`

  const first = await agy.chat(pane)
  expect(first.items?.at(-1)?.text).toBe('First reply')
  const dbBytes = remote.bytes.get(live.file) ?? 0
  const walBytes = remote.bytes.get(walFile) ?? 0
  expect(walBytes).toBeGreaterThanOrEqual(remote.sizeOf(walFile))

  const keptWal = remote.sizeOf(walFile)
  live.append([{ role: 'agent', text: 'Second reply' }])
  remote.sync(walFile)
  const grown = remote.sizeOf(walFile)
  const next = await agy.chat(pane, { since: first.token })
  expect(next.items?.at(-1)?.text).toBe('Second reply')
  // The database was not shipped again; the WAL shipped only its grown tail
  // plus the small header checks (32-byte header, last kept frame, re-check).
  expect(remote.bytes.get(live.file) ?? 0).toBe(dbBytes)
  expect((remote.bytes.get(walFile) ?? 0) - walBytes).toBe(grown - keptWal + 88)
})

it('recopies the WAL in full when a kept frame was rewritten in place', async () => {
  const { home } = fixture()
  const live = openAgyFixture(home, { wal: true, rows: [
    { role: 'user', text: 'First request' },
    { role: 'agent', text: 'First reply' },
  ] })
  keepers.push(live)
  const remote = remoteMachine()
  remote.sync(live.file)
  const agy = createAgyTranscripts({ home, fs: remote.fs })
  const walFile = `${live.file}-wal`

  // A one-page cache spills this transaction's frames into the WAL file while
  // it is still uncommitted — the first copy lands on that in-flight state.
  live.db.exec('PRAGMA cache_size=1')
  live.db.exec('BEGIN; SAVEPOINT spill')
  live.append([{ role: 'agent', text: `Spilled ${'x'.repeat(50000)}` }])
  remote.sync(walFile)
  const first = await agy.chat(pane)
  expect(first.items?.map(i => i.text)).toEqual(['First request', 'First reply'])
  const dbBytes = remote.bytes.get(live.file) ?? 0
  const walBytes = remote.bytes.get(walFile) ?? 0
  const keptWal = remote.sizeOf(walFile)

  // Rewinding the savepoint marks those frames for rewriting: the transaction
  // writes over them (same 32-byte header, same offsets, other bytes) and
  // commits on top — the kept prefix is stale below the kept size.
  live.db.exec('ROLLBACK TO spill; RELEASE spill')
  live.append([{ role: 'agent', text: `Rewritten ${'y'.repeat(60000)}` }, { role: 'agent', text: 'Final reply' }])
  live.db.exec('COMMIT')
  remote.sync(walFile)
  expect(remote.sizeOf(walFile)).toBeGreaterThan(keptWal)

  const next = await agy.chat(pane, { since: first.token })
  // A reply past the text limit ends with the shared truncation marker.
  expect(next.items?.map(i => i.text)).toEqual(['First request', 'First reply', expect.stringMatching(/^Rewritten y+…$/), 'Final reply'])
  // The rewritten kept frame was detected: the whole WAL shipped again, the
  // main file did not.
  expect(remote.bytes.get(live.file) ?? 0).toBe(dbBytes)
  expect((remote.bytes.get(walFile) ?? 0) - walBytes).toBeGreaterThanOrEqual(remote.sizeOf(walFile))
})

it('cuts a kept WAL ending mid-frame back to the last whole frame', async () => {
  const { home } = fixture()
  const live = openAgyFixture(home, { wal: true, rows: [
    { role: 'user', text: 'First request' },
    { role: 'agent', text: 'First reply' },
  ] })
  keepers.push(live)
  const remote = remoteMachine()
  remote.sync(live.file)
  remote.sync(`${live.file}-wal`)
  const agy = createAgyTranscripts({ home, fs: remote.fs })
  const walFile = `${live.file}-wal`
  const boundary = remote.sizeOf(walFile)

  // The first copy lands mid-frame: a spilling transaction has written the new
  // frame's 24-byte header, its page not yet (SQLite writes them separately).
  live.db.exec('PRAGMA cache_size=1')
  live.db.exec('BEGIN; SAVEPOINT spill')
  live.append([{ role: 'agent', text: `Spilled ${'x'.repeat(50000)}` }])
  remote.put(walFile, readFileSync(walFile).subarray(0, boundary + 24))
  const first = await agy.chat(pane)
  expect(first.items?.map(i => i.text)).toEqual(['First request', 'First reply'])
  const dbBytes = remote.bytes.get(live.file) ?? 0
  const walBytes = remote.bytes.get(walFile) ?? 0

  // The transaction is then rewound and completed over that frame — another
  // header at the same offset — and the WAL grows past the copied point.
  live.db.exec('ROLLBACK TO spill; RELEASE spill')
  live.append([{ role: 'agent', text: `Rewritten ${'y'.repeat(60000)}` }, { role: 'agent', text: 'Final reply' }])
  live.db.exec('COMMIT')
  remote.sync(walFile)
  expect(remote.sizeOf(walFile)).toBeGreaterThan(boundary + 24)

  const next = await agy.chat(pane, { since: first.token })
  // A reply past the text limit ends with the shared truncation marker.
  expect(next.items?.map(i => i.text)).toEqual(['First request', 'First reply', expect.stringMatching(/^Rewritten y+…$/), 'Final reply'])
  // The stale partial frame was not kept: the tail ships from the last
  // whole-frame boundary, still far below a full WAL copy.
  expect(remote.bytes.get(live.file) ?? 0).toBe(dbBytes)
  expect((remote.bytes.get(walFile) ?? 0) - walBytes).toBe(remote.sizeOf(walFile) - boundary + 88)
})

it('sweeps only the kept copies whose process is gone', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wherdr-sweep-'))
  try {
    // A folder of this process, of a child that has exited, one without a pid,
    // and something else entirely.
    const live = path.join(dir, `wherdr-agy-${process.pid}-live`)
    const exited = spawnSync(process.execPath, ['-e', '']).pid!
    const dead = path.join(dir, `wherdr-agy-${exited}-dead`)
    const nameless = path.join(dir, 'wherdr-agy-stale')
    const other = path.join(dir, 'wherdr-other')
    for (const d of [live, dead, nameless, other]) mkdirSync(d)
    writeFileSync(path.join(dead, 'conv.db'), 'kept copy')
    sweepAgyCopies(dir)
    expect(existsSync(live)).toBe(true)
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(nameless)).toBe(true)
    expect(existsSync(other)).toBe(true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('removes a kept copy when its pane is gone', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'wherdr-keep-'))
  const home = mkdtempSync(path.join(scratch, 'home-'))
  vi.stubEnv('TMPDIR', scratch)
  try {
    writeAgyFixture(home, { rows: [{ role: 'user', text: 'Hi' }] })
    const t = createTranscripts({ home, herdr: async () => ({}) })
    const p = { id: 'p1', agent: 'agy', cwd: '/work/acme-shop', agentSession: AGY_SESSION }
    expect((await t.chat(p)).available).toBe(true)
    const kept = readdirSync(scratch).filter(n => n.startsWith('wherdr-agy-'))
    expect(kept).toHaveLength(1)
    // The pane left the state: its copy goes with it.
    t.observe([])
    expect(existsSync(path.join(scratch, kept[0]!))).toBe(false)
  } finally {
    vi.unstubAllEnvs()
    rmSync(scratch, { recursive: true, force: true })
  }
})

it('recopies a restarted WAL in full', async () => {
  const { home } = fixture()
  const live = openAgyFixture(home, { wal: true, rows: [
    { role: 'user', text: 'First request' },
    { role: 'agent', text: 'First reply' },
  ] })
  keepers.push(live)
  const remote = remoteMachine()
  remote.sync(live.file)
  remote.sync(`${live.file}-wal`)
  const agy = createAgyTranscripts({ home, fs: remote.fs })
  const walFile = `${live.file}-wal`

  const first = await agy.chat(pane)
  const dbBytes = remote.bytes.get(live.file) ?? 0
  const walBytes = remote.bytes.get(walFile) ?? 0

  // A TRUNCATE checkpoint empties the WAL; the next frames open a new
  // generation under another header.
  live.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  live.append([{ role: 'agent', text: 'Second reply' }])
  remote.sync(walFile)
  remote.sync(live.file)
  const next = await agy.chat(pane, { since: first.token })
  expect(next.items?.at(-1)?.text).toBe('Second reply')
  const walNow = remote.sizeOf(walFile)
  expect((remote.bytes.get(walFile) ?? 0) - walBytes).toBeGreaterThanOrEqual(walNow)
  // The checkpoint rewrote the main file too: it shipped in full again.
  expect(remote.bytes.get(live.file) ?? 0).toBeGreaterThan(dbBytes)
})
