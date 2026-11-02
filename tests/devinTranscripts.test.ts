import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createTranscripts } from '../server/utils/transcripts'
import { devinMessage, writeDevinFixture } from './helpers/devin-fixture.mjs'
import { createDevinTranscripts } from '../server/utils/devinTranscripts'
import { HerdrError } from '../server/utils/herdr'
import { type MachineFs, localFs } from '../server/utils/fsx'

const homes: string[] = []
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-devin-'))
  homes.push(home)
  return { home, reader: createTranscripts({ home, herdr: async () => ({}) }) }
}
afterEach(() => { vi.unstubAllEnvs(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
const pane = { id: 'p1', agent: 'devin', cwd: '/projects/demo', agentSession: 'devin-test' }
const realFixture = fileURLToPath(new URL('./helpers/devin-atif-v1.7.json', import.meta.url))

function countingFs(base: MachineFs = localFs) {
  const counts = { stat: 0, read: 0 }
  const fs: MachineFs = {
    ...base,
    stat: async p => { counts.stat++; return base.stat(p) },
    read: async (p, start, len, timeoutMs) => { counts.read++; return base.read(p, start, len, timeoutMs) },
  }
  return { fs, counts }
}

it('reads Unicode messages from an ATIF transcript', async () => {
  const { home, reader } = fixture()
  writeDevinFixture(home, { rows: [{ id: 0, message: devinMessage('assistant', '中文 café reply') }] })
  expect((await reader.chat(pane)).items?.[0]?.text).toBe('中文 café reply')
})

it('honors native data directory overrides without reading another home', async () => {
  const { home, reader } = fixture()
  const alternate = path.join(home, 'alternate')
  writeDevinFixture(alternate, { rows: [{ id: 0, message: devinMessage('assistant', 'Custom data directory') }] })
  vi.stubEnv('HOME', home)
  vi.stubEnv('DEVIN_SESSIONS_DIR', path.join(alternate, '.local/share/devin/cli'))
  expect((await reader.chat(pane)).items?.[0]?.text).toBe('Custom data directory')
  vi.stubEnv('DEVIN_SESSIONS_DIR', '')
  vi.stubEnv('XDG_DATA_HOME', path.join(alternate, '.local/share'))
  expect((await reader.chat(pane)).items?.[0]?.text).toBe('Custom data directory')
})

it('does not apply local directory overrides on a remote filesystem', async () => {
  const { home } = fixture()
  writeDevinFixture(home, { rows: [{ id: 0, message: devinMessage('assistant', 'Remote home') }] })
  const alternate = path.join(home, 'alternate')
  writeDevinFixture(alternate, { rows: [{ id: 0, message: devinMessage('assistant', 'Local override') }] })
  vi.stubEnv('DEVIN_SESSIONS_DIR', path.join(alternate, '.local/share/devin/cli'))
  const remote = createDevinTranscripts({ home, fs: { ...localFs } })
  expect((await remote.chat(pane)).items?.[0]?.text).toBe('Remote home')
})

it('handles a Unicode home path and session id', async () => {
  const { home } = fixture()
  const nested = path.join(home, 'café 中文')
  const session = 'session-café-中文'
  writeDevinFixture(nested, { session, rows: [{ id: 0, message: devinMessage('assistant', 'Unicode history') }] })
  const reader = createTranscripts({ home: nested, herdr: async () => ({}) })
  expect((await reader.chat({ ...pane, agentSession: session })).items?.[0]?.text).toBe('Unicode history')
})

it('reads the reported Devin session and its current main chain, excluding another branch and session', async () => {
  const { home, reader } = fixture()
  writeDevinFixture(home, { rows: [
    { id: 0, message: devinMessage('system', 'Private instructions') },
    { id: 1, parent: 0, message: devinMessage('user', 'Review the example') },
    { id: 2, parent: 1, message: devinMessage('assistant', 'Abandoned reply') },
    { id: 3, parent: 1, message: devinMessage('assistant', '**Current reply**') },
  ] })
  writeDevinFixture(home, { session: 'another-session', rows: [{ id: 0, message: devinMessage('user', 'Other conversation') }] })
  const response = await reader.chat(pane)
  expect(response.available).toBe(true)
  expect(response.session).toBe('devin-test')
  expect(response.items?.map(i => [i.role, i.text])).toEqual([['user', 'Review the example'], ['assistant', '**Current reply**']])
  expect(await reader.chat({ ...pane, agentSession: null })).toMatchObject({ available: false, reason: 'not_found' })
})

it('keeps empty conversations available and never guesses a session', async () => {
  const { home, reader } = fixture()
  expect(await reader.chat(pane)).toMatchObject({ available: false, reason: 'not_found' })
  writeDevinFixture(home)
  expect(await reader.chat(pane)).toMatchObject({ available: true, items: [], start: 0 })
  expect(await reader.chat({ ...pane, agentSession: 'missing' })).toMatchObject({ available: false })
  expect(await reader.model(pane)).toEqual({ id: 'test-model', label: 'test-model' })
})

it('rejects session ids that would escape the transcripts directory', async () => {
  const { reader } = fixture()
  expect(await reader.chat({ ...pane, agentSession: '../secret' })).toMatchObject({ available: false, reason: 'not_found' })
  expect(await reader.chat({ ...pane, agentSession: 'a/b' })).toMatchObject({ available: false, reason: 'not_found' })
})

it('paginates a long chain without gaps and refreshes the same tail after an append', async () => {
  const { home, reader } = fixture()
  const rows = Array.from({ length: 300 }, (_, id) => ({ id, parent: id ? id - 1 : null, message: devinMessage(id % 2 ? 'assistant' : 'user', `Message ${id}`) }))
  const file = writeDevinFixture(home, { rows })
  const before = readFileSync(file)
  const tail = await reader.chat(pane)
  expect(tail.items).toHaveLength(120)
  expect(tail.start).toBe(181)
  const middle = await reader.chat(pane, { before: tail.start, anchor: tail.token })
  const first = await reader.chat(pane, { before: middle.start, anchor: tail.token })
  expect(first.start).toBe(0)
  expect([...first.items!, ...middle.items!, ...tail.items!].map(i => i.text)).toEqual(rows.map(r => r.message.content))
  expect(await reader.chat(pane, { from: tail.start, since: tail.token })).toMatchObject({ unchanged: true })
  expect(readFileSync(file)).toEqual(before)
  writeDevinFixture(home, { rows: [{ id: 300, parent: 299, message: devinMessage('assistant', 'New reply') }] })
  const next = await reader.chat(pane, { from: tail.start, since: tail.token })
  expect(next.start).toBe(tail.start)
  expect(next.rewritten).toBeUndefined()
  expect(next.items?.at(-1)?.text).toBe('New reply')
  expect(next.token).not.toBe(tail.token)
})

it('invalidates old pages when the active chain rewinds above their anchor', async () => {
  const { home, reader } = fixture()
  writeDevinFixture(home, { rows: Array.from({ length: 150 }, (_, id) => ({ id, parent: id ? id - 1 : null, message: devinMessage('assistant', `Reply ${id}`) })) })
  const old = await reader.chat(pane)
  writeDevinFixture(home, { rows: [{ id: 200, parent: 0, message: devinMessage('assistant', 'Replacement branch') }] })
  const next = await reader.chat(pane, { from: old.start, anchor: old.token })
  expect(next.rewritten).toBe(true)
  expect(next.items?.map(i => i.text)).toEqual(['Reply 0', 'Replacement branch'])
  expect(await reader.chat(pane, { before: old.start, anchor: old.token })).toMatchObject({ rewritten: true, items: [] })
})

it('falls back to a rewritten bottom when a from-cursor page is too large', async () => {
  const { home } = fixture()
  writeDevinFixture(home, { rows: Array.from({ length: 130 }, (_, id) => ({
    id, parent: id ? id - 1 : null, message: devinMessage('assistant', `Blob ${id} ${'x'.repeat(80)}`),
  })) })
  const reader = createDevinTranscripts({ home, maxPageBytes: 800 })
  const tail = await reader.chat(pane)
  expect(tail.start).toBe(11)
  const next = await reader.chat(pane, { from: 1 })
  expect(next.rewritten).toBe(true)
  expect(next.start).toBe(tail.start)
  expect(next.items).toHaveLength(120)
  expect(next.items?.at(-1)?.text).toContain('Blob 129')
})

it('filters injected user records and never exposes reasoning signatures or system context', async () => {
  const { home, reader } = fixture()
  writeDevinFixture(home, { rows: [
    { id: 0, message: devinMessage('user', 'Injected context', { metadata: {} }) },
    { id: 1, parent: 0, message: devinMessage('user', 'Human question') },
    { id: 2, parent: 1, message: devinMessage('assistant', 'Answer', { thinking: { thinking: 'Reasoning summary', signature: 'INTERNAL_SIGNATURE' } }) },
  ] })
  const r = await reader.chat(pane)
  expect(r.items?.map(i => [i.role, i.text])).toEqual([['user', 'Human question'], ['thinking', 'Reasoning summary'], ['assistant', 'Answer']])
  expect(JSON.stringify(r)).not.toContain('INTERNAL_SIGNATURE')
})

it('updates a tool in place and recovers its result even on an older page', async () => {
  const { home, reader } = fixture()
  const call = { id: 'call-1', name: 'exec', arguments: { command: 'npm test' } }
  const rows = [
    { id: 0, message: devinMessage('assistant', '', { tool_calls: [call] }) },
    ...Array.from({ length: 130 }, (_, i) => ({ id: i + 1, parent: i, message: devinMessage('assistant', `Progress ${i}`) })),
  ]
  writeDevinFixture(home, { rows })
  const tail = await reader.chat(pane)
  const older = await reader.chat(pane, { before: tail.start })
  const tool = older.items?.find(i => i.role === 'tool')
  expect(tool).toMatchObject({ name: 'exec', text: 'npm test', ref: '1:t0' })
  writeDevinFixture(home, { rows: [{ id: 131, parent: 130, message: devinMessage('tool', 'One test failed', { tool_call_id: call.id, metadata: { extensions: { 'chisel/tool_result_meta': { success: false }, 'chisel/terminal_output': { exit: { exit_code: 1 } } } } }) }] })
  const updated = (await reader.chat(pane, { before: tail.start })).items?.find(i => i.role === 'tool')
  expect(updated).toMatchObject({ ...tool, out: 'One test failed', error: true })
  expect(updated?.ref).toBe(tool?.ref)
})

it('never displays cached tool results from an abandoned branch', async () => {
  const { home, reader } = fixture()
  const call = { id: 'reused-call', name: 'exec', arguments: { command: 'echo example' } }
  writeDevinFixture(home, { rows: [
    { id: 0, message: devinMessage('assistant', '', { tool_calls: [call] }) },
    { id: 1, parent: 0, message: devinMessage('tool', 'Abandoned result', { tool_call_id: call.id }) },
    { id: 2, parent: 0, message: devinMessage('assistant', 'Current branch') },
  ] })
  const r = await reader.chat(pane)
  expect(r.items?.find(i => i.role === 'tool')?.out).toBeUndefined()
  expect(JSON.stringify(r.items)).not.toContain('Abandoned result')
})

it('keeps image data out of pages and reads only images of the reported main chain', async () => {
  const { home, reader } = fixture()
  const image = { type: 'image', data: Buffer.from('sample-image').toString('base64'), mimeType: 'image/png' }
  writeDevinFixture(home, { rows: [
    { id: 0, message: devinMessage('user', 'Describe this', { metadata: { is_user_input: true, extensions: { 'chisel/acp-content-blocks': [{ type: 'text', text: 'Describe this' }, image] } } }) },
    { id: 1, parent: 0, message: devinMessage('assistant', 'Old branch') },
    { id: 2, parent: 0, message: devinMessage('assistant', 'Current reply') },
  ] })
  const r = await reader.chat(pane)
  expect(r.items?.[0]).toMatchObject({ images: 1, text: 'Describe this', ref: '1:u' })
  expect(JSON.stringify(r)).not.toContain(image.data)
  expect(await reader.image(pane, r.file!, '1:u', 0)).toEqual({ type: 'image/png', body: Buffer.from('sample-image') })
  expect(await reader.image(pane, 'another-file', '1:u', 0)).toBeNull()
  expect(await reader.image(pane, r.file!, '2:a', 0)).toBeNull()
  expect(await reader.image(pane, r.file!, '1:u', -1)).toBeNull()
})

it('reads tool and assistant images while refusing active image MIME types', async () => {
  const { home, reader } = fixture()
  const image = { type: 'image', data: Buffer.from('<svg></svg>').toString('base64'), mimeType: 'image/svg+xml' }
  writeDevinFixture(home, { rows: [
    { id: 0, message: devinMessage('assistant', '', { tool_calls: [{ id: 'image-call', name: 'read', arguments: { path: 'example.svg' } }] }) },
    { id: 1, parent: 0, message: devinMessage('tool', 'An image', { tool_call_id: 'image-call', metadata: { extensions: { 'chisel/tool_call_content': [{ type: 'content', content: image }] } } }) },
    { id: 2, parent: 1, message: devinMessage('assistant', [{ type: 'text', text: 'Image reply' }, image]) },
  ] })
  const r = await reader.chat(pane)
  expect(r.items?.find(i => i.role === 'tool')).toMatchObject({ images: 1, ref: '1:r' })
  expect(r.items?.find(i => i.role === 'assistant')).toMatchObject({ images: 1, ref: '3:a', text: 'Image reply' })
  expect(await reader.image(pane, r.file!, '1:r', 0)).toMatchObject({ type: 'application/octet-stream' })
  expect(await reader.image(pane, r.file!, '3:a', 0)).toMatchObject({ type: 'application/octet-stream' })
})

it('restarts the tail when the transcript file is replaced at the same path', async () => {
  const { home, reader } = fixture()
  const file = writeDevinFixture(home, { rows: [{ id: 0, message: devinMessage('assistant', 'Old database') }] })
  const old = await reader.chat(pane)
  const alternate = fixture().home
  const replacement = writeDevinFixture(alternate, { rows: [{ id: 0, message: devinMessage('assistant', 'New database') }] })
  renameSync(replacement, file)
  const next = await reader.chat(pane, { from: old.start, anchor: old.token })
  expect(next.items?.[0]?.text).toBe('New database')
  expect(next.token).not.toBe(old.token)
})

it('searches only human and assistant messages of the active chain and keeps stable reply identities', async () => {
  const { home, reader } = fixture()
  writeDevinFixture(home, { rows: [
    { id: 0, message: devinMessage('user', 'Café example') },
    { id: 1, parent: 0, message: devinMessage('assistant', 'Abandoned café') },
    { id: 2, parent: 0, message: devinMessage('assistant', 'Current café reply') },
  ] })
  const r = await reader.search(pane, 'cafe', Date.now() + 5000)
  expect(r.hits.map(i => i.text)).toEqual(['Current café reply', 'Café example'])
  expect(r.hits.map(i => i.offset)).toEqual([3, 1])
  const first = await reader.latestReply(pane)
  expect(first?.text).toBe('Current café reply')
  writeDevinFixture(home, { rows: [{ id: 2, parent: 0, message: devinMessage('assistant', 'Current café reply, extended') }] })
  expect((await reader.latestReply(pane))?.key).toBe(first?.key)
})

it('answers unchanged polls from a cheap file signature without rereading the transcript', async () => {
  const { home } = fixture()
  writeDevinFixture(home, { rows: [{ id: 0, message: devinMessage('assistant', 'Stable reply') }] })
  const { fs, counts } = countingFs()
  const reader = createDevinTranscripts({ home, fs })
  const first = await reader.chat(pane)
  expect(first.items?.[0]?.text).toBe('Stable reply')
  expect(counts.read).toBe(1)
  const again = await reader.chat(pane, { from: first.start, since: first.token })
  expect(again).toMatchObject({ unchanged: true })
  expect(counts.read).toBe(1)
  expect(counts.stat).toBeGreaterThanOrEqual(2)
})

it('reports malformed transcripts instead of erasing the conversation', async () => {
  const { home } = fixture()
  const file = writeDevinFixture(home, { rows: [{ id: 0, message: devinMessage('assistant', 'ok') }] })
  const reader = createDevinTranscripts({ home, failQuietMs: 0 })
  writeFileSync(file, 'not-json')
  await expect(reader.chat(pane)).rejects.toThrow(/Unsupported Devin transcript format/)
  writeFileSync(file, '[]')
  await expect(reader.chat(pane)).rejects.toBeInstanceOf(HerdrError)
})

it('returns the last good page after a failed poll and does not retry during the quiet window', async () => {
  const { home } = fixture()
  writeDevinFixture(home, { rows: [{ id: 0, message: devinMessage('assistant', 'Last good') }] })
  let down = false
  let stats = 0
  const fs: MachineFs = {
    ...localFs,
    stat: async p => { stats++; if (down) throw Object.assign(new Error('ssh down'), { code: 'remote' }); return localFs.stat(p) },
  }
  const reader = createDevinTranscripts({ home, fs, failQuietMs: 60_000 })
  const first = await reader.chat(pane)
  down = true
  const statsAfterLoad = stats
  expect(await reader.chat(pane, { since: first.token })).toMatchObject({ unchanged: true, token: first.token })
  expect(stats).toBe(statsAfterLoad + 1)
  expect(await reader.chat(pane, { since: first.token })).toMatchObject({ unchanged: true })
  expect(stats).toBe(statsAfterLoad + 1)
})

it('logs the first failed poll then returns a quiet HerdrError without restatting', async () => {
  const { home } = fixture()
  let stats = 0
  const fs: MachineFs = {
    ...localFs,
    stat: async () => { stats++; throw Object.assign(new Error('ssh down'), { code: 'remote' }) },
  }
  const reader = createDevinTranscripts({ home, fs, failQuietMs: 60_000 })
  await expect(reader.chat(pane)).rejects.toThrow('ssh down')
  expect(stats).toBe(1)
  await expect(reader.chat(pane)).rejects.toBeInstanceOf(HerdrError)
  expect(stats).toBe(1)
})

it('reads an anonymized ATIF-v1.7 transcript from Devin CLI 3000.11.234', async () => {
  const raw = JSON.parse(readFileSync(realFixture, 'utf8'))
  expect(raw.schema_version).toBe('ATIF-v1.7')
  expect(raw.notes).toMatch(/3000\.11\.234/)
  const { home, reader } = fixture()
  const dest = path.join(home, '.local/share/devin/cli/transcripts')
  mkdirSync(dest, { recursive: true })
  copyFileSync(realFixture, path.join(dest, 'devin-test.json'))
  const r = await reader.chat(pane)
  expect(r.available).toBe(true)
  expect(r.file).toBe('devin-test.json')
  expect(r.items?.map(i => i.role)).toEqual(['user', 'thinking', 'assistant', 'tool', 'tool', 'user', 'assistant'])
  expect(r.items?.find(i => i.role === 'tool' && i.name === 'exec')).toMatchObject({ text: 'npm test', out: '1 passed, 0 failed' })
  const shot = r.items?.find(i => i.role === 'user' && i.images)
  expect(shot).toMatchObject({ images: 1, text: 'Describe this screenshot of the passing run.' })
  expect(JSON.stringify(r)).not.toContain(raw.steps[2].message[1].extra.data)
  expect(await reader.model(pane)).toEqual({ id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' })
  const img = await reader.image(pane, r.file!, shot!.ref!, 0)
  expect(img?.type).toBe('image/png')
  expect(img?.body.length).toBeGreaterThan(0)
})
