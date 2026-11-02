import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Writer-queue lifecycle: cancel, phase-cancel, direction reversal and TTL
// must all reach scroll chunks still waiting inside the stdin writer under
// real backpressure — only bytes that already entered the stream are past
// revocation.
const mocks = vi.hoisted(() => ({ cli: vi.fn(), spawn: vi.fn(), hold: vi.fn() }))
vi.mock('../server/utils/machines', () => ({
  machineOfPane: () => ({ key: 'remote', local: false, label: 'Remote', sock: () => 'test.sock', spawnHerdr: mocks.spawn }),
  runHerdrCli: mocks.cli,
}))
vi.mock('../server/utils/state', () => ({ termSessions: new Set(), getState: () => ({ machines: [{ key: 'remote', version: '0.9.5' }] }) }))
vi.mock('../server/utils/paneSizes', () => ({ createPaneSizes: () => ({ hold: () => mocks.hold() }) }))
import { openTerm } from '../server/utils/terminal'

// `gate`: a pending pane hold keeps the child unspawned — work sent by the
// client lands in the pre-start `early` queue instead of the writer.
async function relay(gate?: Promise<{ resized: () => void, release: () => void }>) {
  vi.useFakeTimers()
  // highWaterMark: 1 — the first write fills the kernel buffer at once.
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough({ highWaterMark: 1 }), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: 0, kill: vi.fn(),
  })
  mocks.spawn.mockReturnValue(child)
  mocks.cli.mockResolvedValue({ code: 0, stdout: Buffer.from('herdr 0.9.5') })
  mocks.hold.mockImplementation(() => gate ?? Promise.resolve({ resized: vi.fn(), release: vi.fn() }))
  const messages: Record<string, unknown>[] = []
  const session = openTerm({ send: s => messages.push(JSON.parse(s)), close: vi.fn(), isOpen: () => true }, new URL('http://example.test/ws/term?pane=w1:p1&cols=80&rows=24'))!
  await vi.advanceTimersByTimeAsync(5)
  return {
    session, messages,
    push: (value: object) => session.onMessage(JSON.stringify(value)),
    // Read whatever the stream is holding — simulates the child draining.
    drain: async () => {
      const commands: Record<string, unknown>[] = []
      let buffer = ''
      child.stdin.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        let at: number
        while ((at = buffer.indexOf('\n')) >= 0) { commands.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1) }
      })
      await vi.advanceTimersByTimeAsync(20)
      return commands
    },
    close: () => session.onClose(true),
  }
}
afterEach(() => vi.useRealTimers())
const scroll = { type: 'terminal.scroll', v: 2, id: 1, source: 'touch', epoch: 1, phase: 'momentum', preview: false, tui: true, direction: 'up', lines: 4, column: 5, row: 6 }

describe('writer queue obeys the scroll lifecycle', () => {
  it('a full cancel revokes scroll chunks still queued in the writer', async () => {
    const r = await relay()
    // The first tick enters the stream (hwm 1 blocks everything after).
    r.push(scroll)
    await vi.advanceTimersByTimeAsync(0)
    r.push({ type: 'touch.cancel' })
    const commands = await r.drain()
    const scrolls = commands.filter(c => c.type === 'terminal.scroll')
    // Only the one irrevocable, already-submitted tick — not the queued rest.
    expect(scrolls.length).toBeLessThanOrEqual(1)
    r.close()
  })

  it('a momentum phase-cancel revokes momentum queued behind blocked input', async () => {
    const r = await relay()
    r.push({ type: 'terminal.input', text: 'block' }) // fills the 1-byte buffer
    r.push(scroll)
    await vi.advanceTimersByTimeAsync(0)
    r.push({ type: 'touch.cancel', phase: 'momentum' })
    const commands = await r.drain()
    expect(commands.filter(c => c.type === 'terminal.scroll')).toHaveLength(0)
    expect(commands.some(c => c.type === 'terminal.input')).toBe(true)
    r.close()
  })

  it('a momentum chunk never survives its own TTL inside the writer', async () => {
    const r = await relay()
    r.push({ type: 'terminal.input', text: 'block' })
    r.push(scroll)
    await vi.advanceTimersByTimeAsync(0)
    // 240 ms momentum TTL, then drain: every queued tick is stale.
    await vi.advanceTimersByTimeAsync(300)
    const commands = await r.drain()
    expect(commands.filter(c => c.type === 'terminal.scroll')).toHaveLength(0)
    r.close()
  })

  it('a direction reversal drops opposite-direction ticks still in the writer', async () => {
    const r = await relay()
    r.push({ type: 'terminal.input', text: 'block' })
    r.push(scroll) // up
    r.push({ ...scroll, direction: 'down' })
    await vi.advanceTimersByTimeAsync(0)
    const commands = await r.drain()
    expect(commands.filter(c => c.type === 'terminal.scroll' && c.direction === 'up')).toHaveLength(0)
    r.close()
  })

  it('a full cancel revokes scrolls still waiting in the pre-start queue', async () => {
    const { promise: gate, resolve: open } = Promise.withResolvers<{ resized: () => void, release: () => void }>()
    const r = await relay(gate)
    // Child not yet spawned: the pacer's sends land in `early`.
    r.push(scroll)
    await vi.advanceTimersByTimeAsync(0)
    r.push({ type: 'touch.cancel' })
    open({ resized: vi.fn(), release: vi.fn() })
    await vi.advanceTimersByTimeAsync(5) // start() replays early
    const commands = await r.drain()
    expect(commands.filter(c => c.type === 'terminal.scroll')).toHaveLength(0)
    r.close()
  })

  it('a merged momentum batch never survives its own TTL inside the writer', async () => {
    const r = await relay()
    r.push({ type: 'terminal.input', text: 'block' })
    r.push({ ...scroll, tui: false })
    await vi.advanceTimersByTimeAsync(40) // merged flush queues in the writer
    await vi.advanceTimersByTimeAsync(300) // past the 240 ms momentum deadline
    const commands = await r.drain()
    expect(commands.filter(c => c.type === 'terminal.scroll')).toHaveLength(0)
    r.close()
  })

  it('a phase-cancel drops only the momentum share of a merged batch', async () => {
    const r = await relay()
    r.push({ type: 'terminal.input', text: 'block' })
    r.push({ ...scroll, tui: false, phase: 'drag', preview: true, lines: 2 })
    r.push({ ...scroll, tui: false, lines: 3 })
    await vi.advanceTimersByTimeAsync(40) // one flush, two phase-pure chunks
    r.push({ type: 'touch.cancel', phase: 'momentum' })
    const commands = await r.drain()
    const scrolls = commands.filter(c => c.type === 'terminal.scroll')
    expect(scrolls).toHaveLength(1)
    expect(scrolls[0]!.lines).toBe(2)
    r.close()
  })

  it('protected input keeps arriving however deep the queue gets', async () => {
    const r = await relay()
    r.push({ type: 'terminal.input', text: 'block' })
    r.push(scroll) // expendable work queues behind the blocked stream
    for (const text of ['a', 'b', 'c']) r.push({ type: 'terminal.input', text })
    await vi.advanceTimersByTimeAsync(0)
    const commands = await r.drain()
    const inputs = commands.filter(c => c.type === 'terminal.input').map(c => c.text)
    expect(inputs).toEqual(['block', 'a', 'b', 'c'])
    r.close()
  })

  it('the server advertises phased-scroll capability in web.capabilities', async () => {
    const r = await relay()
    expect(r.messages.some(m => m.type === 'web.capabilities' && m.scroll === 2)).toBe(true)
    r.close()
  })
})
