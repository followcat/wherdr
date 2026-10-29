import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HerdrError } from '../server/utils/herdr'

const text = readFileSync(new URL('./fixtures/claude-queued-turn.txt', import.meta.url), 'utf8')
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

async function endpoint(screen = text, pane = { agent: 'claude', status: 'working', stopped: false, leaving: false }) {
  const call = vi.fn(async () => ({ read: { text: screen } }))
  vi.useFakeTimers()
  for (const [name, value] of Object.entries({
    defineApi: (h: unknown) => h, PANE_RE: /^w1:p1$/, HerdrError,
    withPaneLock: async (_id: string, f: () => unknown) => f(),
    findPane: () => pane, herdr: call, poll: () => {},
  })) vi.stubGlobal(name, value)
  const { default: handler } = await import('../server/api/send-now.post')
  return { call, send: (id = 'w1:p1') => handler({}, { pane_id: id }) }
}

describe('send now', () => {
  it('re-reads the screen and sends exactly the native shortcut', async () => {
    const e = await endpoint()
    await expect(e.send()).resolves.toEqual({ ok: true })
    expect(e.call.mock.calls).toEqual([
      ['pane.read', { pane_id: 'w1:p1', source: 'detection' }, 4000],
      ['pane.send_input', { pane_id: 'w1:p1', keys: ['ctrl+enter'] }],
    ])
  })
  it('rejects stale screens and invalid panes without pressing a key', async () => {
    const e = await endpoint(text.replace('ctrl+enter to send now', ''))
    await expect(e.send()).rejects.toMatchObject({ code: 'stale' })
    expect(e.call).toHaveBeenCalledTimes(1)
    await expect(e.send('invalid')).rejects.toMatchObject({ code: 'bad_pane' })
    expect(e.call).toHaveBeenCalledTimes(1)
  })
  for (const change of [{ agent: 'codex' }, { agent: 'omp' }, { status: 'idle' }, { status: 'blocked' }, { stopped: true }, { leaving: true }]) {
    it(`rejects unsupported state ${JSON.stringify(change)}`, async () => {
      const e = await endpoint(text, { agent: 'claude', status: 'working', stopped: false, leaving: false, ...change })
      await expect(e.send()).rejects.toMatchObject({ code: 'stale' })
      expect(e.call).not.toHaveBeenCalled()
    })
  }
})
