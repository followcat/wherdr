import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createTranscripts } from '../server/utils/transcripts'
import { devinMessage, writeDevinFixture } from './helpers/devin-fixture.mjs'
import { HerdrError } from '../server/utils/herdr'
import { createDevinTranscripts } from '../server/utils/devinTranscripts'
import { type MachineFs, localFs } from '../server/utils/fsx'

const homes: string[] = []
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-devin-'))
  homes.push(home)
  return { home, reader: createTranscripts({ home, herdr: async () => ({}) }) }
}
afterEach(() => { vi.unstubAllEnvs(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
const pane = { id: 'p1', agent: 'devin', cwd: '/projects/demo', agentSession: 'devin-test' }
const realFixture = fileURLToPath(new URL('./fixtures/devin-atif-v1.7.json', import.meta.url))
const realShapeFixture = fileURLToPath(new URL('./fixtures/devin-atif-v1.7-real.json', import.meta.url))

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

it('hashes image payloads so the view can collapse a repeated picture', async () => {
  const { home, reader } = fixture()
  const image = { type: 'image', data: Buffer.from('same-shot').toString('base64'), mimeType: 'image/png' }
  writeDevinFixture(home, { rows: [
    { id: 0, message: devinMessage('user', 'Here', { metadata: { is_user_input: true, extensions: { 'chisel/acp-content-blocks': [{ type: 'text', text: 'Here' }, image] } } }) },
    { id: 1, parent: 0, message: devinMessage('assistant', [{ type: 'text', text: 'Echoing it' }, image]) },
  ] })
  const r = await reader.chat(pane)
  const withImages = r.items!.filter(i => i.images)
  expect(withImages).toHaveLength(2)
  expect(withImages.map(i => i.hashes)).toEqual([[expect.any(String)], [expect.any(String)]])
  expect(withImages[0]!.hashes).toEqual(withImages[1]!.hashes)
  // The view hides a later copy of a picture already shown higher up.
  const { duplicateImages } = await import('../shared/imageDupes')
  const dupes = duplicateImages(r.items!)
  expect(dupes.size).toBe(1)
  expect([...dupes][0]).toBe(`${withImages[1]!.ref}:0`)
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

it('bounds retained conversation documents across sessions', async () => {
  const { home } = fixture()
  const { fs, counts } = countingFs()
  const reader = createDevinTranscripts({ home, fs })
  for (let i = 0; i < 5; i++) {
    const session = `session-${i}`
    writeDevinFixture(home, { session, rows: [{ id: 0, message: devinMessage('assistant', session) }] })
    await reader.chat({ ...pane, agentSession: session })
  }
  expect(counts.read).toBe(5)
  expect((await reader.chat({ ...pane, agentSession: 'session-4' })).items?.[0]?.text).toBe('session-4')
  expect(counts.read).toBe(5)
  expect((await reader.chat({ ...pane, agentSession: 'session-0' })).items?.[0]?.text).toBe('session-0')
  expect(counts.read).toBe(6)
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

it('logs the first failed poll then returns a quiet Error without restatting', async () => {
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
  writeFileSync(path.join(dest, 'devin-test.json'), JSON.stringify({ ...raw, session_id: 'devin-test' }))
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

it('reads the transcript shape Devin CLI 3000.11.234 really writes', async () => {
  // steps[].timestamp (nanosecond RFC 3339), extra.telemetry, metrics and
  // agent.tool_definitions — no metadata object anywhere.
  const raw = JSON.parse(readFileSync(realShapeFixture, 'utf8'))
  expect(raw.schema_version).toBe('ATIF-v1.7')
  expect(raw.agent.version).toBe('3000.11.234')
  expect(raw.steps.every((s: { metadata?: unknown }) => s.metadata === undefined)).toBe(true)
  const { home, reader } = fixture()
  const dest = path.join(home, '.local/share/devin/cli/transcripts')
  mkdirSync(dest, { recursive: true })
  writeFileSync(path.join(dest, 'devin-test.json'), JSON.stringify({ ...raw, session_id: 'devin-test' }))
  const r = await reader.chat(pane)
  expect(r.items?.map(i => i.role)).toEqual(['user', 'thinking', 'assistant', 'tool', 'tool', 'user', 'thinking', 'assistant'])
  expect(r.items?.[0]).toMatchObject({ role: 'user', text: 'Review the cart module in /home/user/acme-shop and run its tests on host-a.', ts: '2026-03-12T09:14:05.441000000+00:00' })
  expect(r.items?.find(i => i.role === 'tool' && i.name === 'exec')).toMatchObject({ text: 'npm test', out: '12 passed, 0 failed' })
  expect(r.items?.find(i => i.role === 'tool' && i.name === 'read')).toMatchObject({ text: '/home/user/acme-shop/src/cart.ts' })
  expect(await reader.model(pane)).toEqual({ id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' })
  const s = await reader.search(pane, 'cart', Date.now() + 5000)
  expect(s.hits.map(i => i.offset)).toEqual([5, 3, 2])
})


it('rewrites the bottom when retained history changes without changing step IDs', async () => {
  const { home } = fixture()
  const rows = Array.from({ length: 150 }, (_, id) => ({ id, parent: id ? id - 1 : null, message: devinMessage('assistant', `Reply ${id}`) }))
  const file = writeDevinFixture(home, { rows })
  const reader = createDevinTranscripts({ home })
  const first = await reader.chat(pane)
  expect(first.start).toBeGreaterThan(0)
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  doc.steps[0].message = 'Rewritten earlier reply ' + 'x'.repeat(200)
  writeFileSync(file, JSON.stringify(doc))
  expect(await reader.chat(pane, { from: first.start, anchor: first.token, since: first.token })).toMatchObject({ rewritten: true })
})

it('preserves image hashes when paging into older history', async () => {
  const { home } = fixture()
  const image = { type: 'image', data: Buffer.from('older-shot').toString('base64'), mimeType: 'image/png' }
  const rows = Array.from({ length: 150 }, (_, id) => ({ id, parent: id ? id - 1 : null, message: devinMessage('assistant', id ? `Reply ${id}` : [{ type: 'text', text: 'Older picture' }, image]) }))
  writeDevinFixture(home, { rows })
  const reader = createDevinTranscripts({ home })
  const first = await reader.chat(pane)
  const older = await reader.chat(pane, { before: first.start })
  expect(older.items?.find(i => i.images)).toMatchObject({ hashes: [expect.any(String)] })
})

it('reuses one recent image document, expiring it and invalidating changed files', async () => {
  const { home } = fixture()
  const image = { type: 'image', data: Buffer.from('on-demand-shot').toString('base64'), mimeType: 'image/png' }
  const file = writeDevinFixture(home, { rows: [{ id: 0, message: devinMessage('assistant', [image, image]) }] })
  const { fs, counts } = countingFs()
  let clock = 1000
  const reader = createDevinTranscripts({ home, fs, now: () => clock })
  const page = await reader.chat(pane)
  expect(counts.read).toBe(1)
  expect((await reader.image(pane, page.file!, page.items![0]!.ref!, 0))?.body.toString()).toBe('on-demand-shot')
  expect((await reader.image(pane, page.file!, page.items![0]!.ref!, 1))?.body.toString()).toBe('on-demand-shot')
  expect(counts.read).toBe(2)
  expect(await reader.chat(pane, { since: page.token })).toMatchObject({ unchanged: true })
  expect(counts.read).toBe(2)
  clock += 2001
  await reader.image(pane, page.file!, page.items![0]!.ref!, 0)
  expect(counts.read).toBe(3)
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  doc.steps[0].message[0].data = Buffer.from('updated-shot').toString('base64')
  writeFileSync(file, JSON.stringify(doc))
  expect((await reader.image(pane, page.file!, page.items![0]!.ref!, 0))?.body.toString()).toBe('updated-shot')
  expect(counts.read).toBe(4)
  writeDevinFixture(home, { session: 'other', rows: [{ id: 0, message: devinMessage('assistant', [image]) }] })
  await reader.image({ ...pane, agentSession: 'other' }, 'other.json', '1:a', 0)
  await reader.image(pane, page.file!, page.items![0]!.ref!, 0)
  expect(counts.read).toBe(6)
})

it('keeps images from different tool results in the same step separate', async () => {
  const { home } = fixture()
  const file = writeDevinFixture(home)
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  const image = (text: string) => ({ type: 'image', data: Buffer.from(text).toString('base64'), mimeType: 'image/png' })
  doc.steps = [{ step_id: 1, source: 'agent', tool_calls: [
    { tool_call_id: 'first', function_name: 'read', arguments: { path: 'first.png' } },
    { tool_call_id: 'second', function_name: 'read', arguments: { path: 'second.png' } },
  ], observation: { results: [
    { source_call_id: 'first', content: [image('first-shot')] },
    { source_call_id: 'second', content: [image('second-shot')] },
  ] } }]
  writeFileSync(file, JSON.stringify(doc))
  const reader = createDevinTranscripts({ home })
  const page = await reader.chat(pane)
  const tools = page.items!.filter(i => i.role === 'tool')
  expect(tools[0]!.ref).not.toBe(tools[1]!.ref)
  expect((await reader.image(pane, page.file!, tools[0]!.ref!, 0))?.body.toString()).toBe('first-shot')
  expect((await reader.image(pane, page.file!, tools[1]!.ref!, 0))?.body.toString()).toBe('second-shot')
})

it('retries after the original failure deadline even when quiet polls keep arriving', async () => {
  const { home } = fixture()
  const file = writeDevinFixture(home, { rows: [{ id: 0, message: devinMessage('assistant', 'Before reconnect') }] })
  let clock = 1000
  let down = false
  const fs: MachineFs = { ...localFs, stat: async p => { if (down) throw new Error('temporarily unavailable'); return localFs.stat(p) } }
  const reader = createDevinTranscripts({ home, fs, now: () => clock, failQuietMs: 100 })
  const first = await reader.chat(pane)
  down = true
  await reader.chat(pane, { since: first.token })
  clock = 1050
  await reader.chat(pane, { since: first.token })
  down = false
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  doc.steps[0].message = 'After reconnect with another reply'
  writeFileSync(file, JSON.stringify(doc))
  clock = 1101
  expect((await reader.chat(pane, { since: first.token })).items?.[0]?.text).toBe('After reconnect with another reply')
})

it('refuses mismatched session identities and unsupported schemas', async () => {
  const { home } = fixture()
  const file = writeDevinFixture(home)
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  const reader = createDevinTranscripts({ home, failQuietMs: 0 })
  for (const change of [{ session_id: 'another-session' }, { schema_version: 'ATIF-v99' }, { steps: {} }]) {
    writeFileSync(file, JSON.stringify({ ...doc, ...change }))
    await expect(reader.chat(pane)).rejects.toThrow()
  }
})

it('rejects oversized transcripts before reading their contents', async () => {
  const { home } = fixture()
  let reads = 0
  const reader = createDevinTranscripts({ home, fs: { ...localFs,
    stat: async () => ({ size: 25 * 1024 * 1024, mtimeMs: 1, isFile: true, isDir: false }),
    read: async () => { reads++; return Buffer.alloc(0) },
  } })
  await expect(reader.chat(pane)).rejects.toThrow(/size limit/)
  expect(reads).toBe(0)
})

it('never answers unchanged to a new viewer or an older-page request during an outage', async () => {
  const { home } = fixture()
  const file = writeDevinFixture(home, { rows: [{ id: 0, message: devinMessage('assistant', 'Saved reply') }] })
  const reader = createDevinTranscripts({ home })
  const first = await reader.chat(pane)
  writeFileSync(file, '{partial')
  expect(await reader.chat(pane, { since: first.token })).toMatchObject({ unchanged: true })
  await expect(reader.chat(pane)).rejects.toThrow()
  await expect(reader.chat(pane, { before: 1, since: first.token })).rejects.toThrow()
})

it('invalidates older pages when compaction changes the prefix with retained step IDs', async () => {
  const { home } = fixture()
  const file = writeDevinFixture(home, { rows: Array.from({ length: 300 }, (_, id) => ({ id, parent: id ? id - 1 : null, message: devinMessage('assistant', `Reply ${id}`) })) })
  const reader = createDevinTranscripts({ home })
  const first = await reader.chat(pane)
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  doc.steps[0].message = 'Compacted prefix'
  writeFileSync(file, JSON.stringify(doc))
  expect(await reader.chat(pane, { before: first.start, anchor: first.token })).toMatchObject({ rewritten: true, older: true, items: [] })
})

it('keeps its raw token when the HTTP layer decorates a response token', async () => {
  const { home } = fixture()
  const file = writeDevinFixture(home, { rows: [{ id: 0, message: devinMessage('assistant', 'Saved reply') }] })
  const reader = createDevinTranscripts({ home })
  const first = await reader.chat(pane)
  const rawToken = first.token
  first.token += '#0123456789abcdef'
  writeFileSync(file, '{partial')
  expect(await reader.chat(pane, { since: rawToken })).toMatchObject({ unchanged: true, token: rawToken })
})

it('never opens transcript image paths, including protected files and relative escapes', async () => {
  const { home } = fixture()
  const file = writeDevinFixture(home)
  const secret = path.join(home, '.ssh/id_ed25519')
  mkdirSync(path.dirname(secret), { recursive: true })
  writeFileSync(secret, 'invented private bytes')
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  doc.steps = [{ step_id: 1, source: 'user', message: [
    { type: 'image', path: secret },
    { type: 'image', source: { path: '../../../../.ssh/id_ed25519' } },
    { type: 'image', source: { path: '/home/user/.ssh/id_ed25519' } },
  ] }]
  writeFileSync(file, JSON.stringify(doc))
  const opened: string[] = []
  const reader = createDevinTranscripts({ home, fs: { ...localFs, read: async (p, start, len) => {
    opened.push(p)
    return localFs.read(p, start, len)
  } } })
  for (let index = 0; index < 3; index++) expect(await reader.image(pane, 'devin-test.json', '1:u', index)).toBeNull()
  expect(opened.every(p => p === file)).toBe(true)
})

it('invalidates the page holding a tool when its observation arrives in a later step', async () => {
  const { home } = fixture()
  const file = writeDevinFixture(home)
  const doc = JSON.parse(readFileSync(new URL('./fixtures/devin-atif-later-result.json', import.meta.url), 'utf8'))
  const result = doc.steps.pop()
  doc.steps.push(...Array.from({ length: 150 }, (_, i) => ({ step_id: i + 2, source: 'agent', message: `Progress ${i}` })))
  writeFileSync(file, JSON.stringify(doc))
  const reader = createDevinTranscripts({ home })
  const tail = await reader.chat(pane)
  const older = await reader.chat(pane, { before: tail.start, anchor: tail.token })
  expect(older.items?.find(i => i.role === 'tool')).toMatchObject({ text: 'npm test' })
  doc.steps.push(result)
  writeFileSync(file, JSON.stringify(doc))
  expect(await reader.chat(pane, { from: tail.start, since: tail.token, anchor: tail.token })).toMatchObject({ rewritten: true })
  expect(await reader.chat(pane, { before: tail.start, anchor: tail.token })).toMatchObject({ rewritten: true, items: [] })
  expect((await reader.chat(pane, { before: tail.start })).items?.find(i => i.role === 'tool')).toMatchObject({ out: '12 passed' })
})

it('bounds full-history scans for 40000 hidden steps on initial and cached reads', async () => {
  const { home, reader } = fixture()
  const file = writeDevinFixture(home)
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  doc.steps = Array.from({ length: 40000 }, (_, i) => ({ step_id: i + 1, source: 'system', message: 'Hidden performance fixture' }))
  writeFileSync(file, JSON.stringify(doc))
  const iterate = Array.prototype[Symbol.iterator]
  let scans = 0
  Array.prototype[Symbol.iterator] = function (this: any[]) {
    if (this.length === 40000 && this[0]?.message === 'Hidden performance fixture') {
      if (++scans > 12) throw new Error('Full-history scan budget exceeded')
    }
    return iterate.call(this)
  }
  try {
    expect((await reader.chat(pane)).items).toEqual([])
    expect(await reader.latestReply(pane)).toBeNull()
  } finally { Array.prototype[Symbol.iterator] = iterate }
  expect(scans).toBeLessThanOrEqual(12)
})

it('paginates by the call step when its image result is in a later step', async () => {
  const { home } = fixture()
  const file = writeDevinFixture(home)
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  // 121 visible source steps: step 2 is a tool call, while its image is
  // stored in the separate, otherwise invisible observation step 122.
  doc.steps = Array.from({ length: 121 }, (_, i) => ({ step_id: i + 1, source: 'agent', message: `Reply ${i + 1}` }))
  doc.steps[1] = { step_id: 2, source: 'agent', tool_calls: [
    { tool_call_id: 'diagram-call', function_name: 'read', arguments: { path: 'diagram.png' } },
  ] }
  const image = Buffer.from('invented diagram image')
  doc.steps.push({ step_id: 122, source: 'agent', observation: { results: [
    { source_call_id: 'diagram-call', content: [{ type: 'image', mimeType: 'image/png', data: image.toString('base64') }] },
  ] } })
  writeFileSync(file, JSON.stringify(doc))
  const reader = createDevinTranscripts({ home })
  const tail = await reader.chat(pane)
  expect(tail.items).toHaveLength(120)
  expect(tail.items?.[0]).toMatchObject({ role: 'tool', ref: '122:r', images: 1 })
  expect(tail.start).toBe(2)
  expect(await reader.image(pane, tail.file!, tail.items![0]!.ref!, 0)).toEqual({ type: 'image/png', body: image })

  const older = await reader.chat(pane, { before: tail.start, anchor: tail.token })
  expect(older.start).toBe(0)
  expect(older.items?.map(i => i.text)).toEqual(['Reply 1'])
  const combined = [...older.items!, ...tail.items!]
  expect(combined).toHaveLength(121)
  expect(new Set(combined.map(i => i.ref)).size).toBe(121)

  doc.steps.push({ step_id: 123, source: 'agent', message: 'New reply' })
  writeFileSync(file, JSON.stringify(doc))
  const next = await reader.chat(pane, { from: tail.start, since: tail.token, anchor: tail.token })
  expect(next.start).toBe(2)
  expect(next.rewritten).toBeUndefined()
  expect(next.items?.slice(0, -1)).toEqual(tail.items)
  expect(next.items?.at(-1)?.text).toBe('New reply')
})

it('yields during a large cached search and stops when its deadline expires', async () => {
  const raw = Buffer.from(JSON.stringify({ schema_version: 'ATIF-v1.7', session_id: pane.agentSession,
    steps: Array.from({ length: 8000 }, (_, i) => ({ step_id: i + 1, source: 'agent', message: i ? 'Unrelated text '.repeat(60) : 'Oldest needle' })),
  }))
  const reader = createDevinTranscripts({ home: '/home/user', fs: { ...localFs,
    stat: async () => ({ size: raw.length, mtimeMs: 1.5, isFile: true, isDir: false }),
    read: async (_p, start, len) => raw.subarray(start, start + len),
  } })
  await reader.chat(pane) // Exclude filesystem I/O and the initial JSON parse from the yield check.
  let clock = 0
  let yielded = false
  const time = vi.spyOn(Date, 'now').mockImplementation(() => clock)
  try {
    const pending = reader.search(pane, 'needle', 1)
    setImmediate(() => { yielded = true; clock = 1 })
    const result = await pending
    expect(yielded).toBe(true)
    expect(result).toMatchObject({ hits: [], limited: true })
    clock = 0
    const capped = await reader.search(pane, 'Unrelated', 1000)
    expect(capped.hits.map(h => h.offset)).toEqual([8000, 7999, 7998, 7997, 7996, 7995, 7994, 7993])
    expect(capped.limited).toBe(true)
  } finally { time.mockRestore() }
})
