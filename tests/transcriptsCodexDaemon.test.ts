import { describe, expect, it, vi } from 'vitest'
import { createTranscripts } from '../server/utils/transcripts'
import { createCodexDaemonHistory } from '../server/utils/codexDaemon'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

describe('Codex shared-daemon conversation history', () => {
  it('still displays JSONL history when daemon lookup or history reads fail', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'codex-fallback-'))
    const date = new Date()
    const dir = path.join(home, '.codex/sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'))
    const thread = { id: 'thread-a', name: 'A task', cwd: '/work/demo', historyMode: 'paginated' }
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'rollout-test-thread-a.jsonl'), [
      { type: 'session_meta', payload: { id: thread.id, cwd: thread.cwd, timestamp: date.toISOString(), thread_source: 'user' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The existing JSONL reply.' }] } },
    ].map(line => JSON.stringify(line)).join('\n') + '\n')
    try {
      for (const scenario of ['missing', 'duplicate', 'status', 'explicit', 'cwd', 'unsupported', 'timeout']) {
        const daemon = createCodexDaemonHistory({ rpc: async method => {
          if (scenario === 'timeout' || scenario === 'explicit') throw new Error('Daemon read failed')
          if (method === 'thread/read') return { thread }
          if (method === 'thread/list') return { data: scenario === 'missing' ? [] : scenario === 'duplicate' ? [thread, { ...thread, id: 'thread-b' }] : [thread] }
          throw new Error('Unknown method: thread/items/list')
        } })
        const reader = createTranscripts({ home, herdr: vi.fn().mockResolvedValue({}), codexHistory: daemon })
        const reply = await reader.chat({
          id: 'w1:p1', agent: 'codex', cwd: scenario === 'cwd' ? '/work/demo/src' : thread.cwd,
          title: scenario === 'status' ? '⠋ A task | demo' : 'A task | demo',
          ...(['explicit', 'cwd', 'unsupported'].includes(scenario) ? { agentSession: thread.id } : {}),
        })
        expect(reply.available, scenario).toBe(true)
        expect(reply.items, scenario).toMatchObject([{ role: 'assistant', text: 'The existing JSONL reply.', ts: null }])
      }
      let offline = false
      const daemon = createCodexDaemonHistory({ rpc: async method => {
        if (offline) throw new Error('Temporary daemon failure')
        if (method === 'thread/read') return { thread }
        return { data: [{ item: { id: 'reply-a', type: 'agentMessage', text: 'The current daemon reply.' } }] }
      } })
      const reader = createTranscripts({ home, herdr: vi.fn().mockResolvedValue({}), codexHistory: daemon })
      const pane = { id: 'w2:p1', agent: 'codex', cwd: thread.cwd, agentSession: thread.id }
      const first = await reader.chat(pane)
      expect(first.items?.[0]?.text).toBe('The current daemon reply.')
      offline = true
      expect(await reader.chat(pane, { since: first.token, from: first.start })).toMatchObject({ file: first.file, stale: true, unchanged: true })
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
  it('reads paginated history without a JSONL file or inherited Herdr hook context', async () => {
    const daemon = {
      chat: vi.fn().mockResolvedValue({
        available: true, session: 'thread-a', file: 'codex-daemon-thread-a.jsonl',
        items: [{ role: 'assistant', text: 'The current daemon reply.', ts: null }], start: 0,
      }),
    }
    const reader = createTranscripts({
      home: '/home/user', herdr: vi.fn(), codexHistory: daemon,
      fs: { readdir: async () => [], statMany: async () => [] },
    } as unknown as Parameters<typeof createTranscripts>[0])
    const reply = await reader.chat({ id: 'w1:p1', agent: 'codex', cwd: '/work/demo', title: 'A task | demo' })
    expect(reply.available).toBe(true)
    expect(reply.session).toBe('thread-a')
    expect(reply.items).toEqual([{ role: 'assistant', text: 'The current daemon reply.', ts: null }])
  })
})
