// Permission requests: what is requested, read from the transcript (tool call
// without a result) or from the screen. Entirely fictional content.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseChoices } from '../server/utils/choices'
import { isPermissionQuestion, lineStats, pendingClaudeTool, pendingCodexTool } from '../server/utils/promptDetail'
import { detailLine, diffKind } from '../app/utils/promptDetail'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const HOME = '/home/user'

const user = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
const toolUse = (id: string, name: string, input: object) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const toolResult = (id: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })

describe('Claude transcript: pending tool call', () => {
  it('Bash: full command and description', () => {
    const cmd = 'npm run build \\\n  && npm test -- --reporter dot'
    const d = pendingClaudeTool([
      user('Lance les tests'),
      toolUse('t1', 'Read', { file_path: `${HOME}/code/demo/package.json` }),
      toolResult('t1'),
      toolUse('t2', 'Bash', { command: cmd, description: 'Build then run the tests' }),
    ], HOME)!
    expect(d).toEqual({ tool: 'Bash', description: 'Build then run the tests', command: cmd })
  })

  it('Edit: file shortened with ~, summary and diff', () => {
    const d = pendingClaudeTool([
      user('Corrige le titre'),
      toolUse('t1', 'Edit', { file_path: `${HOME}/code/demo/app/title.ts`, old_string: 'const a = 1\nconst title = "Old"', new_string: 'const a = 1\nconst title = "New"\nexport default title' }),
    ], HOME)!
    expect(d.tool).toBe('Edit')
    expect(d.file).toBe('~/code/demo/app/title.ts')
    expect(d.added).toBe(2)
    expect(d.removed).toBe(1)
    expect(d.command).toContain('- const title = "Old"')
    expect(d.command).toContain('+ export default title')
    expect(d.command!.split('\n')[0]).toBe('  const a = 1')
  })

  it('MCP tool: server · tool and input as JSON', () => {
    const d = pendingClaudeTool([
      user('Crée le ticket'),
      toolUse('t1', 'mcp__tracker__create_issue', { title: 'Broken button', priority: 2 }),
    ])!
    expect(d.tool).toBe('tracker · create_issue')
    expect(JSON.parse(d.command!)).toEqual({ title: 'Broken button', priority: 2 })
  })

  it('nothing pending: tool finished, new message, question or subagent', () => {
    expect(pendingClaudeTool([toolUse('t1', 'Bash', { command: 'ls' }), toolResult('t1')])).toBeNull()
    expect(pendingClaudeTool([toolUse('t1', 'Bash', { command: 'ls' }), user('Autre chose')])).toBeNull()
    expect(pendingClaudeTool([toolUse('t1', 'AskUserQuestion', { questions: [] })])).toBeNull()
    expect(pendingClaudeTool([toolUse('t1', 'Task', { prompt: 'x' })])).toBeNull()
  })

  it('takes the first pending call of a parallel batch', () => {
    const d = pendingClaudeTool([
      toolUse('a', 'Bash', { command: 'echo one' }),
      toolUse('b', 'Bash', { command: 'echo two' }),
    ])!
    expect(d.command).toBe('echo one')
  })

  it('very long command: cut and flagged', () => {
    const d = pendingClaudeTool([toolUse('t1', 'Bash', { command: 'x'.repeat(30000) })])!
    expect(d.command!.length).toBe(20000)
    expect(d.truncated).toBe(true)
  })
})

describe('rollout Codex : appel en attente', () => {
  const item = (payload: object) => JSON.stringify({ type: 'response_item', payload })
  it('commande shell avec justification', () => {
    const d = pendingCodexTool([
      item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'installe' }] }),
      item({ type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm install'], justification: 'Needs network access' }) }),
    ])!
    expect(d).toEqual({ tool: 'shell', description: 'Needs network access', command: 'npm install' })
  })

  it('apply_patch : fichiers et lignes', () => {
    const patch = '*** Begin Patch\n*** Update File: app/demo.ts\n@@\n-old line\n+new line\n+another\n*** End Patch'
    const d = pendingCodexTool([item({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: patch })])!
    expect(d.file).toBe('app/demo.ts')
    expect(d.added).toBe(2)
    expect(d.removed).toBe(1)
  })

  it('call already executed: nothing', () => {
    expect(pendingCodexTool([
      item({ type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{"cmd":"ls"}' }),
      item({ type: 'function_call_output', call_id: 'c1', output: 'ok' }),
    ])).toBeNull()
  })
})

