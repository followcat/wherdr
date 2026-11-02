import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { createTranscripts } from '../server/utils/transcripts'
import { parseOpenCode } from '../server/utils/opencodeTranscripts'
import { opencodeMessage, opencodeReply, opencodeState } from './helpers/opencode-fixture.mjs'
import type { ShellExec } from '../server/utils/fsx'

const cleanups: (() => Promise<void>)[] = []
const pane = { id: 'p1', agent: 'opencode', cwd: '/projects/demo', agentSession: 'ses_example' }
async function fixture() {
  const state = opencodeState()
  let clock = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  const exec: ShellExec = async (_script, args) => {
    const request = JSON.parse(args![2]!)
    state.requests.push({ method: 'GET', url: request.op })
    return { code: 0, stdout: Buffer.from(JSON.stringify(opencodeReply(state, request.session, request.op, request))), stderr: '' }
  }
  let current: ChildProcessWithoutNullStreams
  const stream = () => {
    const p = new EventEmitter() as ChildProcessWithoutNullStreams
    Object.assign(p, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { p.emit('close', 0); return true } })
    current = p; state.connections++; return p
  }
  const reader = createTranscripts({ home: '/home/user', exec, stream, herdr: async () => ({}) })
  cleanups.push(async () => { reader.dispose() })
  return { state, reader, tick: () => { clock += 1000 }, event: (reset = false) => current.stdout.emit('data', Buffer.from(JSON.stringify({ changed: true, reset }) + '\n')), ready: () => current.stdout.emit('data', Buffer.from('{"ready":true}\n')), disconnect: () => current.emit('close', 0) }
}
afterEach(async () => { for (const f of cleanups.splice(0)) await f(); vi.restoreAllMocks() })

it('reads the exact reported OpenCode session, never a nearby project or another session', async () => {
  const { state, reader } = await fixture()
  state.messages = [opencodeMessage(1, 'user', '中文 café request'), opencodeMessage(2, 'assistant', '**Current reply**')]
  const r = await reader.chat(pane)
  expect(r).toMatchObject({ available: true, session: 'ses_example', olderCursor: null })
  expect(r.items?.map(i => [i.role, i.text])).toEqual([['user', '中文 café request'], ['assistant', '**Current reply**']])
  expect(await reader.chat({ ...pane, agentSession: null })).toMatchObject({ available: false, reason: 'not_found' })
  expect(await reader.chat({ ...pane, agentSession: 'missing' })).toMatchObject({ available: false, reason: 'not_found' })
  expect(await reader.model(pane)).toMatchObject({ id: 'sample-model' })
  expect(state.requests.every(r => r.method === 'GET')).toBe(true)
  expect(JSON.stringify(r)).not.toContain('fixture-password')
})

it('paginates without gaps and keeps the same tail anchor when new replies arrive', async () => {
  const { state, reader, tick } = await fixture()
  state.messages = Array.from({ length: 300 }, (_, id) => opencodeMessage(id, id % 2 ? 'assistant' : 'user', `Message ${id}`))
  const tail = await reader.chat(pane)
  expect(tail.items).toHaveLength(120)
  const middle = await reader.chat(pane, { before: tail.olderCursor })
  const first = await reader.chat(pane, { before: middle.olderCursor })
  expect(first.olderCursor).toBeNull()
  expect([...first.items!, ...middle.items!, ...tail.items!].map(i => i.text)).toEqual(state.messages.map(m => m.type === 'user' ? m.text : m.content[0].text))
  expect(await reader.chat(pane, { since: tail.token, from: tail.start })).toMatchObject({ unchanged: true })
  state.messages.push(opencodeMessage(300, 'assistant', 'Appended reply')); tick()
  const next = await reader.chat(pane, { since: tail.token, from: tail.start })
  expect(next.start).toBe(tail.start)
  expect(next.rewritten).toBeUndefined()
  expect(next.items).toHaveLength(121)
  expect(next.items?.at(-1)?.text).toBe('Appended reply')
  expect(await reader.latestReply(pane)).toMatchObject({ text: 'Appended reply', key: expect.stringContaining('msg_00300') })
})

