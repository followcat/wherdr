import { describe, expect, it } from 'vitest'
import type { HerdrState, Pane } from '../shared/types'
import { READY_MAX_MS, serverReady, settleState } from '../shared/stateReady'

const pane = (id: string): Pane => ({ id, workspace: id.replace(/:p\d+$/, ''), status: 'idle', agent: 'claude' } as unknown as Pane)
const st = (panes: string[], extra: Partial<HerdrState> = {}): HerdrState => ({
  ok: true,
  workspaces: [...new Set(panes.map(p => p.replace(/:p\d+$/, '')))].map((id, i) => ({ id, label: id, number: i + 1, status: null })),
  tabs: [],
  panes: panes.map(pane),
  ...extra,
})
const REMOTE = 'abcd1234'
const machines = (status: 'online' | 'connecting' | 'offline') => [
  { key: '', label: 'local', local: true, status: 'online' as const, error: null },
  { key: REMOTE, label: 'remote', local: false, status, error: null },
]

describe('serverReady', () => {
  const base = { machinesListed: true, localPolled: true, remotes: [], elapsedMs: 0 }
  it('waits for the machine list and the first local poll', () => {
    expect(serverReady({ ...base, machinesListed: false })).toBe(false)
    expect(serverReady({ ...base, localPolled: false })).toBe(false)
    expect(serverReady(base)).toBe(true)
  })
  it('waits for each remote machine, unless offline', () => {
    expect(serverReady({ ...base, remotes: [{ status: 'connecting', polled: false }] })).toBe(false)
    expect(serverReady({ ...base, remotes: [{ status: 'online', polled: true }] })).toBe(true)
    expect(serverReady({ ...base, remotes: [{ status: 'offline', polled: false }] })).toBe(true)
  })
  it('never stays stuck', () => {
    expect(serverReady({ ...base, machinesListed: false, elapsedMs: READY_MAX_MS })).toBe(true)
  })
})

describe('settleState', () => {
  const prev = st(['w1:p1', `${REMOTE}~w1:p1`], { machines: machines('online') })

  it('keeps the last state per machine while the server is not ready', () => {
    // A restart still probing: nothing is answered for, so every pane and
    // machine stays, marked connecting, until the probes land.
    for (const settling of [true, false]) {
      const r = settleState(prev, st([], { ready: false }), settling)!
      expect(r.panes.map(p => p.id)).toEqual(['w1:p1', `${REMOTE}~w1:p1`])
      expect(r.machines!.find(m => m.key === REMOTE)!.status).toBe('connecting')
    }
  })
  it('a machine the "not ready" state answers for is authoritative', () => {
    // The remote is already 'online' in the partial state: its (empty) pane
    // list wins -- only the still-connecting machines keep their content.
    const next = st(['w1:p1'], { ready: false, machines: machines('online') })
    expect(settleState(prev, next, true)).toBe(next)
  })
  it('applies a "not ready" state on first load', () => {
    const next = st([], { ready: false })
    expect(settleState(null, next, false)).toBe(next)
  })
  it('keeps the panes of a reconnecting machine right after a reconnection', () => {
    const next = st(['w1:p1'], { machines: machines('connecting') })
    const r = settleState(prev, next, true)!
    expect(r.panes.map(p => p.id)).toEqual(['w1:p1', `${REMOTE}~w1:p1`])
    expect(r.workspaces.map(w => w.id)).toContain(`${REMOTE}~w1`)
  })
  it('keeps the machine even if missing from the list (profiles not re-read yet)', () => {
    const r = settleState(prev, st(['w1:p1']), true)!
    expect(r.panes.map(p => p.id)).toContain(`${REMOTE}~w1:p1`)
    expect(r.machines!.find(m => m.key === REMOTE)!.status).toBe('connecting')
  })
  it('outside a reconnection, the received state wins', () => {
    const next = st(['w1:p1'], { machines: machines('connecting') })
    expect(settleState(prev, next, false)).toBe(next)
  })
  it('an online machine without panes is taken as is', () => {
    const next = st(['w1:p1'], { machines: machines('online') })
    expect(settleState(prev, next, true)).toBe(next)
  })
})
