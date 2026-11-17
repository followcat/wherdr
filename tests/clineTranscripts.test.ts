import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  clineToolResult, clineToolSummary, clineUserText, createClineTranscripts, parseCline, type ClineDoc,
} from '../server/utils/clineTranscripts'
import { createTranscripts } from '../server/utils/transcripts'
import { type MachineFs, localFs } from '../server/utils/fsx'
import {
  CLINE_ID, clineMessage, clineText, clineThinking, clineToolResult as result, clineToolUse, clineUser, writeClineFixture,
} from './helpers/cline-fixture.mjs'

const homes: string[] = []
function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'wherdr-cline-'))
  homes.push(home)
  return { home }
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

const pane = { id: 'p1', agent: 'cline', cwd: '/work/acme-shop', agentSession: CLINE_ID }
const docOf = (messages: unknown[]): ClineDoc =>
  ({ file: `${CLINE_ID}.messages.json`, session: CLINE_ID, updatedAt: null, messages: messages as Record<string, unknown>[] })

it('shows the user text inside Cline\'s <user_input> wrapper', () => {
  expect(clineUserText('<user_input mode="act">Fix the parser</user_input>')).toBe('Fix the parser')
  expect(clineUserText('<user_input mode="plan">Plan <b>this</b></user_input>')).toBe('Plan <b>this</b>')
  expect(clineUserText('A plain prompt')).toBe('A plain prompt')
  const items = parseCline(docOf([clineMessage('user', [clineUser('List the tools'), clineText('')])]))
  expect(items).toEqual([{ role: 'user', text: 'List the tools', ts: '2026-01-01T12:00:00.000Z', ref: 'm0:u' }])
})

it('renders thinking, replies and tool calls with their results', () => {
  const messages = [
    clineMessage('user', [clineUser('Run the tests')]),
    clineMessage('assistant', [clineThinking('Run them first'), clineText('Running the suite.'), clineToolUse('run_commands', { commands: ['npm test'] }, 'call-1')]),
    clineMessage('user', [result('call-1', 'run_commands', [{ query: 'npm test', result: '12 passed', success: true }])]),
    clineMessage('assistant', [clineText('All 12 tests pass.')]),
  ]
  const items = parseCline(docOf(messages), '/home/user')
  expect(items.map(i => [i.role, i.text, i.out, i.error])).toEqual([
    ['user', 'Run the tests', undefined, undefined],
    ['thinking', 'Run them first', undefined, undefined],
    ['assistant', 'Running the suite.', undefined, undefined],
    ['tool', 'npm test', '12 passed', undefined],
    ['assistant', 'All 12 tests pass.', undefined, undefined],
  ])
  expect(items.map(i => i.ref)).toEqual(['m0:u', 'm1:k0', 'm1:a1', 'm1:t2', 'm3:a0'])
})

it('summarizes each tool call from its best-known argument', () => {
  expect(clineToolSummary({ commands: ['ls -la'] })).toBe('ls -la')
  expect(clineToolSummary({ commands: ['cd a && b', 'ls'] })).toBe('cd a && b ; ls')
  expect(clineToolSummary({ files: [{ path: '/home/user/a.ts', start_line: 3, end_line: 9 }] }, '/home/user')).toBe('~/a.ts:3-9')
  expect(clineToolSummary({ path: '/home/user/b.ts', new_text: 'x' }, '/home/user')).toBe('~/b.ts')
  expect(clineToolSummary({ queries: ['retry', 'timeout'] })).toBe('retry ; timeout')
  expect(clineToolSummary({ requests: [{ url: 'https://example.com/a', prompt: 'read' }] })).toBe('https://example.com/a')
  expect(clineToolSummary({ query: 'date parser' })).toBe('date parser')
  expect(clineToolSummary({ question: 'Which database?' })).toBe('Which database?')
  expect(clineToolSummary({ skill: 'commit' })).toBe('commit')
  expect(clineToolSummary({ weird: 1 })).toBe('')
})

it('reads a string result, a JSON string and a per-item error', () => {
  expect(clineToolResult('plain output')).toEqual({ text: 'plain output', error: false })
  expect(clineToolResult('{"query":"edit:/x","result":"Edited /x","success":true}')).toEqual({ text: 'Edited /x', error: false })
  expect(clineToolResult([{ query: 'a', result: 'one', success: true }, { query: 'b', result: '', error: 'Command failed: timeout', success: false }]))
    .toEqual({ text: 'one\nCommand failed: timeout', error: true })
  expect(clineToolResult({ result: '', error: 'Error reading file: ENOENT' })).toEqual({ text: 'Error reading file: ENOENT', error: true })
})

it('marks a denied call and a call cancelled by a hook as failed', () => {
  const denied = JSON.stringify({ error: 'This tool call was rejected by the user and not executed. -- NOT a tool or system failure. Clarify with user before proceeding.' })
  const messages = [
    clineMessage('user', [clineUser('Run the shell command: ls')]),
    clineMessage('assistant', [clineToolUse('run_commands', { commands: ['ls'] }, 'call-1')]),
    clineMessage('user', [result('call-1', 'run_commands', denied, { is_error: true })]),
    clineMessage('assistant', [clineToolUse('run_commands', { commands: ['pwd'] }, 'call-2')], Date.parse('2026-01-01T12:00:30Z')),
    clineMessage('user', [clineUser('Never mind')], Date.parse('2026-01-01T12:00:40Z')),
    clineMessage('assistant', [clineText('Skipped it.')], Date.parse('2026-01-01T12:00:50Z')),
  ]
  const tools = parseCline(docOf(messages)).filter(i => i.role === 'tool')
  expect(tools).toHaveLength(2)
  expect(tools[0]).toMatchObject({ name: 'run_commands', text: 'ls', error: true, out: 'This tool call was rejected by the user and not executed. -- NOT a tool or system failure. Clarify with user before proceeding.' })
  expect(tools[1]).toMatchObject({ name: 'run_commands', text: 'pwd', error: true })
  expect(tools[1]!.out).toBeUndefined()
})

