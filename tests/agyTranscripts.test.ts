import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
