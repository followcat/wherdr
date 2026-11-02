import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createTranscripts } from '../server/utils/transcripts'
import { localFs } from '../server/utils/fsx'
import {
  commandCodeAssistant, commandCodeModel, commandCodePNG, commandCodePNG2, commandCodeSession,
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
    session: 'sess-1',
    status: { contextTokens: 120, costUsd: 0.004 },
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
  expect(stats.status?.contextTokens).toBe(1000)
})

it('keeps a tool result when its call and result straddle read windows', async () => {
  const { home, reader } = fixture()
  const filler = 'y'.repeat(2.2 * 1024 * 1024)
  writeCommandCodeSession(home, {
    id: 'sess-1', cwd: pane.cwd, lines: [
      commandCodeSession('sess-1', pane.cwd),
      commandCodeUser('u1', null, 'Run it', 1000),
      commandCodeAssistant('a1', 'u1', [{ type: 'tool_use', id: 'call_1', name: 'shell_command', input: { command: 'echo ok' } }], { ms: 2000 }),
      commandCodeUser('filler', 'a1', filler, 3000),
      commandCodeToolResults('u2', 'a1', [{ tool_use_id: 'call_1', content: [{ type: 'text', text: 'ok' }] }], 4000),
    ],
  })
  const r = await reader.chat(pane)
  expect(r.items!.find(i => i.name === 'shell_command')?.out).toBe('ok')
})

it('keeps the last session when a header read fails', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-command-code-fail-'))
  homes.push(home)
  let fail = false
  const fs = {
    ...localFs,
    read: (file: string, start: number, len: number, timeout?: number) => {
      if (fail && file.endsWith('sess-new.jsonl') && start === 0 && len === 64 * 1024) {
        return Promise.reject(Object.assign(new Error('ssh read failed'), { code: 'remote' }))
      }
      return localFs.read(file, start, len, timeout)
    },
  }
  const reader = createTranscripts({ home, herdr: async () => ({}), fs })
  const write = (id: string, text: string, mtime: Date) => writeCommandCodeSession(home, {
    id, cwd: pane.cwd, lines: [commandCodeSession(id, pane.cwd), commandCodeUser(`${id}-u`, null, text)], mtime,
  })
  write('sess-old', 'Old conversation', new Date(1_700_000_000_000))
  write('sess-new', 'New conversation', new Date(1_700_000_100_000))

  expect((await reader.chat(pane))?.items?.[0]?.text).toBe('New conversation')
  fail = true
  vi.useFakeTimers()
  try {
    vi.setSystemTime(Date.now() + 9000)
    expect((await reader.chat(pane))?.items?.[0]?.text).toBe('New conversation')
  } finally {
    vi.useRealTimers()
  }
})

it('keeps an assistant image on its text reply', async () => {
  const { home, reader } = fixture()
  writeCommandCodeSession(home, {
    id: 'sess-1', cwd: pane.cwd, lines: [
      commandCodeSession('sess-1', pane.cwd),
      commandCodeUser('u1', null, 'Draw it', 1000),
      commandCodeAssistant('a1', 'u1', [
        { type: 'text', text: 'Here is the mock' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: commandCodePNG } },
      ], { ms: 2000 }),
    ],
  })
  const r = await reader.chat(pane)
  const replies = r.items!.filter(i => i.role === 'assistant')
  expect(replies).toHaveLength(1)
  expect(replies[0]).toMatchObject({ text: 'Here is the mock', images: 1 })
})

