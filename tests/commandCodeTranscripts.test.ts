import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createTranscripts } from '../server/utils/transcripts'
import {
  commandCodeAssistant, commandCodeModel, commandCodePNG, commandCodeSession,
  commandCodeToolResults, commandCodeUser, writeCommandCodeSession,
} from './helpers/command-code-fixture.mjs'

const homes: string[] = []
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-command-code-'))
  homes.push(home)
  return { home, reader: createTranscripts({ home, herdr: async () => ({}) }) }
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

const pane = { id: 'p1', agent: 'cmd', cwd: '/home/user/acme-shop' }

it('reads a Command Code session: messages, thinking, tools and their results', async () => {
  const { home, reader } = fixture()
  const lines = [
    commandCodeSession('sess-1', '/home/user/acme-shop'),
    commandCodeModel('example/model-a'),
    commandCodeUser('u1', null, 'Fix the login bug', 1000),
    commandCodeAssistant('a1', 'u1', [
      { type: 'thinking', thinking: 'Plan the fix', signature: 'private-signature' },
      { type: 'text', text: 'I will inspect the form.' },
      { type: 'tool_use', id: 'call_1', name: 'shell_command', input: { command: 'rg login' } },
      { type: 'tool_use', id: 'call_2', name: 'edit_file', input: { file_path: 'src/login.ts' } },
    ], { ms: 2000, usage: { inputTokens: 120, cacheReadTokens: 80, outputTokens: 20, costUsd: 0.004 } }),
    commandCodeToolResults('u2', 'a1', [
      { tool_use_id: 'call_1', content: [{ type: 'text', text: 'src/login.ts:12' }] },
      { tool_use_id: 'call_2', content: [{ type: 'text', text: 'patched' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: commandCodePNG } }] },
    ], 3000),
    commandCodeAssistant('a2', 'u2', [{ type: 'text', text: 'Fixed.' }], { model: 'example/model-b', ms: 4000 }),
    commandCodeUser('hidden', 'a2', 'Monitor wake-up: check the queue', 5000, { isMeta: true }),
    { type: 'message', id: 'hidden-string', parentId: 'a2', timestamp: '2026-01-01T00:00:06.000Z', message: { role: 'user', content: 'Hidden string automation', meta: { source: 'user', isMeta: true } } },
  ]
  writeCommandCodeSession(home, { id: 'sess-1', cwd: pane.cwd, lines })

  const r = await reader.chat(pane)
  expect(r).toMatchObject({ available: true, session: 'sess-1' })
  expect(r.items?.map(i => [i.role, i.text])).toEqual([
    ['user', 'Fix the login bug'],
    ['thinking', 'Plan the fix'],
    ['assistant', 'I will inspect the form.'],
    ['tool', 'rg login'],
    ['tool', 'src/login.ts'],
    ['assistant', 'Fixed.'],
  ])
  const shell = r.items!.find(i => i.name === 'shell_command')!
  expect(shell.out).toBe('src/login.ts:12')
  const edit = r.items!.find(i => i.name === 'edit_file')!
  expect(edit.out).toBe('patched')
  expect(edit.images).toBe(1)
  expect(JSON.stringify(r)).not.toContain('private-signature')
  expect((await reader.model(pane))?.id).toBe('example/model-b')
  // The 120 input tokens already include the 80 cached ones.
  expect(await reader.commandCodeStats(pane)).toMatchObject({
    line: expect.stringContaining('Command Code'),
    meters: expect.stringContaining('120 context'),
  })
  expect(r.items!.some(i => i.text.includes('Monitor wake-up'))).toBe(false)
  expect(r.items!.some(i => i.text.includes('Hidden string automation'))).toBe(false)

  const img = await reader.image(pane, r.file!, edit.ref!, 0)
  expect(img?.type).toBe('image/png')
  expect(img?.body.equals(Buffer.from(commandCodePNG, 'base64'))).toBe(true)
})

it('finds the last usage through a trailing record larger than the status window', async () => {
  const { home, reader } = fixture()
  const big = 'x'.repeat(300 * 1024)
  writeCommandCodeSession(home, {
    id: 'sess-1', cwd: pane.cwd, lines: [
      commandCodeSession('sess-1', pane.cwd),
      commandCodeUser('u1', null, 'Take a screenshot', 1000),
      commandCodeAssistant('a1', 'u1', [
        { type: 'tool_use', id: 'call_1', name: 'read_file', input: { file_path: 'shot.png' } },
      ], { ms: 2000, usage: { inputTokens: 1000, cacheReadTokens: 800, costUsd: 0.002 } }),
      commandCodeToolResults('u2', 'a1', [{ tool_use_id: 'call_1', content: [{ type: 'text', text: big }] }], 3000),
    ],
  })
  const stats = await reader.commandCodeStats(pane)
  expect(stats?.meters).toContain('1.0k context')
  expect(stats?.meters).not.toContain('1.8k')
})