it('never reads or parses an unchanged file again', async () => {
  const { home } = fixture()
  const file = writeClineFixture(home, {
    messages: [clineMessage('user', [clineUser('First request')]), clineMessage('assistant', [clineText('First reply')])],
  })
  let bytes = 0
  const fs: MachineFs = {
    ...localFs,
    read: async (p, start, len, timeoutMs) => {
      const buf = await localFs.read(p, start, len, timeoutMs)
      if (p === file) bytes += buf.length
      return buf
    },
  }
  const reader = createClineTranscripts({ home, fs })
  const first = await reader.chat(pane, file)
  expect(first.items?.map(i => i.text)).toEqual(['First request', 'First reply'])
  expect(bytes).toBeGreaterThan(0)
  const read = bytes
  // The token names this file, size and generation: nothing is read again.
  const again = await reader.chat(pane, file, { since: first.token, from: first.start })
  expect(again.unchanged).toBe(true)
  expect(bytes).toBe(read)
  // A plain re-read (another device without a token) is served from the cache.
  expect((await reader.chat(pane, file)).items).toHaveLength(2)
  expect(bytes).toBe(read)
})

it('re-reads from the cursor after one new turn, and refuses a rewritten list above it', async () => {
  const { home } = fixture()
  const turn = (n: number, text = `Reply ${n}`) => [
    clineMessage('user', [clineUser(`Request ${n}`)], Date.parse('2026-01-01T12:00:00Z') + n * 2000),
    clineMessage('assistant', [clineText(text)], Date.parse('2026-01-01T12:00:00Z') + n * 2000 + 500),
  ]
  // Enough turns for the bottom to start above the first item: the cursor is
  // then an index whose anchor proves the list above it.
  const many = (n: number, text?: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => turn(i + 1, text?.(i + 1))).flat()
  const file = writeClineFixture(home, { messages: many(70) })
  const reader = createClineTranscripts({ home, fs: localFs })
  const first = await reader.chat(pane, file)
  expect(first.start).toBe(20)
  expect(first.items).toHaveLength(120)

  // One more turn: the bottom is re-read from the client's cursor, and the new
  // turn is what follows its list.
  writeClineFixture(home, { messages: many(70).concat(turn(71)) })
  const next = await reader.chat(pane, file, { since: first.token, from: first.start })
  expect(next.unchanged).toBeUndefined()
  expect(next.rewritten).toBeUndefined()
  expect(next.start).toBe(first.start)
  expect(next.items).toHaveLength(122)
  expect(next.items?.slice(120).map(i => i.text)).toEqual(['Request 71', 'Reply 71'])

  // A rewrite above the cursor (another conversation's items at the same
  // indices): the anchor refuses the splice and the client starts again.
  writeClineFixture(home, { messages: many(70, n => `Rewritten ${n}`).concat(turn(71)) })
  const other = await reader.chat(pane, file, { since: next.token, from: next.start })
  expect(other.rewritten).toBe(true)
  expect(other.start).toBe(22)
})

it('reports the model of the manifest and searches the conversation', async () => {
  const { home } = fixture()
  const file = writeClineFixture(home, {
    model: 'demo/demo-model-2',
    messages: [
      clineMessage('user', [clineUser('Review the date parser')]),
      clineMessage('assistant', [clineText('The date parser handles ISO dates.')]),
    ],
  })
  const reader = createClineTranscripts({ home, fs: localFs })
  expect(await reader.model(pane, file)).toMatchObject({ id: 'demo/demo-model-2', label: 'Demo model 2' })
  const hits = await reader.search(pane, file, 'date parser', Date.now() + 5000)
  expect(hits.kind).toBe('cline')
  expect(hits.hits.map(h => [h.role, h.offset])).toEqual([['assistant', 1], ['user', 0]])
})

it('finds the pane\'s session through core\'s process info', async () => {
  const { home } = fixture()
  const seen: string[] = []
  writeClineFixture(home, {
    pid: 101,
    messages: [clineMessage('user', [clineUser('List the files')]), clineMessage('assistant', [clineText('Two files.')])],
  })
  const herdr = async (method: string) => {
    seen.push(method)
    return {
      process_info: {
        foreground_processes: [
          // Core's foreground: `node …/bin/cline`; the engine `.cline` under it.
          { pid: 100, name: 'node', argv: ['/opt/nvm/bin/node', '/opt/nvm/bin/cline', '-i', 'List the files'], argvExact: true },
          { pid: 101, name: '.cline', argv: ['/opt/nvm/bin/node', '/opt/nvm/lib/node_modules/cline/bin/.cline', '-i', 'List the files'], argvExact: true },
        ],
      },
    }
  }
  const reader = createTranscripts({ home, herdr })
  const r = await reader.chat({ id: 'p1', agent: 'cline', cwd: '/work/acme-shop' })
  expect(r).toMatchObject({ available: true, session: CLINE_ID, file: `${CLINE_ID}.messages.json` })
  expect(r.items?.map(i => i.text)).toEqual(['List the files', 'Two files.'])
  expect(seen).toContain('pane.process_info')
  expect(await reader.model({ id: 'p1', agent: 'cline', cwd: '/work/acme-shop' })).toMatchObject({ id: 'demo/demo-model-1' })
})


