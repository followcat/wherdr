import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ cli: vi.fn(), spawn: vi.fn(), pacer: vi.fn() }))
vi.mock('../server/utils/machines', () => ({
  machineOfPane: () => ({ key: 'remote', local: false, label: 'Remote', sock: () => 'test.sock', spawnHerdr: mocks.spawn }),
  runHerdrCli: mocks.cli,
}))
vi.mock('../server/utils/state', () => ({ termSessions: new Set(), getState: () => ({ machines: [{ key: 'remote', version: '0.9.5' }] }) }))
vi.mock('../server/utils/paneSizes', () => ({ createPaneSizes: () => ({ hold: async () => ({ resized: vi.fn(), release: vi.fn() }) }) }))
vi.mock('../server/utils/touchScrollPacer', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/utils/touchScrollPacer')>()
  return { createTouchScrollPacer: (...args: Parameters<typeof actual.createTouchScrollPacer>) => { mocks.pacer(); return actual.createTouchScrollPacer(...args) } }
})
import { openTerm } from '../server/utils/terminal'

async function relay() {
  vi.useFakeTimers()
  mocks.pacer.mockClear()
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: 0, kill: vi.fn(),
  })
  mocks.spawn.mockReturnValue(child)
  mocks.cli.mockResolvedValue({ code: 0, stdout: Buffer.from('herdr 0.9.5') })
  const commands: object[] = [], messages: Record<string, unknown>[] = []
  child.stdin.on('data', b => commands.push(JSON.parse(b.toString())))
  const session = openTerm({ send: s => messages.push(JSON.parse(s)), close: vi.fn(), isOpen: () => true }, new URL('http://example.test/ws/term?pane=w1:p1&cols=80&rows=24'))!
  await vi.advanceTimersByTimeAsync(0)
  return { session, commands, messages,
    push: (value: object) => session.onMessage(JSON.stringify(value)),
    frame: () => child.stdout.write(JSON.stringify({ type: 'terminal.frame', bytes: '', width: 80, height: 24 }) + '\n'),
    close: () => session.onClose(true),
  }
}
afterEach(() => vi.useRealTimers())
const scroll = { type: 'terminal.scroll', direction: 'up', lines: 8 }