it('coalesces simultaneous history, preview and model reads', async () => {
  const { state, reader } = await fixture()
  state.messages = [opencodeMessage(1, 'assistant', 'Shared snapshot')]
  await Promise.all([reader.chat(pane), reader.preview(pane), reader.model(pane)])
  expect(state.requests.filter(r => r.url === 'session')).toHaveLength(1)
  expect(state.requests.filter(r => r.url === 'page')).toHaveLength(1)
  expect(state.connections).toBe(1)
})

it('resets old pages after revert, compaction, invalid cursors, or a service restart', async () => {
  const { state, reader, tick, event } = await fixture()
  state.messages = Array.from({ length: 150 }, (_, id) => opencodeMessage(id, 'assistant', `Reply ${id}`))
  const first = await reader.chat(pane)
  expect(await reader.chat(pane, { from: 'forged', since: first.token })).toMatchObject({ rewritten: true })
  expect(await reader.chat(pane, { before: 'forged' })).toMatchObject({ rewritten: true, items: [] })
  state.revert = { messageID: 'msg_00010' }; state.messages.splice(10); tick()
  expect(await reader.chat(pane, { from: first.start })).toMatchObject({ rewritten: true, items: expect.any(Array) })
  expect(await reader.chat(pane, { before: first.olderCursor })).toMatchObject({ rewritten: true, items: [] })
  const reverted = await reader.chat(pane)
  event(true)
  expect(await reader.chat(pane, { from: reverted.start })).toMatchObject({ rewritten: true })
  const compacted = await reader.chat(pane)
  state.pid++; tick()
  expect(await reader.chat(pane, { from: compacted.start })).toMatchObject({ rewritten: true })
})

it('invalidates on SSE updates, shares one stream and refetches after disconnect', async () => {
  const { state, reader, tick, event, ready, disconnect } = await fixture()
  state.messages = [opencodeMessage(1, 'assistant', 'Before')]
  const first = await reader.chat(pane)
  ready()
  await reader.model(pane); await reader.preview(pane)
  expect(state.connections).toBe(1)
  state.messages[0].content[0].text = 'After'; event()
  expect((await reader.chat(pane, { from: first.start })).items?.[0]?.text).toBe('After')
  disconnect(); tick()
  expect(await reader.chat(pane, { from: first.start })).toMatchObject({ rewritten: true })
  expect(state.connections).toBe(2)
})

it('keeps transient failures as errors, and never changes a failed read into a missing conversation', async () => {
  const { state, reader, tick } = await fixture()
  state.messages = [opencodeMessage(1, 'assistant', 'Saved reply')]
  await reader.chat(pane)
  state.fail = 503; tick()
  await expect(reader.chat(pane)).rejects.toThrow('Unable to read OpenCode session')
  state.fail = 0; tick()
  expect((await reader.chat(pane)).items?.[0]?.text).toBe('Saved reply')
})

it('projects reasoning and mutable tool states using stable references, without system context', () => {
  const m = opencodeMessage(1, 'assistant', '')
  m.content = [
    { type: 'reasoning', text: 'Public reasoning', providerState: { signature: 'PRIVATE_SIGNATURE' } },
    { type: 'tool', id: 'call-1', name: 'bash', state: { status: 'running', input: { command: 'npm test' } }, time: { created: 10 } },
    { type: 'text', text: 'Answer' },
  ]
  const before = parseOpenCode([{ id: 'system', type: 'system', text: 'PRIVATE_CONTEXT' }, m])
  expect(before.map(i => i.role)).toEqual(['thinking', 'tool', 'assistant'])
  expect(before[1]).toMatchObject({ ref: 'oc:msg_00001:tcall-1', toolStatus: 'running', text: 'npm test' })
  m.content[1].state = { status: 'error', input: { command: 'npm test' }, content: [{ type: 'text', text: 'One failure' }] }
  const after = parseOpenCode([m])
  expect(after[1]).toMatchObject({ ref: before[1].ref, out: 'One failure', error: true, toolStatus: 'error' })
  expect(JSON.stringify(after)).not.toMatch(/PRIVATE_/)
  m.content[1].state = { status: 'error', input: {}, error: { type: 'failed', message: 'Execution failed' } }
  expect(parseOpenCode([m])[1]).toMatchObject({ out: 'Execution failed', error: true })
})

