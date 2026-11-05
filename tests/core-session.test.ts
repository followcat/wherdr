import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { CoreSession } from '../server/utils/coreSession'
import { applyCoreEvent, type CoreTerminals } from '../shared/coreEvents'
import { createCoreAlerts } from '../server/utils/coreAlerts'
import type { CoreTerminal } from '../shared/coreInventory'

class FakeSocket extends EventEmitter {
  written: string[] = []
  destroyed = false
  write(s: string) { this.written.push(s); return true }
  destroy() { this.destroyed = true; return this }
  feed(...lines: object[]) { this.emit('data', Buffer.from(lines.map(l => JSON.stringify(l) + '\n').join(''))) }
}
const term = (address: string, extra: Partial<CoreTerminal> = {}): CoreTerminal => ({ address, cwd: '/w', state: 'live', ...extra })
const ev = (seq: number, type: string, terminal: string, data: object = {}) => ({ jsonrpc: '2.0', method: 'event', params: { seq, type, terminal, data } })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function open(opts: { watchdogMs?: number } = {}) {
  const sockets: FakeSocket[] = []
  const log: string[] = []
  const onEvent = vi.fn()
  const session = new CoreSession({ endpoint: 'x', ...opts, onEvent, onChange: w => log.push(w), onStatus: c => log.push(c ? 'up' : 'down'),
    connect: () => { const s = new FakeSocket(); sockets.push(s); queueMicrotask(() => s.emit('connect')); return s as unknown as Socket } })
  session.start()
  return { session, sockets, log, onEvent }
}

it('subscribes, holds the snapshot and applies events in order', async () => {
  const { session, sockets, onEvent } = open()
  await Promise.resolve()
  expect(JSON.parse(sockets[0]!.written[0]!)).toMatchObject({ method: 'events.subscribe' })
  expect(session.snapshot()).toBeNull()
  sockets[0]!.feed({ jsonrpc: '2.0', id: 1, result: { seq: 5, terminals: [term('t1')] } })
  expect(session.snapshot()?.map(t => t.address)).toEqual(['t1'])
  sockets[0]!.feed(ev(6, 'status', 't1', { status: { state: 'working' } }), { jsonrpc: '2.0', method: 'event', params: { type: 'heartbeat' } })
  expect(session.get('t1')?.status?.state).toBe('working')
  expect(onEvent).toHaveBeenCalledTimes(1)
  session.stop()
})

it('buffers events that arrive before the snapshot and skips those it already holds', async () => {
  const { session, sockets } = open()
  await Promise.resolve()
  sockets[0]!.feed(ev(4, 'title', 't1', { title: 'old' }), ev(6, 'title', 't1', { title: 'new' }))
  sockets[0]!.feed({ jsonrpc: '2.0', id: 1, result: { seq: 5, terminals: [term('t1')] } })
  expect(session.get('t1')?.title).toBe('new')
  session.stop()
})

it('handles frames split anywhere', async () => {
  const { session, sockets } = open()
  await Promise.resolve()
  const text = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { seq: 1, terminals: [term('t1')] } }) + '\n'
  sockets[0]!.emit('data', Buffer.from(text.slice(0, 20)))
  expect(session.snapshot()).toBeNull()
  sockets[0]!.emit('data', Buffer.from(text.slice(20)))
  expect(session.snapshot()).toHaveLength(1)
  session.stop()
})

it('reconnects with a new snapshot on a seq gap, on missed, and on silence', async () => {
  const { session, sockets, log } = open({ watchdogMs: 1000 })
  await Promise.resolve()
  sockets[0]!.feed({ jsonrpc: '2.0', id: 1, result: { seq: 1, terminals: [term('t1')] } })
  sockets[0]!.feed(ev(3, 'title', 't1', { title: 'gap' }))
  expect(sockets[0]!.destroyed).toBe(true)
  expect(session.snapshot()).toBeNull()
  await vi.advanceTimersByTimeAsync(250)
  expect(sockets).toHaveLength(2)
  sockets[1]!.feed({ jsonrpc: '2.0', id: 1, result: { seq: 9, terminals: [term('t1')] } })
  sockets[1]!.feed({ jsonrpc: '2.0', method: 'event', params: { type: 'missed' } })
  expect(sockets[1]!.destroyed).toBe(true)
  await vi.advanceTimersByTimeAsync(250) // backoff reset after a snapshot
  expect(sockets).toHaveLength(3)
  sockets[2]!.feed({ jsonrpc: '2.0', id: 1, result: { seq: 1, terminals: [] } })
  await vi.advanceTimersByTimeAsync(1100) // no event nor heartbeat
  expect(sockets[2]!.destroyed).toBe(true)
  expect(log).toContain('down')
  session.stop()
})