describe('screen: block above the question', () => {
  const rule = '─'.repeat(60)

  it('Claude, Bash : outil, commande, description', () => {
    const c = parseChoices([
      '● Bash(git push origin demo)',
      rule,
      ' Bash command',
      '',
      '   git push origin demo',
      '   Push the demo branch',
      '',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and don\'t ask again for git push commands',
      '   3. No, and tell Claude what to do differently (esc)',
    ].join('\n'))!
    expect(c.detail).toEqual({ tool: 'Bash command', description: 'Push the demo branch', command: 'git push origin demo' })
  })

  it('Claude, diff panel on the right: ignored', () => {
    const c = parseChoices(`${rule}\n${fx('claude-permission-diff.txt')}`, { strict: true })!
    expect(c.detail).toEqual({ tool: 'Bash command', description: 'Run the unit tests', command: 'npm test' })
  })

  it('Claude, Edit: file and diff summary', () => {
    const c = parseChoices([
      rule,
      ' Edit file',
      ' app/title.ts',
      '╌'.repeat(60),
      '  10   const a = 1',
      '  11 - const title = "Old"',
      '  11 + const title = "New"',
      '╌'.repeat(60),
      ' Do you want to make this edit to title.ts?',
      ' ❯ 1. Yes',
      '   2. Yes, allow all edits during this session (shift+tab)',
      '   3. No, and tell Claude what to do differently (esc)',
    ].join('\n'))!
    expect(c.detail!.tool).toBe('Edit file')
    expect(c.detail!.file).toBe('app/title.ts')
    expect(c.detail!.added).toBe(1)
    expect(c.detail!.removed).toBe(1)
  })

  it('Codex: reason and command between the question and the options', () => {
    const c = parseChoices([
      '  Would you like to run the following command?',
      '',
      '  Reason: Needs network access',
      '',
      '  $ curl -fsSL https://example.com/install.sh',
      '',
      '› 1. Yes, proceed (y)',
      '  2. Yes, and don\'t ask again for this command (p)',
      '  3. No, and tell Codex what to do differently (esc)',
    ].join('\n'))!
    expect(c.question).toBe('Would you like to run the following command?')
    expect(c.detail).toEqual({ tool: 'shell', description: 'Needs network access', command: 'curl -fsSL https://example.com/install.sh' })
  })

  it('no detail for an ordinary question or folder trust', () => {
    expect(parseChoices(fx('claude-ask.txt'))!.detail).toBeUndefined()
    expect(parseChoices(fx('claude-trust.txt'))!.detail).toBeUndefined()
    expect(parseChoices(fx('codex-trust.txt'), { strict: true })!.detail).toBeUndefined()
  })
})

describe('outils', () => {
  it('recognizes permission questions', () => {
    expect(isPermissionQuestion('Do you want to proceed?')).toBe(true)
    expect(isPermissionQuestion('Do you want to make this edit to a.ts?')).toBe(true)
    expect(isPermissionQuestion('Would you like to run the following command?')).toBe(true)
    expect(isPermissionQuestion('Quel fruit préfères-tu ?')).toBe(false)
    expect(isPermissionQuestion('Do you trust the files in this folder?')).toBe(false)
  })

  it('counts added and removed lines', () => {
    expect(lineStats('a\nb\nc', 'a\nB\nc\nd')).toEqual({ added: 2, removed: 1 })
  })

  it('one-line summary for the cards', () => {
    expect(detailLine({ tool: 'Bash', command: '\nnpm test\nnpm run lint' })).toBe('$ npm test')
    expect(detailLine({ tool: 'Bash', command: 'docker run --rm \\\n  -v x:/app \\\n  node:22' })).toBe('$ docker run --rm -v x:/app node:22')
    expect(detailLine({ tool: 'Edit', file: '~/code/app/a.ts', added: 3, removed: 1 })).toBe('a.ts  +3 −1')
    expect(detailLine({ tool: 'Read' })).toBe('Read')
    expect(diffKind('  12 + x', true)).toBe('add')
    expect(diffKind('- y', true)).toBe('del')
    expect(diffKind('- y', false)).toBeNull()
  })
})
