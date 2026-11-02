// "Split" / "New tab" then the command at once: the pane was just created, and
// wherdr's pane list (filled by polls of Herdr) may not have seen it yet. The
// command must still start; a pane that really does not exist is still refused.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pollQueue } from '../server/utils/pollQueue'
import { findNewPane } from '../server/utils/newPane'

// A fake Herdr (its live panes) and wherdr's cached list, filled by polls that
// read Herdr when they start and publish when they end (a snapshot round trip).
function world() {
  const herdrPanes = new Set<string>(['w1:p1'])
  let cache = new Set<string>(herdrPanes)
  const gates: (() => void)[] = []
  let manual = false
  const run = async () => {
    const read = new Set(herdrPanes)
    if (manual) await new Promise<void>(r => gates.push(r))
    cache = read
  }
  const q = pollQueue<{ key: string }>(run)
  return {
    herdrPanes, q,
    cached: (id: string) => cache.has(id),
    hold: () => { manual = true },
    // Lets the polls waiting now finish; `all`: later ones no longer wait.
    release: (all = true) => { if (all) manual = false; for (const g of gates.splice(0)) g() },
  }
}
const M = { key: '' }
const tick = () => new Promise(r => setTimeout(r, 0))

describe('pollQueue: a pane created while a poll is in flight', () => {
  it('joining the running poll misses the new pane (the bug)', async () => {
    const w = world()
    w.hold()
    w.q.pollOne(M) // background poll: has read Herdr already
    w.herdrPanes.add('w1:p2') // the split
    const joined = w.q.pollOne(M)
    w.release(false) // the follow-up poll it queued stays pending
    await joined
    expect(w.cached('w1:p2')).toBe(false)
  })

  it('pollFresh waits for it, then polls again: the new pane is seen', async () => {
    const w = world()
    w.hold()
    w.q.pollOne(M)
    w.herdrPanes.add('w1:p2')
    const fresh = w.q.pollFresh(M)
    await tick()
    w.release()
    await fresh
    expect(w.cached('w1:p2')).toBe(true)
  })
})

describe('findNewPane', () => {
  const deps = (w: ReturnType<typeof world>) => ({
    find: (id: string) => (w.cached(id) ? { id } : undefined),
    refresh: () => w.q.pollFresh(M),
    sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
  })

  it('finds a pane Herdr reports a little late (bounded wait)', async () => {
    const w = world()
    setTimeout(() => w.herdrPanes.add('w1:p3'), 300)
    expect(await findNewPane('w1:p3', deps(w), 2000)).toEqual({ id: 'w1:p3' })
  })

  it('gives up on a pane that never appears, after the wait', async () => {
    const w = world()
    const t0 = Date.now()
    expect(await findNewPane('w9:p9', deps(w), 400)).toBeUndefined()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400)
    expect(Date.now() - t0).toBeLessThan(1500)
  })
})