it('searches older native pages with stable references and reports incomplete searches', async () => {
  const { state, reader } = await fixture()
  state.messages = Array.from({ length: 300 }, (_, id) => opencodeMessage(id, 'user', id === 0 ? 'Earliest café anchor' : `Message ${id}`))
  const result = await reader.search(pane, 'cafe anchor', Date.now() + 5000)
  expect(result).toMatchObject({ limited: false, kind: 'opencode', hits: [{ text: 'Earliest café anchor', offset: 'oc:msg_00000:u', ref: 'oc:msg_00000:u' }] })
  expect(await reader.search(pane, 'message', Date.now() + 5000)).toMatchObject({ limited: true })
  expect(await reader.search(pane, 'anchor', Date.now() - 1)).toMatchObject({ limited: true, hits: [] })
})

it('serves only a current session image and rejects stale files or arbitrary paths', async () => {
  const { state, reader } = await fixture()
  const m = opencodeMessage(1, 'user', 'Image')
  m.files = [{ mime: 'image/png', data: Buffer.from('fixture-image').toString('base64'), source: { type: 'inline' } }]
  state.messages = [m]
  const r = await reader.chat(pane)
  expect(r.items?.[0]?.images).toBe(1)
  expect(await reader.image(pane, r.file!, r.items![0]!.ref!, 0)).toEqual({ type: 'image/png', body: Buffer.from('fixture-image') })
  expect(await reader.image(pane, 'other-file', r.items![0]!.ref!, 0)).toBeNull()
  expect(await reader.image(pane, r.file!, '/etc/passwd', 0)).toBeNull()
  expect(await reader.image(pane, r.file!, r.items![0]!.ref!, -1)).toBeNull()
})

it('carries the session inbox as the queue — and omits it when the read fails', async () => {
  const { state, reader, tick } = await fixture()
  state.messages = [opencodeMessage(1, 'assistant', 'Working')]
  state.inbox = [{ id: 'msg_q1', type: 'user', payload: { text: 'queued one' }, time: { created: 1700000050000 } },
    { id: 'msg_q2', type: 'assistant', payload: {} },
    { id: 'msg_q3', type: 'user', payload: { text: 'queued two' } }]
  const r = await reader.chat(pane)
  expect(r.queue).toEqual([
    expect.objectContaining({ text: 'queued one' }),
    expect.objectContaining({ text: 'queued two' }),
  ])
  // A failed inbox read means unknown: no queue key at all, never "empty".
  state.inboxFail = true
  tick()
  const r2 = await reader.chat(pane)
  expect('queue' in r2).toBe(false)
})

it('reports session tokens and cost as the composer status', async () => {
  const { state, reader, tick } = await fixture()
  state.messages = [opencodeMessage(1, 'assistant', 'Working')]
  expect(await reader.opencodeStatus(pane)).toBeNull()
  state.tokens = { input: 448249, output: 58819, reasoning: 62856, cache: { read: 58993664, write: 1458 } }
  state.cost = 0
  tick()
  expect(await reader.opencodeStatus(pane)).toEqual({ line: '569.9k tok', meters: null })
  state.cost = 1.237
  tick()
  expect(await reader.opencodeStatus(pane)).toEqual({ line: '569.9k tok · $1.24', meters: null })
})