it('marks a failed tool result', async () => {
  const { home, reader } = fixture()
  writeCommandCodeSession(home, {
    id: 'sess-1', cwd: pane.cwd, lines: [
      commandCodeSession('sess-1', pane.cwd),
      commandCodeUser('u1', null, 'Run the tests', 1000),
      commandCodeAssistant('a1', 'u1', [{ type: 'tool_use', id: 'call_1', name: 'shell_command', input: { command: 'npm test' } }], { ms: 2000 }),
      commandCodeToolResults('u2', 'a1', [{ tool_use_id: 'call_1', content: [{ type: 'text', text: 'one failure' }], is_error: true }], 3000),
    ],
  })
  const r = await reader.chat(pane)
  expect(r.items?.find(i => i.role === 'tool')).toMatchObject({ text: 'npm test', out: 'one failure', error: true })
})

it('locates by cwd, ignores checkpoints and follows the newest session', async () => {
  const { home, reader } = fixture()
  const write = (id, cwd, text, mtime, slug = 'home-user-acme-shop') => {
    const lines = [commandCodeSession(id, cwd), commandCodeUser(`${id}-u`, null, text)]
    return writeCommandCodeSession(home, { id, cwd, slug, lines, mtime })
  }
  const old = write('sess-old', pane.cwd, 'Old conversation', new Date(1_700_000_000_000))
  const recent = write('sess-new', pane.cwd, 'New conversation', new Date(1_700_000_100_000))
  writeFileSync(path.join(path.dirname(recent), 'sess-new.checkpoints.jsonl'), '{"type":"checkpoint"}\n')
  const other = write('sess-other', '/home/user/other', 'Other project', new Date(1_700_000_200_000), 'home-user-other')

  expect((await reader.chat(pane))?.items?.[0]?.text).toBe('New conversation')
  expect((await reader.chat({ ...pane, id: 'p2', cwd: '/home/user/other' }))?.items?.[0]?.text).toBe('Other project')
  expect((await reader.chat({ ...pane, id: 'p3', agentSession: 'sess-old' }))?.items?.[0]?.text).toBe('Old conversation')
  expect((await reader.chat({ ...pane, id: 'p4', cwd: '/home/user/none' }))).toMatchObject({ available: false, reason: 'not_found' })
  expect(other).toBeTruthy()
  expect(old).toBeTruthy()
})

it('pages the tail, follows an unchanged token and sees appended replies', async () => {
  const { home, reader } = fixture()
  const lines = [commandCodeSession('sess-1', pane.cwd), commandCodeModel('example/model-a')]
  const long = 'x'.repeat(32 * 1024)
  let parent = null
  for (let i = 0; i < 100; i++) {
    const user = `u${i}`
    const assistant = `a${i}`
    lines.push(commandCodeUser(user, parent, `Message ${i} ${long}`, i * 10))
    lines.push(commandCodeAssistant(assistant, user, [{ type: 'text', text: `Reply ${i}` }], { ms: i * 10 + 1 }))
    parent = assistant
  }
  const file = writeCommandCodeSession(home, { id: 'sess-1', cwd: pane.cwd, lines })

  const tail = await reader.chat(pane)
  expect(tail.items!.length).toBeGreaterThan(0)
  // The file is larger than one read window: the tail starts in the middle.
  expect(tail.start).toBeGreaterThan(0)
  expect(tail.items!.at(-1)?.text).toBe('Reply 99')

  const older = await reader.chat(pane, { before: tail.start })
  expect(older.items!.length).toBeGreaterThan(0)
  expect(Number(older.start)).toBeLessThan(Number(tail.start))

  // The first load has no `from`; the client's next poll sends the tail start,
  // whose token is the one that can then come back unchanged.
  const second = await reader.chat(pane, { since: tail.token, from: tail.start })
  const again = await reader.chat(pane, { since: second.token, from: second.start })
  expect(again).toMatchObject({ unchanged: true })

  appendFileSync(file, JSON.stringify(commandCodeAssistant('a-new', 'a99', [{ type: 'text', text: 'Appended' }], { ms: 5000 })) + '\n')
  const next = await reader.chat(pane, { since: second.token, from: second.start })
  expect(next.rewritten).toBeUndefined()
  expect(next.items?.at(-1)?.text).toBe('Appended')
})

it('searches user and assistant text with numeric offsets', async () => {
  const { home, reader } = fixture()
  writeCommandCodeSession(home, {
    id: 'sess-1', cwd: pane.cwd, lines: [
      commandCodeSession('sess-1', pane.cwd),
      commandCodeUser('u1', null, 'Where is the login form?', 1000),
      commandCodeAssistant('a1', 'u1', [{ type: 'text', text: 'It is in src/login.ts.' }], { ms: 2000 }),
      commandCodeUser('u2', 'a1', 'Unrelated question', 3000),
    ],
  })
  const hits = await reader.search(pane, 'login', Date.now() + 5000)
  // Newest first, as the search list shows them.
  expect(hits.hits.map(h => [h.role, h.text])).toEqual([
    ['assistant', 'It is in src/login.ts.'],
    ['user', 'Where is the login form?'],
  ])
  expect(hits.hits.every(h => typeof h.offset === 'number')).toBe(true)
})
