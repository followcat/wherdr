import { describe, expect, it, vi } from 'vitest'
import { createCodexDaemonHistory, codexDaemonReplyKey, codexHistoryItems } from '../server/utils/codexDaemon'
import type { CodexRpc } from '../server/utils/codexDaemonRpc'

const thread = { id: 'thread-a', name: 'A task', cwd: '/work/demo', historyMode: 'paginated', model: 'test-model' }
const pane = { id: 'w1:p1', agent: 'codex', cwd: '/work/demo', title: 'A task | demo' }
type Entry = Parameters<typeof codexHistoryItems>[0][number]
const entry = (i: number): Entry => ({ startedAtMs: 1000 + i, item: {
  id: `item-${i}`, type: i % 2 ? 'agentMessage' : 'userMessage', text: `reply ${i}`,
  content: [{ type: 'text', text: `question ${i}` }],
} })
function fixture({ matches = [thread], total = 150 } = {}) {
  const history = Array.from({ length: total }, (_, i) => entry(i))
  const rpc = vi.fn<CodexRpc>(async (method, params) => {
    if (method === 'thread/list') return { data: matches, nextCursor: null }
    if (method === 'thread/read') return { thread }
    if (method === 'thread/items/list') {
      const end = params.cursor == null ? history.length : Number(params.cursor)
      const start = Math.max(0, end - Number(params.limit))
      return { data: history.slice(start, end).reverse(), nextCursor: start ? String(start) : null }
    }
    throw new Error('Unexpected method')
  })
  return { adapter: createCodexDaemonHistory({ rpc }), rpc, append: (i: number) => history.push(entry(i)) }
}
describe('Codex daemon history', () => {
  it('limits the entire multi-page lookup to three seconds', async () => {
    vi.useFakeTimers()
    try {
      const rpc = vi.fn<CodexRpc>((_method, _params, signal) => new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal?.reason) }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort)
          resolve({ data: [thread], nextCursor: 'more' })
        }, 1000)
        signal?.addEventListener('abort', abort, { once: true })
      }))
      let finished = false
      const read = createCodexDaemonHistory({ rpc }).chat(pane).then(result => { finished = true; return result })
      await vi.advanceTimersByTimeAsync(3000)
      expect(finished).toBe(true)
      expect(await read).toBeNull()
      expect(rpc).toHaveBeenCalledTimes(3)
    } finally { vi.useRealTimers() }
  })
  it('keeps the daemon source and tail on transient failures, then recovers without a rewrite', async () => {
    const { adapter, rpc } = fixture()
    const first = (await adapter.chat(pane))!
    rpc.mockRejectedValueOnce(new Error('slow daemon'))
    const stale = (await adapter.chat({ ...pane, title: '⠋ A task | demo' }, { since: first.token, from: first.start }))!
    expect(stale).toMatchObject({ available: true, file: first.file, stale: true, unchanged: true })
    const recovered = (await adapter.chat(pane, { since: first.token, from: first.start }))!
    expect(recovered).toMatchObject({ file: first.file, unchanged: true })
    expect(recovered.rewritten).not.toBe(true)
    rpc.mockRejectedValueOnce(new Error('offline'))
    const reopened = (await adapter.chat({ ...pane, title: 'codex' }))!
    expect(reopened.items).toBe(first.items)
    expect(codexDaemonReplyKey(reopened.items!.at(-1)!)).toBe(codexDaemonReplyKey(first.items!.at(-1)!))
  })
  it('does not switch a pinned pane to another matching thread and releases it on an explicit session change', async () => {
    const { adapter, rpc } = fixture()
    const first = (await adapter.chat(pane))!
    rpc.mockImplementation(async () => { throw new Error('offline') })
    expect((await adapter.chat(pane, { before: first.start }))?.stale).toBe(true)
    expect(await adapter.chat({ ...pane, agentSession: 'another-thread' })).toBeNull()
  })
  it('releases a binding when Herdr reuses a pane id for a new pane', async () => {
    const { adapter, rpc } = fixture()
    await adapter.chat({ ...pane, bornAt: 1000 })
    rpc.mockRejectedValue(new Error('offline'))
    expect(await adapter.chat({ ...pane, bornAt: 2000 })).toBeNull()
  })
  it('resolves an exact unique name and cwd without comparing pane and thread creation times', async () => {
    const { adapter } = fixture({ total: 24 })
    const r = await adapter.chat(pane)
    expect(r?.session).toBe('thread-a')
    expect(r?.items).toHaveLength(24)
    expect(r?.start).toBe(0)
  })
  it('refuses duplicate titles, another cwd, generic titles, and subagents', async () => {
    for (const matches of [[thread, { ...thread, id: 'thread-b' }], [{ ...thread, cwd: '/other' }], [{ ...thread, parentThreadId: 'parent' }]]) {
      const { adapter, rpc } = fixture({ matches })
      expect(await adapter.chat(pane)).toBeNull()
      expect(rpc.mock.calls.some(([method]) => method === 'thread/items/list')).toBe(false)
    }
    expect(await fixture().adapter.chat({ ...pane, title: 'codex' })).toBeNull()
  })
  it('preserves letters and digits when comparing names and strips only controls', async () => {
    const { adapter } = fixture({ matches: [{ ...thread, name: 'task1' }, { ...thread, id: 'thread-b', name: 'task2' }] })
    expect((await adapter.chat({ ...pane, title: '\u0000task1 | demo\u007f' }))?.session).toBe('thread-a')
  })
  it('uses an explicit session ID even after the title changes', async () => {
    const { adapter, rpc } = fixture({ total: 2 })
    const r = await adapter.chat({ ...pane, agentSession: thread.id, title: 'Renamed' })
    expect(r?.session).toBe(thread.id)
    expect(r?.guessed).toBe(false)
    expect(rpc.mock.calls[0]?.[0]).toBe('thread/read')
  })
  it('formats model labels and leaves missing model metadata undefined', async () => {
    const rpc: CodexRpc = async method => method === 'thread/list'
      ? { data: [{ ...thread, model: 'gpt-6-sol' }] }
      : { data: [] }
    const adapter = createCodexDaemonHistory({ rpc })
    const first = (await adapter.chat(pane))!
    expect(first.model?.label).toBe('GPT-6-Sol')
    expect((await adapter.chat(pane, { since: first.token }))?.model).toEqual(first.model)
    const noModel: CodexRpc = async method => method === 'thread/list'
      ? { data: [{ ...thread, model: undefined }] }
      : { data: [] }
    expect((await createCodexDaemonHistory({ rpc: noModel }).chat(pane))?.model).toBeUndefined()
  })
  it('shares JSONL noise filtering and text clipping', () => {
    const text = 'x'.repeat(20001)
    const content = (text: string): Entry => ({ item: { id: 'item-a', type: 'userMessage', content: [{ type: 'text', text }] } })
    expect(codexHistoryItems([content('Caveat: local command output'), content('<system-reminder>hidden</system-reminder>')])).toEqual([])
    expect(codexHistoryItems([content(text)])[0]?.text).toBe('x'.repeat(20000) + '…')
  })
  it('keeps the tail anchor stable while new items arrive and pages older history separately', async () => {
    const { adapter, append } = fixture()
    const first = (await adapter.chat(pane))!
    expect(first.items).toHaveLength(100)
    expect(first.start).toBeGreaterThan(0)
    const older = (await adapter.chat(pane, { before: first.start }))!
    expect(older.older).toBe(true)
    expect(older.items).toHaveLength(50)
    expect(older.start).toBe(0)
    append(150)
    const next = (await adapter.chat(pane, { from: first.start, since: first.token }))!
    expect(next.start).toBe(first.start)
    expect(next.items).toHaveLength(101)
    expect(next.items![0]).toEqual(first.items![0])
    expect(next.items!.at(-1)?.text).toBe('question 150')
    expect((await adapter.chat(pane, { from: next.start, since: next.token }))?.unchanged).toBe(true)
  })
  it('requests a fresh tail for an expired cursor and rejects an already aborted read', async () => {
    const { adapter, rpc } = fixture()
    expect(await adapter.chat(pane, { before: 0 })).toMatchObject({ available: true, reload: true })
    rpc.mockClear()
    await expect(adapter.chat(pane, { signal: AbortSignal.abort() })).rejects.toThrow()
    expect(rpc).not.toHaveBeenCalled()
  })
  it('uses the legacy reader when there is no socket or the matched thread is not paginated', async () => {
    const { adapter } = fixture({ matches: [{ ...thread, historyMode: 'legacy' }] })
    expect(await adapter.chat(pane)).toBeNull()
    const missing = createCodexDaemonHistory({ rpc: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) } })
    expect(await missing.chat(pane)).toBeNull()
  })
  it('falls back on daemon errors with and without an explicit session', async () => {
    const adapter = createCodexDaemonHistory({ rpc: async () => { throw new Error('connection lost') } })
    expect(await adapter.chat(pane)).toBeNull()
    expect(await adapter.chat({ ...pane, agentSession: thread.id })).toBeNull()
  })
  it('falls back on unsupported items/list and explicit session cwd mismatches', async () => {
    for (const cwd of [pane.cwd, `${pane.cwd}/src`]) {
      const rpc = vi.fn<CodexRpc>(async method => {
        if (method === 'thread/read') return { thread }
        throw new Error('Unknown method: thread/items/list')
      })
      expect(await createCodexDaemonHistory({ rpc }).chat({ ...pane, cwd, agentSession: thread.id })).toBeNull()
    }
  })
  it('falls back for unmatched, unnamed, and status-prefixed titles', async () => {
    for (const title of ['Another task | demo', '', '⠋ A task | demo']) {
      expect(await fixture().adapter.chat({ ...pane, title })).toBeNull()
    }
  })
  it('does not swallow cancellation during daemon reads', async () => {
    const stop = new AbortController()
    const rpc: CodexRpc = async () => { stop.abort(new Error('cancelled')); throw stop.signal.reason }
    await expect(createCodexDaemonHistory({ rpc }).chat(pane, { signal: stop.signal })).rejects.toThrow('cancelled')
  })
  it('does not choose from an incomplete thread inventory', async () => {
    const rpc = vi.fn<CodexRpc>(async () => ({ data: Array.from({ length: 100 }, () => thread), nextCursor: 'more' }))
    expect(await createCodexDaemonHistory({ rpc }).chat(pane)).toBeNull()
    expect(rpc).toHaveBeenCalledTimes(10)
  })
})