describe('beta terminal relay', () => {
  it('leaves the default path unchanged on remote panes: no pacer, coordinates or acks', async () => {
    const r = await relay()
    r.push(scroll)
    await vi.advanceTimersByTimeAsync(200)
    r.frame()
    expect(r.commands).toEqual([scroll])
    expect(mocks.pacer).not.toHaveBeenCalled()
    expect(r.messages.some(m => m.type === 'scroll.ack')).toBe(false)
    r.close()
  })
  it('acks only commands preceding the frame, preserving each queued cell and epoch', async () => {
    const r = await relay()
    r.push({ ...scroll, source: 'touch', epoch: 4, column: 2, row: 3 })
    r.push({ ...scroll, lines: 1, source: 'touch', epoch: 5, column: 9, row: 10 })
    r.frame()
    expect(r.messages.filter(m => m.type === 'scroll.ack')).toEqual([{ type: 'scroll.ack', epoch: 4, phase: 'drag', lines: 4 }])
    await vi.advanceTimersByTimeAsync(16)
    r.frame()
    expect(r.commands.slice(0, 6)).toEqual(Array.from({ length: 6 }, () => ({ ...scroll, lines: 1, column: 2, row: 3, modifiers: 0 })))
    await vi.advanceTimersByTimeAsync(200)
    r.frame()
    expect(r.commands.at(-1)).toEqual({ ...scroll, lines: 1, column: 9, row: 10, modifiers: 0 })
    r.close()
  })
  it.each([{ type: 'touch.cancel' }, { type: 'paste', text: 'hello' }, { type: 'visibility', visible: false }, { type: 'terminal.resize', cols: 60, rows: 20 }])('cancels queued beta scroll on $type', async event => {
    const r = await relay()
    r.push({ ...scroll, lines: 80, source: 'touch' })
    r.push(event)
    const before = r.commands.length
    await vi.advanceTimersByTimeAsync(1000)
    r.frame()
    expect(r.commands).toHaveLength(before)
    r.close()
  })
  it('preserves real drag requests through a slow frame and expires momentum separately', async () => {
    const r = await relay()
    r.push({ ...scroll, lines: 20, source: 'touch', phase: 'drag' })
    await vi.advanceTimersByTimeAsync(100)
    r.push({ ...scroll, lines: 10, source: 'touch', phase: 'momentum', preview: false })
    await vi.advanceTimersByTimeAsync(300)
    for (let i = 0; i < 5; i++) { r.frame(); await vi.advanceTimersByTimeAsync(16) }
    expect(r.commands).toHaveLength(20)
    expect(r.commands.every(c => c.lines === 1)).toBe(true)
    r.close()
  })
  it('merges touch scrolls on non-TUI panes into lines:N and still acks the epoch', async () => {
    const r = await relay()
    r.push({ ...scroll, source: 'touch', epoch: 7, tui: false })
    await vi.advanceTimersByTimeAsync(50)
    r.frame()
    expect(r.commands).toEqual([scroll])
    expect(mocks.pacer).not.toHaveBeenCalled()
    expect(r.messages.filter(m => m.type === 'scroll.ack')).toEqual([{ type: 'scroll.ack', epoch: 7, phase: 'drag', lines: 8 }])
    r.close()
  })
  it('paces per-tick on TUI panes flagged live by the client', async () => {
    const r = await relay()
    r.push({ ...scroll, lines: 4, source: 'touch', epoch: 1, tui: true, column: 5, row: 6 })
    await vi.advanceTimersByTimeAsync(16)
    r.frame()
    expect(r.commands.length).toBeGreaterThanOrEqual(2)
    expect(r.commands.every(c => c.lines === 1)).toBe(true)
    r.close()
  })
  it('disposes the pacer when disabled and resumes the original wire contract', async () => {
    const r = await relay()
    r.push({ ...scroll, source: 'touch' })
    r.push({ type: 'touch.cancel', disabled: true })
    r.commands.length = 0
    r.push(scroll)
    await vi.advanceTimersByTimeAsync(500)
    r.frame()
    expect(r.commands).toEqual([scroll])
    expect(r.messages.some(m => m.type === 'scroll.ack')).toBe(false)
    r.push({ ...scroll, source: 'touch' })
    expect(mocks.pacer).toHaveBeenCalledTimes(2)
    r.close()
  })
  it('acknowledges delivered momentum after each frame and stops all timers on close', async () => {
    const r = await relay()
    r.push({ ...scroll, source: 'touch', phase: 'momentum', preview: false, epoch: 9 })
    expect(r.messages.some(m => m.type === 'scroll.ack')).toBe(false)
    r.frame()
    expect(r.messages.filter(m => m.type === 'scroll.ack')).toEqual([{ type: 'scroll.ack', epoch: 9, phase: 'momentum', lines: 4 }])
    await vi.advanceTimersByTimeAsync(16)
    r.frame()
    r.frame()
    expect(r.messages.filter(m => m.type === 'scroll.ack')).toEqual([
      { type: 'scroll.ack', epoch: 9, phase: 'momentum', lines: 4 },
      { type: 'scroll.ack', epoch: 9, phase: 'momentum', lines: 4 },
    ])
    r.push({ ...scroll, source: 'touch', phase: 'momentum', preview: false, epoch: 9 })
    r.close()
    const count = r.commands.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(r.commands).toHaveLength(count)
  })

  it('reports per-command stages to a v2 client and dedupes nothing', async () => {
    const r = await relay()
    // Without v:2 the connection stays on the legacy contract.
    r.push({ ...scroll, source: 'touch', epoch: 2 })
    await vi.advanceTimersByTimeAsync(200)
    expect(r.messages.some(m => m.type === 'scroll.cmd')).toBe(false)
    // With v:2 each submitted wheel tick gets submitted + flushed marks.
    // A frame first: the send window from the earlier push must reopen.
    r.frame()
    r.push({ ...scroll, v: 2, id: 41, lines: 2, source: 'touch', epoch: 3 })
    await vi.advanceTimersByTimeAsync(50)
    const cmds = r.messages.filter(m => m.type === 'scroll.cmd')
    const submitted = cmds.filter(c => c.stage === 'submitted')
    expect(submitted.length).toBeGreaterThanOrEqual(1)
    expect(submitted.every(c => c.id === 41 && c.epoch === 3 && c.phase === 'drag')).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    expect(r.messages.some(m => m.type === 'scroll.cmd' && m.stage === 'flushed')).toBe(true)
    r.close()
  })

  it('a momentum phase-cancel drops the expendable tail but keeps drag work', async () => {
    const r = await relay()
    // Momentum ticks with a short TTL queue behind; a phase cancel removes
    // exactly those without touching the pacer's other accounting.
    r.push({ ...scroll, v: 2, id: 1, lines: 30, source: 'touch', phase: 'momentum', preview: false, epoch: 5 })
    await vi.advanceTimersByTimeAsync(16)
    const before = r.commands.length
    r.push({ type: 'touch.cancel', phase: 'momentum' })
    await vi.advanceTimersByTimeAsync(200)
    r.frame()
    await vi.advanceTimersByTimeAsync(200)
    // No further momentum ticks leave the queue after the phase cancel.
    expect(r.commands.length).toBe(before)
    r.close()
  })

  it('a full touch.cancel still clears both phases and the delivery ledger', async () => {
    const r = await relay()
    r.push({ ...scroll, v: 2, id: 1, lines: 10, source: 'touch', epoch: 6 })
    r.push({ type: 'touch.cancel' })
    await vi.advanceTimersByTimeAsync(200)
    r.frame()
    expect(r.messages.some(m => m.type === 'scroll.ack')).toBe(false)
    r.close()
  })
})
