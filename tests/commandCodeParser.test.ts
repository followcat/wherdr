import { describe, expect, it } from 'vitest'
import { type CommandCodeResult, parseLines } from '../server/utils/transcripts'
import type { ChatItem } from '../shared/types'
import { AT, at, assistant, J, modelChange, results, sess, user } from './cmdParserFixture'

const parse = (text: string, map?: Map<string, CommandCodeResult>) => parseLines(text, 'cmd', 0, '', undefined, '', map)
const roles = (items: ChatItem[]) => items.map(i => i.role)

describe('parseLines for Command Code', () => {
  it('parses user string content and suppresses system and meta automation', () => {
    const items = parse(J(
      sess('s1'),
      user('u1', 'Fix the flaky checkout spec', 10),
      user('u2', 'Context snapshot injected by the scheduler', 20, { source: 'system' }),
      user('u3', 'Monitor wake-up: continue the goal', 30, { isMeta: true }),
      user('u4', '   ', 40),
      user('u5', 'Second question for alice', 50, { source: undefined }),
    ))
    expect(items).toEqual([
      { role: 'user', text: 'Fix the flaky checkout spec', ts: at(10) },
      { role: 'user', text: 'Second question for alice', ts: at(50) },
    ])
  })

  it('joins structured user text and keeps source=user human even when it resembles a tool result', () => {
    const items = parse(J(
      user('u1', [
        { type: 'text', text: 'Here is what the tool returned:' },
        { type: 'text', text: 'exit code 1, see line 40' },
      ], 10),
      // Automation source: not a human turn even with text.
      user('u2', [{ type: 'text', text: 'goal continuation' }], 20, { source: 'system' }),
      // A result-only structured turn is automation, not a user message.
      results('u3', [{ tool_use_id: 't-x', content: 'exit code 1' }], 30),
    ))
    expect(items).toEqual([{ role: 'user', text: 'Here is what the tool returned:\nexit code 1, see line 40', ts: at(10) }])
  })

  it('parses assistant string and structured content: text and thinking without signatures', () => {
    const items = parse(J(
      assistant('a1', 'Plain string reply from the model', 10),
      assistant('a2', [
        { type: 'thinking', thinking: 'The spec fails because the mock is stale', signature: 'sig-blob-must-not-leak' },
        { type: 'text', text: 'The mock date is off by a day.' },
        { type: 'text', text: '   ' },
      ], 20),
    ))
    expect(items).toEqual([
      { role: 'assistant', text: 'Plain string reply from the model', ts: at(10) },
      { role: 'thinking', text: 'The spec fails because the mock is stale', ts: at(20) },
      { role: 'assistant', text: 'The mock date is off by a day.', ts: at(20) },
    ])
    expect(JSON.stringify(items)).not.toContain('sig-blob')
  })

  it('summarizes each tool call shape and carries toolId', () => {
    const items = parse(J(assistant('a1', [
      { type: 'tool_use', id: 't1', name: 'shell_command', input: { description: 'Run the suite', command: 'npm test\n-- --reporter=dot' } },
      { type: 'tool_use', id: 't2', name: 'shell_command', input: { command: 'git status' } },
      { type: 'tool_use', id: 't3', name: 'read_file', input: { file_path: '/home/alice/acme-shop/src/cart.ts\n(mode: full)' } },
      { type: 'tool_use', id: 't4', name: 'write_file', input: { path: '/home/alice/acme-shop/out.txt' } },
      { type: 'tool_use', id: 't5', name: 'edit_file', input: { file_path: '/home/alice/acme-shop/src/pay.ts' } },
      { type: 'tool_use', id: 't6', name: 'grep', input: { pattern: 'checkout', path: '/home/alice/acme-shop/src' } },
      { type: 'tool_use', id: 't7', name: 'glob', input: { pattern: 'src/**/*.test.ts' } },
      { type: 'tool_use', id: 't8', name: 'agent', input: { prompt: 'Review the diff for regressions' } },
      { type: 'tool_use', id: 't9', name: 'ask_user_question', input: { questions: [{ question: 'Ship to staging first?' }] } },
      { type: 'tool_use', id: 't10', name: 'search_tools', input: { query: 'deployment' } },
      { type: 'tool_use', id: 't11', name: 'some_custom_tool', input: { command: 'deploy --target=staging', secret: 'must-not-show' } },
      { type: 'tool_use', id: 't12', name: 'object_only', input: { count: 3, flag: true } },
      { type: 'tool_use', id: 't13', input: 'ls -la /home/alice' },
      { type: 'tool_use', name: 'no_id_is_skipped', input: { x: 1 } },
    ], 10)))
    expect(items.map(i => [i.name, i.text])).toEqual([
      ['shell_command', 'Run the suite'],
      ['shell_command', 'git status'],
      ['read_file', '/home/alice/acme-shop/src/cart.ts'],
      ['write_file', '/home/alice/acme-shop/out.txt'],
      ['edit_file', '/home/alice/acme-shop/src/pay.ts'],
      ['grep', 'checkout · /home/alice/acme-shop/src'],
      ['glob', 'src/**/*.test.ts'],
      ['agent', 'Review the diff for regressions'],
      ['ask_user_question', 'Ship to staging first?'],
      ['search_tools', 'deployment'],
      ['some_custom_tool', 'deploy --target=staging'],
      ['object_only', ''],
      ['Tool', 'ls -la /home/alice'],
    ])
    expect(items[0]).toMatchObject({ role: 'tool', toolId: 't1', ts: at(10) })
    expect(JSON.stringify(items)).not.toContain('must-not-show')
  })

  it('attaches same-page tool results to their call: output and error', () => {
    const items = parse(J(
      assistant('a1', [{ type: 'tool_use', id: 't1', name: 'shell_command', input: { command: 'npm test' } }], 10),
      results('u1', [
        { tool_use_id: 't1', content: [{ type: 'text', text: '2 tests failed' }] },
        { tool_use_id: 't2', content: 'timed out', is_error: true },
      ], 20),
      assistant('a2', [{ type: 'tool_use', id: 't2', name: 'shell_command', input: { command: 'sleep 60' } }], 15),
    ))
    expect(items[0]).toMatchObject({ role: 'tool', toolId: 't1', out: '2 tests failed' })
    expect(items[0]!.error).toBeUndefined()
    // t2's call comes after its result in file order: no tools entry yet, but
    // no shared map either — the result is dropped for this parse.
    expect(items[1]).toMatchObject({ role: 'tool', toolId: 't2' })
    expect(items[1]!.out).toBeUndefined()
    expect(roles(items)).toEqual(['tool', 'tool'])
  })

  it('crosses pages through the shared result map and reports late updates', () => {
    const map = new Map<string, CommandCodeResult>()
    // Newer page first: the result's call lives in an older page.
    const newer = parse(J(results('u1', [{ tool_use_id: 't1', content: 'run ok' }])), map)
    expect(newer.length).toBe(0)
    expect(newer.updates).toEqual([{ id: 't1', out: 'run ok', error: false }])
    // Older page later: the call inherits the remembered outcome.
    const older = parse(J(assistant('a1', [{ type: 'tool_use', id: 't1', name: 'shell_command', input: { command: 'npm test' } }], 5)), map)
    expect(older[0]).toMatchObject({ role: 'tool', toolId: 't1', out: 'run ok' })
    // Served items are never mutated afterwards: a second result replaces
    // the remembered outcome whole and does not touch the parsed item.
    parse(J(results('u2', [{ tool_use_id: 't1', content: '', is_error: true }])), map)
    expect(map.get('t1')).toEqual({ error: true }) // out dropped, not preserved
    expect(older[0]).toMatchObject({ role: 'tool', toolId: 't1', out: 'run ok' })
    const last = parse(J(assistant('a2', [{ type: 'tool_use', id: 't1', name: 'shell_command', input: { command: 'npm test' } }], 5)), map)
    expect(last[0]).toMatchObject({ role: 'tool', toolId: 't1', error: true })
    expect(last[0]!.out).toBeUndefined()
  })

  it('a newer empty or successful result clears the earlier outcome', () => {
    // Same parse: an old error then an empty success clears out and error.
    const items = parse(J(
      assistant('a1', [{ type: 'tool_use', id: 't1', name: 'shell_command', input: { command: 'npm test' } }], 10),
      results('u1', [
        { tool_use_id: 't1', content: 'old output', is_error: true },
        { tool_use_id: 't1', content: '' },
      ], 20),
    ))
    expect(items[0]).toMatchObject({ role: 'tool', toolId: 't1' })
    expect(items[0]!.out).toBeUndefined()
    expect(items[0]!.error).toBeUndefined()

    // Shared map: the empty result replaces the remembered outcome whole and
    // the emitted update can clear out/error on a client page already shown.
    const map = new Map<string, CommandCodeResult>()
    parse(J(results('u2', [{ tool_use_id: 't2', content: 'kept' }])), map)
    expect(map.get('t2')).toEqual({ out: 'kept', error: false })
    const clearer = parse(J(results('u3', [{ tool_use_id: 't2', content: '' }])), map)
    expect(map.get('t2')).toEqual({ error: false })
    expect(clearer.updates).toEqual([{ id: 't2', out: '', error: false }])
    const older = parse(J(assistant('a2', [{ type: 'tool_use', id: 't2', name: 'shell_command', input: { command: 'x' } }], 5)), map)
    expect(older[0]!.out).toBeUndefined()
    expect(older[0]!.error).toBeUndefined()
  })

  it('filters non-user sources on string content like structured content', () => {
    const items = parse(J(
      user('u1', 'From the human', 10),
      user('u2', 'tool output text', 20, { source: 'tool' }),
      user('u3', 'model generated context', 30, { source: 'model' }),
      user('u4', 'scheduler injection', 40, { source: 'system' }),
      user('u5', 'exit code 0 — looks like a result but is typed text', 50),
      user('u6', 'automation text', 60, { isMeta: true }),
      user('u7', [{ type: 'text', text: 'meta wake-up' }], 70, { isMeta: true }),
      user('u8', [{ type: 'text', text: 'tool-sourced text' }], 80, { source: 'tool' }),
      user('u9', [{ type: 'text', text: 'human again' }], 90),
    ))
    expect(items).toEqual([
      { role: 'user', text: 'From the human', ts: at(10) },
      { role: 'user', text: 'exit code 0 — looks like a result but is typed text', ts: at(50) },
      { role: 'user', text: 'human again', ts: at(90) },
    ])
  })

  it('ignores malformed tool inputs instead of throwing or leaking objects', () => {
    const evil = { toString: 1, valueOf: 1 }
    const items = parse(J(assistant('a1', [
      { type: 'tool_use', id: 't1', name: 'shell_command', input: { description: evil, command: 'ls' } },
      { type: 'tool_use', id: 't2', name: 'read_file', input: { file_path: evil, path: evil } },
      { type: 'tool_use', id: 't3', name: 'grep', input: { pattern: evil, path: evil } },
      { type: 'tool_use', id: 't4', name: 'glob', input: { pattern: evil } },
      { type: 'tool_use', id: 't5', name: 'agent', input: { prompt: evil } },
      { type: 'tool_use', id: 't6', name: 'ask_user_question', input: { questions: [{ question: evil }] } },
      { type: 'tool_use', id: 't7', name: 'search_tools', input: { query: evil } },
      { type: 'tool_use', id: 't8', name: 'shell_command', input: { command: { nested: { deep: 'payload' } } } },
    ], 10)))
    expect(items.map(i => i.text)).toEqual(['ls', '', '', '', '', '', '', ''])
    expect(JSON.stringify(items)).not.toContain('[object Object]')
    expect(JSON.stringify(items)).not.toContain('payload')
  })

  it('rejects oversized tool ids on call and result, and clips displayed names', () => {
    const huge = 'i'.repeat(200)
    const wide = '\u754c'.repeat(43) // 129 bytes: the bound is on bytes, not chars
    const map = new Map<string, CommandCodeResult>()
    const items = parse(J(
      assistant('a1', [
        { type: 'tool_use', id: huge, name: 'shell_command', input: { command: 'x' } },
        { type: 'tool_use', id: wide, name: 'shell_command', input: { command: 'y' } },
        { type: 'tool_use', id: 'x'.repeat(128), name: 'shell_command', input: {} },
        { type: 'tool_use', id: 'ok-1', name: 'n'.repeat(400), input: {} },
      ], 10),
      results('u1', [
        { tool_use_id: huge, content: 'leak' },
        { tool_use_id: 'other-page', content: 'kept' },
      ], 20),
    ), map)
    // Oversized ids are rejected whole — never truncated into a false match.
    expect(items.map(i => i.toolId)).toEqual(['x'.repeat(128), 'ok-1'])
    expect(items[1]!.name!.length).toBeLessThanOrEqual(101)
    expect(map.has(huge)).toBe(false)
    expect(map.get('other-page')).toEqual({ out: 'kept', error: false })
  })

  it('bounds the result map and drops the oldest entry', () => {
    const map = new Map<string, CommandCodeResult>()
    const parts = Array.from({ length: 4100 }, (_, i) => ({ tool_use_id: `t${i}`, content: `out ${i}` }))
    parse(J(results('u1', parts)), map)
    expect(map.size).toBe(4096)
    expect(map.has('t0')).toBe(false)
    expect(map.has('t4099')).toBe(true)
  })

  it('ignores malformed, unknown and non-message records without throwing', () => {
    const items = parse(J(
      '{not json',
      '   ',
      null,
      { type: 'session', id: 's1' },
      modelChange(5),
      { type: 'message', id: 'b1', message: null },
      { type: 'message', id: 'b2', message: 'a string' },
      { type: 'message', id: 'b3', message: { role: 'system', content: [{ type: 'text', text: 'x' }] } },
      { type: 'message', id: 'b4', message: { role: 'user', content: 42 } },
      { type: 'message', id: 'b5', message: { role: 'user', content: { text: 'x' } } },
      { type: 'message', id: 'b6', message: { role: 'assistant', content: [{ type: 'server_tool_use', id: 'x' }, 'junk', null] } },
      user('u1', 'only this survives', 10),
    ))
    expect(items).toEqual([{ role: 'user', text: 'only this survives', ts: at(10) }])
  })

  it('falls back to meta.createdAt only inside the valid Date range', () => {
    const noTs = (id: string, text: string, createdAt: unknown) =>
      ({ type: 'message', id, message: { role: 'user', content: text, meta: { source: 'user', createdAt } } })
    expect(() => parse(J(noTs('u1', 'huge', 1e20), noTs('u2', 'neg', -1e20), noTs('u3', 'inf', Infinity)))).not.toThrow()
    const items = parse(J(
      noTs('u1', 'huge', 1e20),
      noTs('u2', 'ok', AT + 5),
      noTs('u3', 'inf', Infinity),
      noTs('u4', 'str', 'not a number'),
      noTs('u5', 'edge', 8.64e15),
    ))
    expect(items.map(i => [i.text, i.ts])).toEqual([
      ['huge', null],
      ['ok', new Date(AT + 5).toISOString()],
      ['inf', null],
      ['str', null],
      ['edge', new Date(8.64e15).toISOString()],
    ])
    // A real timestamp string always wins over meta.createdAt.
    expect(parse(J(user('u1', 'typed', 10)))[0]!.ts).toBe(at(10))
  })

  it('clips message text, tool summaries and result output', () => {
    const big = 'x'.repeat(20_500)
    const items = parse(J(
      user('u1', big, 10),
      assistant('a1', [
        { type: 'tool_use', id: 't1', name: 'shell_command', input: { command: 'y'.repeat(400) } },
        { type: 'text', text: big },
      ], 20),
      results('u2', [{ tool_use_id: 't1', content: 'z'.repeat(9000) }], 30),
    ))
    expect(items[0]!.text).toBe('x'.repeat(20_000) + '…')
    expect(items[1]!.text).toBe('y'.repeat(300) + '…')
    expect(items[2]!.text).toBe('x'.repeat(20_000) + '…')
    expect(items[1]!.out).toBe('z'.repeat(8000) + '…')
  })

  it('produces identical fresh items for the same bytes', () => {
    const text = J(
      sess('s1'),
      user('u1', 'Fix it', 10),
      assistant('a1', [{ type: 'text', text: 'Done, all tests pass.' }], 20),
    )
    const first = parse(text)
    const second = parse(text)
    // Same bytes → structurally identical replies; distinct object
    // identities mean a later parse can never mutate served items.
    expect(second).toEqual(first)
    expect(second[1]).not.toBe(first[1])
    const shifted = parseLines(text, 'cmd', 4096, '', undefined, '')
    expect(shifted).toEqual(first)
  })
})
