import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

// Count whole-line digests during a parse: every createHash call in the cmd
// image path is real work — a line-key sha256 plus one digest per image.
const cryptoCount = vi.hoisted(() => ({ n: 0 }))
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>()
  return {
    ...real,
    createHash: (...args: Parameters<typeof real.createHash>) => { cryptoCount.n++; return real.createHash(...args) },
  }
})
import { type CommandCodeResult, createTranscripts, extractImage, lineImageHashes, parseLines } from '../server/utils/transcripts'
import type { MachineFs } from '../server/utils/fsx'
import { lastModel, modelFromLine } from '../server/utils/models'
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
    expect(newer.updates).toEqual([{ id: 't1', out: 'run ok', error: false, images: 0, ref: '', imageAt: 0 }])
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
    expect(clearer.updates).toEqual([{ id: 't2', out: '', error: false, images: 0, ref: '', imageAt: 0 }])
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

describe('Command Code images', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const PNG2 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  // A real-shape JPEG: valid base64 commonly starts with '/9j/'.
  const JPEG = `/9j/4AAQSkZ${'QUFB'.repeat(16)}`
  const img = (data: string, media_type = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type, data } })
  const sha = (b64: string) => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex')

  it('keeps an assistant image on its text reply, including a JPEG whose base64 starts with /', () => {
    const items = parse(J(
      assistant('a1', [{ type: 'text', text: 'Here is the screenshot' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } }], 10),
      assistant('a2', [img(PNG)], 20),
    ))
    expect(items[0]).toMatchObject({ role: 'assistant', text: 'Here is the screenshot', images: 1, ts: at(10) })
    expect(items[0]!.ref).toBeTruthy()
    expect(items[0]!.hashes).toEqual([sha(JPEG)])
    expect(items[1]).toMatchObject({ role: 'assistant', text: '', images: 1, ts: at(20) })
    expect(items[1]!.hashes).toEqual([sha(PNG)])
  })

  it('groups all own assistant images on the last text reply in line order', () => {
    // An image before the first text and images between texts still belong,
    // as one ordered group, to the LAST text reply — each with its own bytes.
    const rec = assistant('a1', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG2 } },
      { type: 'text', text: 'first' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'text', text: 'second' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } },
    ], 10)
    const items = parse(J(rec))
    expect(items.map(i => [i.role, i.text, i.images ?? 0])).toEqual([
      ['assistant', 'first', 0],
      ['assistant', 'second', 3],
    ])
    expect(items[1]!.hashes).toEqual([sha(PNG2), sha(PNG), sha(JPEG)])
    const d = JSON.parse(J(rec))
    expect(extractImage(d, 0, 'cmd')).toEqual({ type: 'image/png', body: Buffer.from(PNG2, 'base64') })
    expect(extractImage(d, 1, 'cmd')).toEqual({ type: 'image/png', body: Buffer.from(PNG, 'base64') })
    expect(extractImage(d, 2, 'cmd')).toEqual({ type: 'image/jpeg', body: Buffer.from(JPEG, 'base64') })
  })

  it('makes one image reply of several image-only parts, in order', () => {
    const items = parse(J(assistant('a1', [img(PNG), img(JPEG), img(PNG2)], 10)))
    expect(items.length).toBe(1)
    expect(items[0]).toMatchObject({ role: 'assistant', text: '', images: 3, ref: expect.any(String), ts: at(10) })
    expect(items[0]!.hashes).toEqual([sha(PNG), sha(JPEG), sha(PNG2)])
  })

  it('orders images own-first then each tool result, even for an unmatched call', () => {
    const items = parse(J(
      assistant('a1', [
        { type: 'tool_use', id: 't1', name: 'read_file', input: { file_path: '/x/a.png' } },
        { type: 'tool_use', id: 't2', name: 'read_file', input: { file_path: '/x/b.png' } },
      ], 5),
      user('u1', [
        img(PNG2),
        { type: 'tool_result', tool_use_id: 't-gone', content: [img(PNG2)] },
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'found' }, img(PNG)] },
        { type: 'tool_result', tool_use_id: 't2', content: [img(PNG2)] },
      ], 10),
    ))
    const [t1, t2] = items as ChatItem[]
    expect(t1).toMatchObject({ toolId: 't1', out: 'found', images: 1, imageAt: 2 })
    expect(t1!.hashes).toEqual([sha(PNG)])
    expect(t2).toMatchObject({ toolId: 't2', images: 1, imageAt: 3 })
    expect(t2!.hashes).toEqual([sha(PNG2)])
    // The message's own image is a user item and counts before result images.
    expect(items[2]).toMatchObject({ role: 'user', text: '', images: 1 })
  })

  it('carries image ref/imageAt through the shared map and clears them on replacement', () => {
    const map = new Map<string, CommandCodeResult>()
    const newer = parse(J(user('u1', [
      { type: 'tool_result', tool_use_id: 't1', content: [img(PNG)] },
    ], 10)), map)
    expect(newer.updates).toEqual([{ id: 't1', out: '', error: false, images: 1, ref: expect.any(String), imageAt: 0 }])
    const older = parse(J(assistant('a1', [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }], 5)), map)
    expect(older[0]).toMatchObject({ toolId: 't1', images: 1, ref: expect.any(String) })
    expect(older[0]!.imageAt ?? 0).toBe(0)
    // A complete replacement result clears images/ref/imageAt, as out/error.
    const clearer = parse(J(user('u2', [{ type: 'tool_result', tool_use_id: 't1', content: 'just text' }], 20)), map)
    expect(map.get('t1')).toEqual({ out: 'just text', error: false })
    expect(clearer.updates).toEqual([{ id: 't1', out: 'just text', error: false, images: 0, ref: '', imageAt: 0 }])
    const last = parse(J(assistant('a2', [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }], 5)), map)
    expect(last[0]!.images).toBeUndefined()
    expect(last[0]!.ref).toBeUndefined()
    expect(last[0]!.imageAt).toBeUndefined()
  })

  it('ignores references and metadata images without shifting accepted indices', () => {
    const rec = user('u1', [
      { type: 'image', source: { type: 'file', path: '/home/alice/id_rsa' } },
      { type: 'image', data: 'blob:sha256:' + 'a'.repeat(64) },
      { type: 'image', data: 'https://example.com/shot.png' },
      { type: 'image', data: '/home/alice/shot.png' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
      { type: 'image', source: 'nope' },
      { type: 'input_image', image_url: { url: `data:image/png;base64,${PNG2}` } },
      { type: 'tool_result', tool_use_id: 't1', content: [img(PNG)] },
    ], 10)
    // attachment/payload metadata is not part of cmd messages: its images
    // must not shift the accepted tool-result image's index.
    const line = JSON.stringify({
      ...rec,
      attachment: { prompt: [img(PNG2)] },
      payload: { content: [img(PNG2)], output: [img(PNG2)] },
    })
    expect(lineImageHashes(line, 'cmd')).toEqual([sha(PNG)])
    const d = JSON.parse(line)
    expect(extractImage(d, 0, 'cmd')).toEqual({ type: 'image/png', body: Buffer.from(PNG, 'base64') })
    expect(extractImage(d, 1, 'cmd')).toBeNull()
    // Nothing of that line is a user turn either.
    expect(parse(line).length).toBe(0)
  })

  it('supports inline data URLs and keeps count, hash and bytes aligned over 50KiB', () => {
    const big = 'QUFB'.repeat(14000)
    const rec = user('u1', [{ type: 'text', text: 'look' }, { type: 'image', data: `data:image/png;base64,${big}` }], 10)
    const line = J(rec)
    expect(line.length).toBeGreaterThan(50000) // stripBlobs empties the payload
    const items = parse(line)
    expect(items[0]).toMatchObject({ role: 'user', text: 'look', images: 1 })
    expect(items[0]!.hashes).toEqual([sha(big)])
    expect(extractImage(JSON.parse(line), 0, 'cmd')).toEqual({ type: 'image/png', body: Buffer.from(big, 'base64') })
    // A valid JPEG data URL keeps its declared type on raw extraction.
    const jpegUrl = `data:image/jpeg;base64,${JPEG}`
    const jd = JSON.parse(J(user('u2', [{ type: 'image', data: jpegUrl }], 10)))
    expect(extractImage(jd, 0, 'cmd')).toEqual({ type: 'image/jpeg', body: Buffer.from(JPEG, 'base64') })
    // Spaced JSON: the compact `"type":"image"` precheck must not hide cmd images.
    const spaced = JSON.stringify(rec).replace(/"type":"/g, '"type" : "')
    expect(spaced).not.toContain('"type":"image"')
    expect(lineImageHashes(spaced, 'cmd')).toEqual([sha(big)])
  })

  it('keeps an invalid long image entry rejected after stripping', () => {
    // Over 50KiB: stripping must not turn a rejected payload into an
    // accepted empty image — count, hash and extraction stay aligned.
    for (const bad of [
      `data:image/png;not-base64,${'x'.repeat(55000)}`,
      `data:image/png;base64,${'!'.repeat(55000)}`,
    ]) {
      const rec = user('u1', [{ type: 'image', data: bad }, img(PNG)], 10)
      const line = J(rec)
      expect(line.length).toBeGreaterThan(50000)
      const items = parse(line)
      expect(items.length).toBe(1)
      expect(items[0]).toMatchObject({ role: 'user', text: '', images: 1, ref: expect.any(String), ts: at(10) })
      expect(items[0]!.hashes).toEqual([sha(PNG)])
      const d = JSON.parse(line)
      expect(extractImage(d, 0, 'cmd')).toEqual({ type: 'image/png', body: Buffer.from(PNG, 'base64') })
      expect(extractImage(d, 1, 'cmd')).toBeNull()
    }
  })

  it('hashes two long images differing only mid-payload as distinct', () => {
    // Equal line length, identical first/last 200 chars, difference only in
    // the middle: the legacy approximate cache key would collide; the exact
    // cmd key must not — and each hash matches its own decoded bytes.
    const pre = `QUFB${'QkJC'.repeat(60)}` // 244 base64 chars
    const suf = 'RERE'.repeat(60) // 240 base64 chars
    const a = `${pre}${'QUJD'.repeat(50)}${suf}`
    const b = `${pre}${'WFla'.repeat(50)}${suf}`
    const la = J(user('u1', [img(a)], 10))
    const lb = J(user('u1', [img(b)], 10))
    expect(la.length).toBe(lb.length)
    expect(la.slice(0, 200)).toBe(lb.slice(0, 200))
    expect(la.slice(-200)).toBe(lb.slice(-200))
    expect(`${la.length}:${la.slice(0, 200)}:${la.slice(-200)}`).toBe(`${lb.length}:${lb.slice(0, 200)}:${lb.slice(-200)}`)
    const ha = lineImageHashes(la, 'cmd')
    const hb = lineImageHashes(lb, 'cmd')
    expect(ha).toEqual([sha(a)])
    expect(hb).toEqual([sha(b)])
    expect(ha[0]).not.toBe(hb[0])
  })

  it('hashes an image line once per ref however many items share it', () => {
    cryptoCount.n = 0
    const items = parse(J(
      assistant('a1', [
        { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
        { type: 'tool_use', id: 't2', name: 'read_file', input: {} },
      ], 5),
      user('u1', [
        { type: 'tool_result', tool_use_id: 't1', content: [img(PNG)] },
        { type: 'tool_result', tool_use_id: 't2', content: [img(PNG2)] },
      ], 10),
    ))
    // One whole-line digest for the ref key plus one per accepted image —
    // without the per-ref memo each of the two items paid its own line hash.
    expect(cryptoCount.n).toBe(3)
    expect(items[0]!.hashes).toEqual([sha(PNG)])
    expect(items[1]!.hashes).toEqual([sha(PNG2)])
  })

  it('resolves null on malformed image records, through image() too', async () => {
    expect(extractImage(null, 0, 'cmd')).toBeNull()
    expect(extractImage(JSON.parse('42'), 0, 'cmd')).toBeNull()
    expect(extractImage(JSON.parse('[1]'), 0, 'cmd')).toBeNull()
    const file = '/home/alice/.commandcode/projects/x/s1.jsonl'
    const raw = 'null'
    const reads: [string, number, number][] = []
    const ENOENT = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const fs: MachineFs = {
      stat: async () => { throw ENOENT() },
      statMany: async () => [],
      readdir: async () => { throw ENOENT() },
      readFile: async () => { throw ENOENT() },
      read: async (p, s, l) => { reads.push([p, s, l]); return Buffer.from(raw).subarray(s, s + l) },
    }
    const t = createTranscripts({ home: '/h', herdr: (async () => { throw new Error('x') }) as never, fs, locateCommandCode: async () => ({ file, session: 's1' }) })
    expect(await t.image({ id: 'p1', agent: 'cmd', cwd: '/w' }, 's1.jsonl', `0:${raw.length}`, 0)).toBeNull()
    expect(reads).toEqual([[file, 0, raw.length]])
  })

  it('image() reads only the selected file — never a referenced path or blob store', async () => {
    const file = '/home/alice/.commandcode/projects/x/s1.jsonl'
    const rec = user('u1', [
      { type: 'image', data: 'blob:sha256:' + 'b'.repeat(64) },
      { type: 'image', data: 'file:///home/alice/.ssh/id_rsa' },
      img(PNG),
    ], 10)
    const raw = JSON.stringify(rec)
    const reads: [string, number, number][] = []
    const ENOENT = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    const fs: MachineFs = {
      stat: async () => { throw ENOENT() },
      statMany: async () => [],
      readdir: async () => { throw ENOENT() },
      readFile: async () => { throw ENOENT() },
      read: async (p, s, l) => { reads.push([p, s, l]); return Buffer.from(raw).subarray(s, s + l) },
    }
    const t = createTranscripts({ home: '/h', herdr: (async () => { throw new Error('x') }) as never, fs, locateCommandCode: async () => ({ file, session: 's1' }) })
    const got = await t.image({ id: 'p1', agent: 'cmd', cwd: '/w' }, 's1.jsonl', `0:${Buffer.byteLength(raw)}`, 0)
    expect(got).toEqual({ type: 'image/png', body: Buffer.from(PNG, 'base64') })
    // Exactly one read: the transcript line itself, nothing referenced by it.
    expect(reads).toEqual([[file, 0, Buffer.byteLength(raw)]])
  })
})

describe('Command Code model', () => {
  it('reads model_change and outer assistant model, most recent valid wins', () => {
    expect(modelFromLine(JSON.stringify(modelChange(5)), 'cmd')).toEqual({ id: 'example/model-a', label: 'example/model-a', at: at(5) })
    const a = JSON.stringify(assistant('a1', 'hi', 10))
    expect(modelFromLine(a, 'cmd')!.id).toBe('example/model-a')
    expect(modelFromLine(JSON.stringify(user('u1', 'q', 15)), 'cmd')).toBeNull()
    expect(modelFromLine(JSON.stringify(sess('s1')), 'cmd')).toBeNull()
    const lines = [
      JSON.stringify(modelChange(5)),
      JSON.stringify({ ...modelChange(20), model: 42 }),
      JSON.stringify({ type: 'model_change', id: 'x' }),
      JSON.stringify(assistant('a1', 'older', 10)),
      JSON.stringify({ ...assistant('a2', 'newer', 25), model: 'example/model-b' }),
      JSON.stringify({ type: 'model_change', model: 'example/model-c' }),
    ]
    expect(lastModel(lines, 'cmd')!.id).toBe('example/model-c')
    expect(lastModel(lines.slice(0, 4), 'cmd')!.id).toBe('example/model-a')
  })
})