it('offsets images for a tool result whose call is outside the page', async () => {
  const { home, reader } = fixture()
  writeCommandCodeSession(home, {
    id: 'sess-1', cwd: pane.cwd, lines: [
      commandCodeSession('sess-1', pane.cwd),
      commandCodeUser('u1', null, 'Patch it', 1000),
      commandCodeAssistant('a1', 'u1', [{ type: 'tool_use', id: 'call_2', name: 'edit_file', input: { file_path: 'src/login.ts' } }], { ms: 2000 }),
      commandCodeToolResults('u2', 'a1', [
        { tool_use_id: 'call_missing', content: [{ type: 'text', text: 'gone' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: commandCodePNG2 } }] },
        { tool_use_id: 'call_2', content: [{ type: 'text', text: 'kept' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: commandCodePNG } }] },
      ], 3000),
    ],
  })
  const r = await reader.chat(pane)
  const tool = r.items!.find(i => i.name === 'edit_file')!
  expect(tool).toMatchObject({ out: 'kept', images: 1, imageAt: 1 })
  const img = await reader.image(pane, r.file!, tool.ref!, 1)
  expect(img?.body.equals(Buffer.from(commandCodePNG, 'base64'))).toBe(true)
})

it('does not rescan unchanged usage', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-command-code-cache-'))
  homes.push(home)
  let reads = 0
  const fs = {
    ...localFs,
    read: (file: string, start: number, len: number, timeout?: number) => {
      reads++
      return localFs.read(file, start, len, timeout)
    },
  }
  const reader = createTranscripts({ home, herdr: async () => ({}), fs })
  writeCommandCodeSession(home, {
    id: 'sess-1', cwd: pane.cwd, lines: [
      commandCodeSession('sess-1', pane.cwd),
      commandCodeUser('u1', null, 'Usage', 1000),
      commandCodeAssistant('a1', 'u1', [{ type: 'text', text: 'ok' }], { ms: 2000, usage: { inputTokens: 42, outputTokens: 1 } }),
    ],
  })
  const first = await reader.commandCodeStats(pane)
  expect(first.status?.contextTokens).toBe(42)
  const after = reads
  expect(await reader.commandCodeStats(pane)).toEqual(first)
  expect(reads).toBe(after)
})

