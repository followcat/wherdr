import { mkdtempSync, rmSync, readFileSync, renameSync } from 'node:fs'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createTranscripts } from '../server/utils/transcripts'
import { devinMessage, writeDevinFixture } from './helpers/devin-fixture.mjs'
import { createDevinTranscripts } from '../server/utils/devinTranscripts'
import type { ShellExec } from '../server/utils/fsx'

const homes: string[] = []
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-devin-'))
  homes.push(home)
  return { home, reader: createTranscripts({ home, herdr: async () => ({}) }) }
}
afterEach(() => { vi.unstubAllEnvs(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
const pane = { id: 'p1', agent: 'devin', cwd: '/projects/demo', agentSession: 'devin-test' }

it('reads Unicode messages in services with an ASCII locale', async () => {
  const { home, reader } = fixture()
  writeDevinFixture(home, { rows: [{ id: 0, message: devinMessage('assistant', '中文 café reply') }] })
  vi.stubEnv('LC_ALL', 'C')
  vi.stubEnv('PYTHONUTF8', '0')
  vi.stubEnv('PYTHONCOERCECLOCALE', '0')
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

it('handles a Unicode home path and session id under the C locale', async () => {
  const { home } = fixture()
  const nested = path.join(home, 'café 中文')
  const session = 'session-café-中文'
  writeDevinFixture(nested, { session, rows: [{ id: 0, message: devinMessage('assistant', 'Unicode history') }] })
  vi.stubEnv('LC_ALL', 'C')
  vi.stubEnv('PYTHONUTF8', '0')
  vi.stubEnv('PYTHONCOERCECLOCALE', '0')
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
  writeDevinFixture(home, { rows, states: [{ id: call.id, update: { status: 'in_progress' } }] })
  const tail = await reader.chat(pane)
  const older = await reader.chat(pane, { before: tail.start })
  const tool = older.items?.find(i => i.role === 'tool')
  expect(tool).toMatchObject({ name: 'exec', text: 'npm test', ref: '0:t0' })
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
  ], states: [{ id: call.id, update: { status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Abandoned result' } }] } }] })
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
  expect(r.items?.[0]).toMatchObject({ images: 1, text: 'Describe this', ref: '0:u' })
  expect(JSON.stringify(r)).not.toContain(image.data)
  expect(await reader.image(pane, r.file!, '0:u', 0)).toEqual({ type: 'image/png', body: Buffer.from('sample-image') })
  expect(await reader.image(pane, 'another-file', '0:u', 0)).toBeNull()
  expect(await reader.image(pane, r.file!, '1:a', 0)).toBeNull()
  expect(await reader.image(pane, r.file!, '0:u', -1)).toBeNull()
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
  expect(r.items?.find(i => i.role === 'assistant')).toMatchObject({ images: 1, ref: '2:a', text: 'Image reply' })
  expect(await reader.image(pane, r.file!, '1:r', 0)).toMatchObject({ type: 'application/octet-stream' })
  expect(await reader.image(pane, r.file!, '2:a', 0)).toMatchObject({ type: 'application/octet-stream' })
})

it('restarts the tail when the database is replaced at the same path', async () => {
  const { home, reader } = fixture()
  const file = writeDevinFixture(home, { rows: [{ id: 0, message: devinMessage('assistant', 'Old database') }] })
  const old = await reader.chat(pane)
  const alternate = fixture().home
  const replacement = writeDevinFixture(alternate, { rows: [{ id: 0, message: devinMessage('assistant', 'New database') }] })
  renameSync(replacement, file)
  const next = await reader.chat(pane, { from: old.start, anchor: old.token })
  expect(next.file).not.toBe(old.file)
  expect(next.rewritten).toBe(true)
  expect(next.items?.[0]?.text).toBe('New database')
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

it('uses the same reader through the remote execution boundary with literal arguments', async () => {
  const { home } = fixture()
  const sid = "session' ; SELECT other"
  writeDevinFixture(home, { session: sid, rows: [{ id: 0, message: devinMessage('user', 'Literal session') }] })
  const run = promisify(execFile)
  let calls = 0
  const exec: ShellExec = async (script, args = []) => {
    calls++
    const r = await run('sh', ['-c', script, 'sh', ...args], { encoding: 'buffer' })
    return { code: 0, stdout: r.stdout, stderr: r.stderr.toString() }
  }
  const remote = createDevinTranscripts({ home, exec })
  expect((await remote.chat({ ...pane, agentSession: sid })).items?.[0]?.text).toBe('Literal session')
  expect(calls).toBe(1)
})

it('reads committed WAL snapshots while a writer holds an uncommitted change', async () => {
  const { home, reader } = fixture()
  const file = writeDevinFixture(home, { rows: [{ id: 0, message: devinMessage('assistant', 'Committed') }] })
  const writer = spawn('python3', ['-u', '-c', `import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1]);c.execute('BEGIN IMMEDIATE')
c.execute('UPDATE message_nodes SET chat_message=?', (json.dumps({'role':'assistant','content':'After commit','metadata':{}}),))
print('ready',flush=True);sys.stdin.readline();c.commit();c.close()
`, file], { stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    await new Promise<void>((resolve, reject) => { writer.stdout.once('data', () => resolve()); writer.once('error', reject) })
    expect((await reader.chat(pane)).items?.[0]?.text).toBe('Committed')
    const closed = new Promise(resolve => writer.once('close', resolve))
    writer.stdin.end('\n')
    await closed
    expect((await reader.chat(pane)).items?.[0]?.text).toBe('After commit')
  } finally { writer.kill() }
})

it('reports malformed schemas and broken chains instead of erasing the conversation', async () => {
  const { home, reader } = fixture()
  const file = writeDevinFixture(home, { rows: [{ id: 1, parent: 9, message: devinMessage('assistant', 'Broken') }] })
  await expect(reader.chat(pane)).rejects.toThrow(/chain|ordering/)
  execFileSync('python3', ['-c', 'import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute("DROP TABLE message_nodes");c.commit()', file])
  await expect(reader.chat(pane)).rejects.toThrow(/Unsupported Devin session database format/)
})

it('dedupes remote queries inside the TTL, expires them after, and never caches errors', async () => {
  const { home } = fixture()
  let calls = 0
  const exec: ShellExec = async () => { calls++; return { code: 0, stdout: Buffer.from('{"available":false}'), stderr: '' } }
  const remote = createDevinTranscripts({ home, exec, cacheMs: 60 })
  const pane = { id: 'p1', agent: 'devin', cwd: '/x', agentSession: 's' }
  // A burst of identical polls — concurrent and sequential — is one query.
  await Promise.all([remote.chat(pane), remote.chat(pane)])
  await remote.chat(pane)
  expect(calls).toBe(1)
  await new Promise(resolve => setTimeout(resolve, 80))
  await remote.chat(pane)
  expect(calls).toBe(2)
  // A failure is retried, not replayed.
  const failing = createDevinTranscripts({ home, exec: async () => { calls++; throw new Error('ssh down') }, cacheMs: 60000 })
  await expect(failing.chat(pane)).rejects.toThrow('ssh down')
  await expect(failing.chat(pane)).rejects.toThrow('ssh down')
  expect(calls).toBe(4)
})