it('does not retry an incompatible core', async () => {
  const { session, sockets } = open()
  await Promise.resolve()
  sockets[0]!.feed({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x', data: { kind: 'unsupported_generation' } } })
  await vi.advanceTimersByTimeAsync(60000)
  expect(sockets).toHaveLength(1)
  session.stop()
})

it('applies each event type and ignores unknown ones', () => {
  const m: CoreTerminals = new Map()
  expect(applyCoreEvent(m, { type: 'created', terminal: 't1', data: { address: 't1', cwd: '/w', state: 'live' } })).toBe('terminal')
  applyCoreEvent(m, { type: 'status', terminal: 't1', data: { status: { state: 'blocked' } } })
  applyCoreEvent(m, { type: 'turn', terminal: 't1', data: { turn: 3 } })
  applyCoreEvent(m, { type: 'labels', terminal: 't1', data: { labels: { a: 'b' } } })
  applyCoreEvent(m, { type: 'size', terminal: 't1', data: { cols: 100, rows: 30 } })
  expect(m.get('t1')).toMatchObject({ status: { state: 'blocked' }, turn: 3, labels: { a: 'b' }, cols: 100, rows: 30 })
  expect(applyCoreEvent(m, { type: 'whatever', terminal: 't1' })).toBeNull()
  expect(applyCoreEvent(m, { type: 'title', terminal: 'nope', data: { title: 'x' } })).toBeNull()
  expect(applyCoreEvent(m, { type: 'doc' })).toBe('doc')
  applyCoreEvent(m, { type: 'finished', terminal: 't1' })
  expect(m.size).toBe(0)
})

it('a title that only changes the spinner glyph in front is no change, and the state shows it without', async () => {
  const { coreState } = await import('../shared/coreState')
  const m: CoreTerminals = new Map([['t1', { address: 't1', cwd: '/w', state: 'live', agent: 'claude', title: '✳ Fix the bug' }]])
  for (const g of ['⠂', '⠐', '✳']) expect(applyCoreEvent(m, { type: 'title', terminal: 't1', data: { title: `${g} Fix the bug` } })).toBeNull()
  expect(applyCoreEvent(m, { type: 'title', terminal: 't1', data: { title: '⠂ Write the tests' } })).toBe('terminal')
  const s = coreState([...m.values()], [])
  expect(s.panes[0]!.title).toBe('Write the tests')
  expect(s.tabs![0]!.label).toBe('Write the tests')
})

it('a finished turn advances stateSeq and the preview key (status events carry no status_ms)', async () => {
  const { coreState } = await import('../shared/coreState')
  // Snapshot as core sends it: status_ms set once.
  const m: CoreTerminals = new Map([['t1', { address: 't1', cwd: '/w', state: 'live', agent: 'claude', status: { state: 'idle' }, status_ms: 1000, turn: 0 }]])
  const seq = () => coreState([...m.values()], []).panes[0]!.stateSeq
  expect(seq()).toBe(1000)
  applyCoreEvent(m, { type: 'status', terminal: 't1', data: { status: { app: 'claude-code', state: 'working' } } }, 2000)
  expect(seq()).toBe(2000)
  // Same state again (a message update): no new stamp.
  applyCoreEvent(m, { type: 'status', terminal: 't1', data: { status: { app: 'claude-code', state: 'working', msg: 'x' } } }, 2500)
  expect(seq()).toBe(2000)
  applyCoreEvent(m, { type: 'status', terminal: 't1', data: { status: { app: 'claude-code', state: 'done' } } }, 3000)
  expect(seq()).toBe(3000)
  applyCoreEvent(m, { type: 'turn', terminal: 't1', data: { state: 'done', turn: 1 } }, 3010)
  expect(m.get('t1')).toMatchObject({ turn: 1, status_ms: 3010 })
  // A time sent by core wins.
  applyCoreEvent(m, { type: 'status', terminal: 't1', data: { status: { state: 'working' }, status_ms: 4200 } }, 9999)
  expect(seq()).toBe(4200)
})

function alerts() {
  const held = new Map<string, CoreTerminal>()
  const sent: string[] = []
  const a = createCoreAlerts({ settleMs: 100, current: x => held.get(x), send: (x, k) => sent.push(`${x}:${k}`) })
  const status = (address: string, state: string, extra: Partial<CoreTerminal> = {}) => {
    const before = held.get(address)
    const after = { ...(before ?? term(address)), ...extra, status: { state } }
    held.set(address, after)
    a.onEvent({ type: 'status', terminal: address }, before, after)
  }
  return { status, sent, a }
}

it('alerts once when an agent needs input or finishes, after the settle delay', async () => {
  const { status, sent } = alerts()
  status('t1', 'working')
  status('t1', 'blocked')
  expect(sent).toEqual([])
  await vi.advanceTimersByTimeAsync(100)
  expect(sent).toEqual(['t1:needs-you'])
  status('t1', 'working')
  status('t1', 'idle')
  await vi.advanceTimersByTimeAsync(100)
  expect(sent).toEqual(['t1:needs-you', 't1:finished'])
})

it('sends nothing for a sub-agent, a flicker, a repeat in the same turn or a first sighting', async () => {
  const { status, sent } = alerts()
  status('child', 'working', { parent: 't1' })
  status('child', 'idle')
  status('t2', 'working')
  status('t2', 'idle')
  status('t2', 'working') // back before the settle delay
  await vi.advanceTimersByTimeAsync(100)
  status('t2', 'idle')
  status('t2', 'working')
  status('t2', 'idle') // same turn, same kind: once
  await vi.advanceTimersByTimeAsync(100)
  status('t3', 'idle') // nothing known before: not a finish
  await vi.advanceTimersByTimeAsync(100)
  expect(sent).toEqual(['t2:finished'])
})

it('a reconnect snapshot raises no alert (only live events do)', async () => {
  const { sockets, onEvent } = open()
  await Promise.resolve()
  sockets[0]!.feed({ jsonrpc: '2.0', id: 1, result: { seq: 1, terminals: [term('t1', { status: { state: 'blocked' } })] } })
  expect(onEvent).not.toHaveBeenCalled()
})

// Recorded from hc 0.1.16: a remote machine renamed, then its core restarted (server_stop).
it('drops a remote terminal that ends while its machine reconnects', async () => {
  const { session, sockets, log } = open()
  await Promise.resolve()
  const missed = (seq: number, terminals: CoreTerminal[]) => ({ jsonrpc: '2.0', method: 'missed', params: { seq, terminals } })
  sockets[0]!.feed({ jsonrpc: '2.0', id: 1, result: { seq: 10, terminals: [term('t1'), term('sim/t1'), term('sim/t2')] } })
  sockets[0]!.feed(
    ev(11, 'removed', 'sim/t1'), ev(12, 'removed', 'sim/t2'),
    // Core re-announces the machine's terminals under the new name, an old finished one included.
    ev(13, 'created', 'simx/t1', { address: 'simx/t1', cwd: '/w', state: 'finished', reason: 'server_stop' }),
    ev(14, 'created', 'simx/t2', { address: 'simx/t2', cwd: '/w', state: 'live' }),
    ev(15, 'finished', 'simx/t2', { reason: 'server_stop' }))
  expect(session.snapshot()?.map(t => t.address)).toEqual(['t1'])
  // The machine is back: core resyncs with every terminal, finished ones included.
  sockets[0]!.feed(missed(15, [term('t1'), term('simx/t1', { state: 'finished' }), term('simx/t2', { state: 'finished' })]),
    ev(16, 'created', 'simx/t3', { address: 'simx/t3', cwd: '/w', state: 'live' }))
  expect(session.snapshot()?.map(t => t.address)).toEqual(['t1', 'simx/t3'])
  expect(sockets[0]!.destroyed).toBe(false)
  expect(log.filter(w => w === 'snapshot')).toHaveLength(2)
  session.stop()
})

it('a missed resync replaces what is held, unless the held state is newer', async () => {
  const { session, sockets } = open()
  await Promise.resolve()
  // Arrives before the snapshot and is older than it: ignored.
  sockets[0]!.feed({ jsonrpc: '2.0', method: 'missed', params: { seq: 3, terminals: [term('old')] } })
  sockets[0]!.feed({ jsonrpc: '2.0', id: 1, result: { seq: 5, terminals: [term('t1'), term('sim/t1')] } })
  expect(session.snapshot()?.map(t => t.address)).toEqual(['t1', 'sim/t1'])
  // A stale terminal the events never removed goes on a resync that no longer lists it live.
  sockets[0]!.feed({ jsonrpc: '2.0', method: 'missed', params: { seq: 8, terminals: [term('t1'), term('sim/t1', { state: 'lost' })] } })
  expect(session.snapshot()?.map(t => t.address)).toEqual(['t1'])
  sockets[0]!.feed(ev(9, 'title', 't1', { title: 'next' }))
  expect(session.get('t1')?.title).toBe('next')
  // A malformed resync takes a new snapshot.
  sockets[0]!.feed({ jsonrpc: '2.0', method: 'missed', params: { seq: 10 } })
  expect(sockets[0]!.destroyed).toBe(true)
  session.stop()
})

it('a created or restarted event for an ended terminal does not add it', () => {
  const m: CoreTerminals = new Map([['sim/t1', term('sim/t1')]])
  expect(applyCoreEvent(m, { type: 'created', terminal: 'sim/t2', data: { address: 'sim/t2', cwd: '/w', state: 'finished' } })).toBeNull()
  expect(applyCoreEvent(m, { type: 'restarted', terminal: 'sim/t1', data: { address: 'sim/t1', cwd: '/w', state: 'lost' } })).toBe('terminal')
  expect(m.size).toBe(0)
})