it('caches session headers across discovery passes', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-command-code-headers-'))
  homes.push(home)
  const root = path.join(home, '.commandcode/projects')
  const dir = path.join(root, 'history')
  const files = new Map(Array.from({ length: 100 }, (_, i) => [path.join(dir, `s${i}.jsonl`), Buffer.from(JSON.stringify({ type: 'session', version: 3, id: `s${i}`, cwd: `/home/user/other${i}` }))]))
  let reads = 0
  const fs = {
    ...localFs,
    readdir: async (p: string) => p === root ? ['history'] : [...files.keys()].map(f => path.basename(f)),
    statMany: async (ps: string[]) => ps.map(p => ({ size: files.get(p)!.length, mtimeMs: 1_700_000_000_000, isFile: true, isDir: false })),
    read: async (p: string, start: number, len: number) => {
      reads++
      return files.get(p)!.subarray(start, start + len)
    },
  }
  const reader = createTranscripts({ home, herdr: async () => ({}), fs })
  const p = { id: 'p-headers', agent: 'cmd', cwd: '/home/user/new-project' }
  vi.useFakeTimers()
  try {
    expect(await reader.locate(p)).toBeNull()
    expect(reads).toBe(100)
    reads = 0
    vi.setSystemTime(Date.now() + 9000)
    expect(await reader.locate(p)).toBeNull()
    expect(reads).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('enumerates remote projects with one find', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-command-code-remote-'))
  homes.push(home)
  const root = path.join(home, '.commandcode/projects')
  const file = path.join(root, 'project', 'sess.jsonl')
  const buf = Buffer.from(JSON.stringify({ type: 'session', version: 3, id: 'sess', cwd: '/home/user/acme' }) + '\n')
  let finds = 0
  const exec = async (script: string) => {
    if (script.startsWith('find')) finds++
    return { code: 0, stdout: Buffer.from(`${file}\n`), stderr: '' }
  }
  const fs = {
    ...localFs,
    statMany: async (ps: string[]) => ps.map(() => ({ size: buf.length, mtimeMs: 1_700_000_000_000, isFile: true, isDir: false })),
    read: async (_p: string, start: number, len: number) => buf.subarray(start, start + len),
  }
  const reader = createTranscripts({ home, fs, exec, herdr: async () => ({}) })
  expect(await reader.locate({ id: 'remote', agent: 'cmd', cwd: '/home/user/acme' })).toMatchObject({ session: 'sess' })
  expect(finds).toBe(1)
})

it('reports a new session even before its first usage', async () => {
  const { home, reader } = fixture()
  const write = (id: string, lines: unknown[], mtime: Date) => writeCommandCodeSession(home, { id, cwd: pane.cwd, lines, mtime })
  write('sess-old', [
    commandCodeSession('sess-old', pane.cwd),
    commandCodeUser('u1', null, 'Old', 1000),
    commandCodeAssistant('a1', 'u1', [{ type: 'text', text: 'old reply' }], { ms: 2000, usage: { inputTokens: 10, outputTokens: 1 } }),
  ], new Date(1_700_000_000_000))
  write('sess-new', [commandCodeSession('sess-new', pane.cwd), commandCodeUser('u2', null, 'New question', 3000)], new Date(1_700_000_100_000))
  expect(await reader.commandCodeStats(pane)).toMatchObject({ session: 'sess-new', status: null })
})

it('keeps a tool result across a pagination boundary', async () => {
  const { home, reader } = fixture()
  const lines = [
    commandCodeSession('sess-1', pane.cwd),
    commandCodeUser('u1', null, 'Run it', 1000),
    commandCodeAssistant('a1', 'u1', [{ type: 'tool_use', id: 'call_1', name: 'shell_command', input: { command: 'echo ok' } }], { ms: 2000 }),
  ]
  const filler = 'z'.repeat(32 * 1024)
  for (let i = 0; i < 200; i++) lines.push(commandCodeUser(`filler-${i}`, 'a1', filler, 3000 + i))
  // A 10 KiB unmatched result pushes call_1's id beyond a 4 KiB prefix: the
  // append validation must fingerprint the whole result record.
  lines.push(commandCodeToolResults('u2', 'a1', [
    { tool_use_id: 'call_missing', content: [{ type: 'text', text: 'p'.repeat(10 * 1024) }] },
    { tool_use_id: 'call_1', content: [{ type: 'text', text: 'ok' }] },
  ], 4000))
  const file = writeCommandCodeSession(home, { id: 'sess-1', cwd: pane.cwd, lines })
  const tail = await reader.chat(pane)
  expect(tail.start).toBeGreaterThan(0)
  appendFileSync(file, JSON.stringify(commandCodeAssistant('a-new', 'a1', [{ type: 'text', text: 'new' }], { ms: 5000 })) + '\n')
  await reader.chat(pane, { since: tail.token, from: tail.start })
  const older = await reader.chat(pane, { before: tail.start })
  expect(older.items!.find(i => i.name === 'shell_command')?.out).toBe('ok')
  // Forgetting the pane must not let the remembered result resurrect.
  reader.forget(pane.id)
  const afterForget = await reader.chat(pane, { before: tail.start })
  expect(afterForget.items!.find(i => i.name === 'shell_command')?.out).toBeUndefined()
  // A fresh tail re-read after forget must remember the result again.
  const reopenedTail = await reader.chat(pane)
  const reopenedOlder = await reader.chat(pane, { before: reopenedTail.start })
  expect(reopenedOlder.items!.find(i => i.name === 'shell_command')?.out).toBe('ok')

  // Replacing the file (new inode) with a larger transcript without that
  // result must invalidate the remembered entry too.
  const replacement = [
    commandCodeSession('sess-1', pane.cwd),
    commandCodeUser('u1', null, 'Run it', 1000),
    commandCodeAssistant('a1', 'u1', [{ type: 'tool_use', id: 'call_1', name: 'shell_command', input: { command: 'echo ok' } }], { ms: 2000 }),
  ]
  for (let i = 0; i < 250; i++) replacement.push(commandCodeUser(`replacement-${i}`, 'a1', filler, 5000 + i))
  const fresh = `${file}.replacement`
  writeFileSync(fresh, replacement.map(line => JSON.stringify(line)).join('\n') + '\n')
  renameSync(fresh, file)
  const tail2 = await reader.chat(pane)
  expect(tail2.start).toBeGreaterThan(0)
  const older2 = await reader.chat(pane, { before: tail2.start })
  expect(older2.items!.find(i => i.name === 'shell_command')?.out).toBeUndefined()
})

it('invalidates remembered results when a larger file is rewritten in place', async () => {
  const { home, reader } = fixture()
  const filler = 'w'.repeat(32 * 1024)
  const lines = [
    commandCodeSession('sess-1', pane.cwd),
    commandCodeUser('u1', null, 'Run it', 1000),
    commandCodeAssistant('a1', 'u1', [{ type: 'tool_use', id: 'call_1', name: 'shell_command', input: { command: 'echo ok' } }], { ms: 2000 }),
  ]
  for (let i = 0; i < 200; i++) lines.push(commandCodeUser(`filler-${i}`, 'a1', filler, 3000 + i))
  lines.push(commandCodeToolResults('u2', 'a1', [{ tool_use_id: 'call_1', content: [{ type: 'text', text: 'ok' }] }], 4000))
  const file = writeCommandCodeSession(home, { id: 'sess-1', cwd: pane.cwd, lines })
  const tail = await reader.chat(pane)
  expect(tail.start).toBeGreaterThan(0)

  const replacement = lines.slice(0, 3)
  for (let i = 0; i < 250; i++) replacement.push(commandCodeUser(`rewritten-${i}`, 'a1', filler, 5000 + i))
  writeFileSync(file, replacement.map(line => JSON.stringify(line)).join('\n') + '\n')
  const tail2 = await reader.chat(pane)
  expect(tail2.start).toBeGreaterThan(0)
  const older2 = await reader.chat(pane, { before: tail2.start })
  expect(older2.items!.find(i => i.name === 'shell_command')?.out).toBeUndefined()
})

it('reads past trailing tool results with no displayable message', async () => {
  const { home, reader } = fixture()
  const big = 'q'.repeat(1.5 * 1024 * 1024)
  const calls = [1, 2, 3, 4].map(i => ({ type: 'tool_use', id: `call_${i}`, name: 'read_file', input: { file_path: `shot-${i}.png` } }))
  const results = [1, 2, 3, 4].map(i => commandCodeToolResults(`u${i}`, 'a1', [{ tool_use_id: `call_${i}`, content: [{ type: 'text', text: big }] }], 2000 + i))
  writeCommandCodeSession(home, {
    id: 'sess-1', cwd: pane.cwd, lines: [
      commandCodeSession('sess-1', pane.cwd),
      commandCodeUser('u0', null, 'Take screenshots', 1000),
      commandCodeAssistant('a1', 'u0', [{ type: 'text', text: 'Old reply' }, ...calls], { ms: 2000 }),
      ...results,
    ],
  })
  const r = await reader.chat(pane)
  expect(r.items!.some(i => i.text === 'Old reply')).toBe(true)
  const out = r.items!.find(i => i.name === 'read_file')?.out
  expect(out?.length).toBe(8001)
  expect(out?.startsWith('qqqq')).toBe(true)
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
  for (let i = 0; i < 200; i++) {
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
  expect(tail.items!.at(-1)?.text).toBe('Reply 199')

  const older = await reader.chat(pane, { before: tail.start })
  expect(older.items!.length).toBeGreaterThan(0)
  expect(Number(older.start)).toBeLessThan(Number(tail.start))

  // The first load has no `from`; the client's next poll sends the tail start,
  // whose token is the one that can then come back unchanged.
  const second = await reader.chat(pane, { since: tail.token, from: tail.start })
  const again = await reader.chat(pane, { since: second.token, from: second.start })
  expect(again).toMatchObject({ unchanged: true })

  appendFileSync(file, JSON.stringify(commandCodeAssistant('a-new', 'a199', [{ type: 'text', text: 'Appended' }], { ms: 5000 })) + '\n')
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