// The server path itself: /api/agents with the pane id returned by the split.
const dataDir = mkdtempSync(path.join(tmpdir(), 'newpane-'))
afterAll(() => rmSync(dataDir, { recursive: true, force: true }))
const s = vi.hoisted(() => ({
  cache: new Map<string, { id: string, machine: string, workspace: string, cwd: string, agent: string | null }>(),
  herdr: new Map<string, { id: string, machine: string, workspace: string, cwd: string, agent: string | null }>(),
  sent: [] as { pane_id: string, text?: string, keys?: string[] }[],
  remoteOnline: true,
  freshPolls: 0,
}))
vi.mock('../server/utils/env', () => ({
  AGENT_KINDS: ['claude'], DATA_DIR: dataDir, HOME: '/', RESUME_ARGS: {}, UPLOAD_DIR: dataDir, UPLOAD_TTL_MS: 1, log: () => {},
}))
vi.mock('../server/utils/herdr', () => ({
  HerdrError: class HerdrError extends Error { constructor(public code: string, message: string) { super(message) } },
  herdr: async (method: string, params: { pane_id: string, text?: string, keys?: string[] }) => {
    if (method === 'pane.send_input') s.sent.push(params)
    return {}
  },
  herdrOn: async () => ({}),
  sleep: (ms: number) => new Promise(r => setTimeout(r, Math.min(ms, 20))),
}))
vi.mock('../server/utils/choices', () => ({ panelOpen: () => false }))
vi.mock('../server/utils/agentAvailability', () => ({ installedAgentKinds: async () => [] }))
vi.mock('../server/utils/state', () => ({
  addQueued: () => {}, pendingPrompts: new Map(),
  findPane: (id: string) => s.cache.get(id),
  // The background poll had already read Herdr: the plain poll publishes the old list.
  poll: async () => {},
  // A fresh poll reads Herdr after the call.
  pollFresh: async () => { s.freshPolls++; s.cache = new Map(s.herdr) },
}))
vi.mock('../server/utils/machines', () => {
  const fsStub = { stat: async () => ({ isDir: true }) }
  const local = { key: '', label: 'This Mac', local: true, status: 'online', home: '/', fs: fsStub }
  const remote = { key: 'abcd1234', label: 'Studio', local: false, get status() { return s.remoteOnline ? 'online' : 'offline' }, home: '/', fs: fsStub, error: null }
  const getMachine = (k: string) => (!k ? local : k === 'abcd1234' ? remote : undefined)
  return {
    RemoteMachine: class {}, allMachines: () => [local, remote], getMachine,
    machineOfPane: (id: string) => getMachine(id.includes('~') ? id.split('~')[0] : ''),
  }
})

const { createAgent } = await import('../server/utils/actions')
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code)
const pane = (id: string, machine = '') => ({ id, machine, workspace: 'w1', cwd: '/', agent: null })

describe('createAgent in a pane just created', () => {
  beforeEach(() => {
    s.cache = new Map([['w1:p1', pane('w1:p1')]])
    s.herdr = new Map(s.cache)
    s.sent = []
    s.remoteOnline = true
    s.freshPolls = 0
  })

  it('local split: the pane is not in the list yet, the shell command still starts', async () => {
    s.herdr.set('w1:p2', pane('w1:p2'))
    const r = await createAgent({ kind: 'shell', pane_id: 'w1:p2', prompt: 'ls -la' })
    expect(r).toMatchObject({ pane_id: 'w1:p2' })
    expect(s.sent).toEqual([{ pane_id: 'w1:p2', text: 'ls -la' }, { pane_id: 'w1:p2', keys: ['enter'] }])
  })

  it('remote split: same, on the machine named in the pane id', async () => {
    s.herdr.set('abcd1234~w2:p5', pane('abcd1234~w2:p5', 'abcd1234'))
    const r = await createAgent({ kind: 'shell', pane_id: 'abcd1234~w2:p5', prompt: 'make' })
    expect(r).toMatchObject({ pane_id: 'abcd1234~w2:p5' })
    expect(s.sent[0]).toEqual({ pane_id: 'abcd1234~w2:p5', text: 'make' })
  })

  it('an existing pane needs no extra poll', async () => {
    await createAgent({ kind: 'shell', pane_id: 'w1:p1', prompt: 'pwd' })
    expect(s.freshPolls).toBe(0)
  })

  it('a pane that really does not exist is still bad_pane', async () => {
    expect(await codeOf(createAgent({ kind: 'shell', pane_id: 'w7:p7', prompt: 'ls' }))).toBe('bad_pane')
    expect(s.sent).toEqual([])
  }, 10_000)

  it('a malformed pane id is bad_pane at once', async () => {
    expect(await codeOf(createAgent({ kind: 'shell', pane_id: 'nope', prompt: 'ls' }))).toBe('bad_pane')
    expect(s.freshPolls).toBe(0)
  })

  it('a pane on an offline machine says the machine is unreachable', async () => {
    s.remoteOnline = false
    expect(await codeOf(createAgent({ kind: 'shell', pane_id: 'abcd1234~w2:p5', prompt: 'ls' }))).toBe('unreachable')
  })
})
