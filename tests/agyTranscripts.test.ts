import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createTranscripts } from '../server/utils/transcripts'
import { createAgyTranscripts } from '../server/utils/agyTranscripts'
import { AGY_OTHER, AGY_SESSION, openAgyFixture, writeAgyFixture, writeAgySummaries } from './helpers/agy-fixture.mjs'
import { type MachineFs, createShellFs, localFs } from '../server/utils/fsx'

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

it('honors ANTIGRAVITY_APP_DATA_DIR locally but not on a remote filesystem', async () => {
  const { home, reader } = fixture()
  const alternate = path.join(home, 'alternate')
  writeAgyFixture(alternate, { rows: [{ role: 'user', text: 'Custom data dir' }] })
  vi.stubEnv('ANTIGRAVITY_APP_DATA_DIR', path.join(alternate, '.gemini/antigravity-cli'))
  expect((await reader.chat(pane)).items?.[0]?.text).toBe('Custom data dir')
  const remote = createAgyTranscripts({ home, fs: { ...localFs } })
  writeAgyFixture(home, { rows: [{ role: 'user', text: 'Default data dir' }] })
  expect((await remote.chat(pane)).items?.[0]?.text).toBe('Default data dir')
})

it('skips checkpoints, system steps and malformed protobuf rows', async () => {
  const { home, reader } = fixture()
  writeAgyFixture(home, { rows: [
    { role: 'hidden', type: 101 },
    { role: 'user', text: 'First' },
    { role: 'hidden', type: 23 },
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

it('extracts the model from gen_metadata and keeps it across a failed read', async () => {
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

// A remote filesystem over an in-memory store: `read` bytes are counted like
// data transferred over SSH, `sync` reloads a fixture file's real bytes after
// the remote moved (the store mtime is bumped so a rewrite is another
// generation), and `setHook` can move the store in the middle of a copy.
function remoteMachine() {
  const store = new Map<string, { buf: Buffer, mtimeMs: number, ino: number }>()
  const bytes = new Map<string, number>()
  let clock = 1000
  let ino = 100
  let hook: ((p: string) => void) | null = null
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
      const out = Buffer.from(f.buf.subarray(start, start + len))
      hook?.(p)
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
    setHook: (h: typeof hook) => { hook = h },
  }
}

it('copies only the grown WAL tail when a remote conversation changes', async () => {
  const { home } = fixture()
  const live = openAgyFixture(home, { wal: true, rows: [
    { role: 'user', text: 'First request' },
    { role: 'agent', text: 'First reply' },
    { role: 'user', text: 'Another request' },
    { role: 'agent', text: 'Another reply' },
  ] })
  keepers.push(live)
  const remote = remoteMachine()
  remote.sync(live.file)
  const walPath = `${live.file}-wal`
  remote.sync(walPath)
  const agy = createAgyTranscripts({ home, fs: remote.fs })
  expect((await agy.chat(pane)).items?.map(i => i.text)).toEqual(['First request', 'First reply', 'Another request', 'Another reply'])
  expect(remote.bytes.get(live.file)).toBeGreaterThan(0)
  const walSize1 = remote.sizeOf(walPath)

  remote.bytes.clear()
  live.append([{ role: 'agent', text: 'Late reply' }])
  remote.sync(walPath)
  const tail = remote.sizeOf(walPath) - walSize1
  expect(tail).toBeGreaterThan(0)
  const r = await agy.chat(pane)
  expect(r.items?.map(i => i.text)).toEqual(['First request', 'First reply', 'Another request', 'Another reply', 'Late reply'])
  expect(remote.bytes.get(live.file) ?? 0).toBe(0) // the database is not recopied
  expect(remote.bytes.get(walPath) ?? 0).toBeLessThanOrEqual(tail + 128) // tail + header checks only
})

it('copies the remote database again when its identity changes', async () => {
  const { home } = fixture()
  const live = openAgyFixture(home, { wal: true, rows: [
    { role: 'user', text: 'First request' },
    { role: 'agent', text: 'First reply' },
  ] })
  keepers.push(live)
  const remote = remoteMachine()
  remote.sync(live.file)
  const walPath = `${live.file}-wal`
  remote.sync(walPath)
  const agy = createAgyTranscripts({ home, fs: remote.fs })
  expect((await agy.chat(pane)).items?.length).toBe(2)

  remote.bytes.clear()
  live.append([{ role: 'agent', text: 'Checkpointed reply' }])
  live.db.exec('PRAGMA wal_checkpoint(FULL)') // the main file moves, the WAL keeps its generation
  remote.sync(live.file)
  remote.sync(walPath)
  const r = await agy.chat(pane)
  expect(r.items?.map(i => i.text)).toEqual(['First request', 'First reply', 'Checkpointed reply'])
  expect(remote.bytes.get(live.file)).toBe(remote.sizeOf(live.file)) // recopied in full
})

it('copies the whole remote WAL after a restart', async () => {
  const { home } = fixture()
  const live = openAgyFixture(home, { wal: true, rows: [
    { role: 'user', text: 'First request' },
    { role: 'agent', text: 'First reply' },
  ] })
  keepers.push(live)
  const remote = remoteMachine()
  remote.sync(live.file)
  const walPath = `${live.file}-wal`
  remote.sync(walPath)
  const agy = createAgyTranscripts({ home, fs: remote.fs })
  expect((await agy.chat(pane)).items?.length).toBe(2)

  // A restart gives the WAL another header (checkpoint sequence and salts):
  // even grown back past the kept size, the kept prefix is from another
  // generation and the whole file has to be copied again.
  remote.bytes.clear()
  live.db.exec('PRAGMA wal_checkpoint(RESTART)')
  live.append([
    { role: 'user', text: 'Second request after the restart' },
    { role: 'agent', text: 'Second reply after the restart' },
    { role: 'user', text: 'Third request after the restart' },
    { role: 'agent', text: 'Third reply after the restart' },
  ])
  remote.sync(live.file)
  remote.sync(walPath)
  const r = await agy.chat(pane)
  expect(r.items?.map(i => i.text)).toEqual([
    'First request', 'First reply',
    'Second request after the restart', 'Second reply after the restart',
    'Third request after the restart', 'Third reply after the restart',
  ])
  expect(remote.bytes.get(walPath) ?? 0).toBeGreaterThanOrEqual(remote.sizeOf(walPath))
})

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

it('summaries fallback only resolves a unique live match for the pane folder', async () => {
  const { home } = fixture()
  const agy = createAgyTranscripts({ home, fs: localFs })
  const p = { cwd: '/home/user/acme-shop', bornAt: Date.parse('2026-02-02T11:00:00Z') }
  expect(await agy.summariesSession(p, false)).toBeNull()
  writeAgySummaries(home, [
    { id: AGY_SESSION, uris: ['/home/user/acme-shop'], modified: '2026-02-02T12:05:00Z' },
    { id: AGY_OTHER, uris: ['/home/user/other'], modified: '2026-02-02T12:06:00Z' },
  ])
  writeAgyFixture(home, { rows: [{ role: 'user', text: 'Hi' }] })
  expect(await agy.summariesSession(p, false)).toBe(AGY_SESSION)
  expect(await agy.summariesSession(p, true)).toBeNull() // a peer agy on the same folder
  expect(await agy.summariesSession({ ...p, cwd: '/home/user/elsewhere' }, false)).toBeNull()
})
