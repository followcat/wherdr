import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PANE_RE } from '../shared/ids'
import { coreState } from '../shared/coreState'
import type { CoreTerminal } from '../shared/coreInventory'
import { createCoreAlerts } from '../server/utils/coreAlerts'
import {
  createCorePool,
  hostBaseKey,
  parseHcSocketsEnv,
  resolveConfiguredSockets,
  secondaryLocalKey,
  secondaryRemoteKey,
} from '../server/utils/corePool'

const sha16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const term = (address: string, extra: Partial<CoreTerminal> = {}): CoreTerminal => ({ address, cwd: '/home/user/demo', state: 'live', ...extra })

describe('PANE_RE and /ws/events viewing for space panes', () => {
  it('accepts local and remote space-placed panes (s…:p…)', () => {
    expect(PANE_RE.test('s737031:p7431')).toBe(true)
    expect(PANE_RE.test('0a1b2c3d~s737031:p7431')).toBe(true)
    expect(PANE_RE.test('a1b2c3d4e5f60718~s737031:p7431')).toBe(true)
    expect(PANE_RE.test('s1:p2')).toBe(true)
    expect(PANE_RE.test('x1:p2')).toBe(false)
  })

  it('registers viewing presence on /ws/events for space-placed pane IDs', async () => {
    const clients = new Map<string, { send: (d: string) => void, pane: string | null, visible: boolean }>()
    const heartbeats: Array<{ id: string, pane: string | null, visible: boolean }> = []
    vi.resetModules()
    vi.stubGlobal('defineWebSocketHandler', (h: unknown) => h)
    vi.stubGlobal('checkUpgrade', () => true)
    vi.stubGlobal('watchPeer', () => {})
    vi.stubGlobal('unwatchPeer', () => {})
    vi.stubGlobal('isOpen', () => true)
    vi.stubGlobal('messageText', (m: unknown) => String(m))
    vi.stubGlobal('eventClients', clients)
    vi.stubGlobal('getStateJson', () => '{"ok":true,"workspaces":[],"panes":[]}')
    vi.stubGlobal('PANE_RE', PANE_RE)
    vi.doMock('../server/utils/notificationRules', () => ({
      notificationPresence: { heartbeat: (id: string, pane: string | null, visible: boolean) => heartbeats.push({ id, pane, visible }) },
    }))
    vi.doMock('../server/utils/wsCompression', () => ({ eventSendOptions: () => ({}) }))
    vi.doMock('../shared/uiOpen', () => ({ usedAt: () => null }))
    try {
      const mod = await import('../server/routes/ws/events')
      const handler = mod.default as unknown as {
        open: (peer: { id: string, send: (d: string) => void }) => void
        message: (peer: { id: string }, msg: string) => void
        close: (peer: { id: string }) => void
      }
      const peer = { id: 'peer-1', send: vi.fn() }
      handler.open(peer)
      handler.message(peer, JSON.stringify({ type: 'viewing', pane: 's737031:p7431', visible: true }))
      expect(clients.get('peer-1')?.pane).toBe('s737031:p7431')
      handler.message(peer, JSON.stringify({ type: 'viewing', pane: 'a1b2c3d4e5f60718~s737031:p7431', visible: true }))
      expect(clients.get('peer-1')?.pane).toBe('a1b2c3d4e5f60718~s737031:p7431')
      expect(heartbeats.map(h => h.pane)).toEqual(['s737031:p7431', 'a1b2c3d4e5f60718~s737031:p7431'])
      handler.close(peer)
    } finally {
      vi.unstubAllGlobals()
      vi.doUnmock('../server/utils/notificationRules')
      vi.doUnmock('../server/utils/wsCompression')
      vi.doUnmock('../shared/uiOpen')
    }
  })
})

describe('multi-session machine keys, baseKey merge and primary ID stability', () => {
  it('keeps primary local and remote pane IDs byte-identical to single-session output', () => {
    const terminals = [
      term('t1'),
      term('t2', { labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tb1' } }),
      term('host-b/t3'),
      term('host-b/t4', { labels: { 'herdr.space': 'sp2', 'herdr.tab': 'tb2' } }),
    ]
    const machines = [{ name: 'host-b', state: 'connected', host: 'host-b' }]
    const docs = {
      '': { spaces: [{ id: 'sp1', name: 'Main', folder: '/home/user/demo', tabs: [{ id: 'tb1', name: 'Tab' }] }] },
      'host-b': { spaces: [{ id: 'sp2', name: 'Remote', folder: '/home/user/demo', tabs: [{ id: 'tb2', name: 'Tab' }] }] },
    }
    const baseline = coreState(terminals, machines, docs, 'host-a')
    expect(baseline.panes.map(p => p.id)).toEqual([
      'w2f686f6d652f757365722f64656d6f:p7431',
      's737031:p7432',
      '686f73742d62~w2f686f6d652f757365722f64656d6f:p686f73742d622f7433',
      '686f73742d62~s737032:p686f73742d622f7434',
    ])
    expect(baseline.machines).toEqual([
      { key: '', label: 'host-a', local: true, status: 'online', error: null },
      { key: '686f73742d62', label: 'host-b', local: false, status: 'online', error: null },
    ])
  })

  it('derives deterministic secondary keys and merges baseKey by physical host', () => {
    const S = '/run/user/1000/herdr-core/backlot.sock'
    expect(secondaryLocalKey(S)).toBe(sha16(`local:${S}`))
    expect(secondaryRemoteKey(S, 'host-b-bl')).toBe(sha16(`remote:${S}:host-b-bl`))
    expect(hostBaseKey('host-c.local')).toBe(sha16('host:host-c.local'))

    const primaryMachines = [{ name: 'host-b', state: 'connected', host: 'host-b.local' }]
    const secondaryMachines = [
      { name: 'host-b-alias', state: 'connected', host: 'host-b.local' },
      { name: 'host-c', state: 'connected', host: 'host-c.local' },
      { name: 'never-connected', state: 'connecting', host: '' },
    ]
    const primaryKeyOf = (name: string) => Array.from(new TextEncoder().encode(name), b => b.toString(16).padStart(2, '0')).join('')
    const s = coreState(
      [term('t1'), term('host-b-alias/t1'), term('host-c/t1'), term('never-connected/t1')],
      secondaryMachines,
      {},
      'host-a',
      {
        localKey: secondaryLocalKey(S),
        localBaseKey: '',
        session: 'backlot',
        machineKey: name => secondaryRemoteKey(S, name),
        machineBaseKey: (m) => {
          if (!m.host) return undefined
          const match = primaryMachines.find(pm => pm.host && pm.host === m.host)
          return match ? primaryKeyOf(match.name) : hostBaseKey(m.host)
        },
      },
    )

    expect(s.machines).toEqual([
      { key: sha16(`local:${S}`), baseKey: '', session: 'backlot', label: 'host-a', local: true, status: 'online', error: null },
      { key: sha16(`remote:${S}:host-b-alias`), baseKey: primaryKeyOf('host-b'), session: 'backlot', label: 'host-b-alias', local: false, status: 'online', error: null },
      { key: sha16(`remote:${S}:host-c`), baseKey: sha16('host:host-c.local'), session: 'backlot', label: 'host-c', local: false, status: 'online', error: null },
      { key: sha16(`remote:${S}:never-connected`), session: 'backlot', label: 'never-connected', local: false, status: 'connecting', error: null },
    ])
    expect(s.panes[0]!.id).toBe(`${sha16(`local:${S}`)}~w2f686f6d652f757365722f64656d6f:p7431`)
    expect(s.panes[0]!.coreAddress).toBe('t1')
    expect(s.panes[1]!.id).toBe(`${sha16(`remote:${S}:host-b-alias`)}~w2f686f6d652f757365722f64656d6f:p686f73742d622d616c6961732f7431`)
  })
})

describe('config precedence for HC_SOCKET, HC_SOCKETS and settings.json hcSockets', () => {
  it('resolves, merges and deduplicates sockets without dropping primary or scanning directories', () => {
    expect(parseHcSocketsEnv(' ~/backlot.sock , /tmp/other.sock, ~/backlot.sock ', '/home/user')).toEqual([
      '/home/user/backlot.sock',
      '/tmp/other.sock',
    ])
    expect(resolveConfiguredSockets({
      primary: '~/default.sock',
      envSockets: '/tmp/a.sock, ~/default.sock, ~/backlot.sock',
      settingsSockets: ['/home/user/backlot.sock', '~/c.sock', '/tmp/a.sock'],
      home: '/home/user',
    })).toEqual({
      primary: '/home/user/default.sock',
      extra: ['/tmp/a.sock', '/home/user/backlot.sock', '/home/user/c.sock'],
    })
  })
})

describe('CorePool connections, isolation, routing and alerts', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn()
  })

  async function fakeSocketCore(sockPath: string, opts: {
    terminals: CoreTerminal[]
    machines?: Array<{ name: string, state: string, host?: string, why?: string }>
    onCall?: (method: string, params: Record<string, unknown>) => unknown
    hang?: boolean
  }) {
    const sockets = new Set<Socket>()
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    const subscribers = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.once('close', () => { sockets.delete(socket); subscribers.delete(socket) })
      let buf = ''
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          const req = JSON.parse(line) as { id: number, method: string, params?: Record<string, unknown> }
          calls.push({ method: req.method, params: req.params ?? {} })
          if (opts.hang) return
          if (req.method === 'events.subscribe') {
            subscribers.add(socket)
            socket.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { seq: 1, terminals: opts.terminals } }) + '\n')
            continue
          }
          const custom = opts.onCall?.(req.method, req.params ?? {})
          const result = custom !== undefined ? custom
            : req.method === 'terminal.list' ? { terminals: opts.terminals, machines: opts.machines ?? [], hidden_finished: 0 }
              : req.method === 'machine.list' ? { machines: opts.machines ?? [] }
                : req.method === 'doc.get' ? { value: null }
                  : {}
          socket.end(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n')
        }
      })
    })
    await new Promise<void>(resolve => server.listen(sockPath, resolve))
    cleanups.push(async () => {
      for (const s of sockets) s.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    })
    return {
      calls,
      emitEvent(event: object) {
        const line = JSON.stringify({ jsonrpc: '2.0', method: 'event', params: event }) + '\n'
        for (const s of subscribers) s.write(line)
      },
    }
  }

  it('routes forPane and forMachine to the owning session and isolates t1 collisions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'corepool-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const sockA = join(dir, 'default.sock')
    const sockB = join(dir, 'backlot.sock')
    const missingSock = join(dir, 'missing.sock')

    const coreA = await fakeSocketCore(sockA, {
      terminals: [term('t1', { template: 'claude', status: { state: 'idle' } })],
      machines: [{ name: 'host-b', state: 'connected', host: 'host-b.local' }],
    })
    const coreB = await fakeSocketCore(sockB, {
      terminals: [
        term('t1', { template: 'codex', status: { state: 'working' } }),
        term('host-b-bl/t2', { template: 'claude', status: { state: 'idle' } }),
      ],
      machines: [{ name: 'host-b-bl', state: 'connected', host: 'host-b.local' }],
    })

    const alerts: Array<{ machineKey: string, address: string, kind: string }> = []
    const pool = createCorePool({
      primary: sockA,
      extra: [sockB, missingSock],
      hostLabel: () => 'host-a',
      settleMs: 10,
      onAlert: (machineKey, address, kind) => { alerts.push({ machineKey, address, kind }) },
    })
    cleanups.push(async () => { pool.stop() })
    pool.start()
    await pool.poll()

    const state = pool.state()
    expect(state.ok).toBe(true)
    expect(state.ready).toBe(true)
    const pPrimary = state.panes.find(p => p.machine === '' && p.coreAddress === 't1')!
    const pSecLocal = state.panes.find(p => p.machine === secondaryLocalKey(sockB) && p.coreAddress === 't1')!
    const pSecRemote = state.panes.find(p => p.machine === secondaryRemoteKey(sockB, 'host-b-bl') && p.coreAddress === 'host-b-bl/t2')!
    expect(pPrimary).toBeTruthy()
    expect(pSecLocal).toBeTruthy()
    expect(pSecRemote).toBeTruthy()
    expect(pPrimary.id).not.toBe(pSecLocal.id)

    // Broken/missing third session stays offline without breaking primary.
    const missingInfo = state.machines?.find(m => m.key === secondaryLocalKey(missingSock))
    expect(missingInfo?.status).toBe('offline')
    expect(missingInfo?.baseKey).toBe('')

    // Routing per pane and per machine.
    expect(pool.forPane(pPrimary.id)?.endpoint).toBe(sockA)
    expect(pool.forPane(pSecLocal.id)?.endpoint).toBe(sockB)
    expect(pool.forPane(pSecRemote.id)?.endpoint).toBe(sockB)
    expect(pool.forMachine('')?.endpoint).toBe(sockA)
    expect(pool.forMachine(secondaryLocalKey(sockB))?.endpoint).toBe(sockB)
    expect(pool.forMachine(secondaryRemoteKey(sockB, 'host-b-bl'))?.endpoint).toBe(sockB)
    expect(pool.forMachine('deadbeef00001111')).toBeUndefined()

    await pool.forPane(pSecLocal.id)!.call('terminal.send', { terminal: 't1', text: 'hi' }, 2000)
    expect(coreB.calls.some(c => c.method === 'terminal.send' && c.params.terminal === 't1')).toBe(true)
    expect(coreA.calls.some(c => c.method === 'terminal.send')).toBe(false)

    // Alerts from both t1 panes resolve to distinct (machineKey, address) pairs.
    await vi.waitFor(() => expect(pool.entries().filter(e => e.session.connected)).toHaveLength(2))
    coreA.emitEvent({ seq: 2, type: 'status', terminal: 't1', data: { status: { state: 'blocked' } } })
    coreB.emitEvent({ seq: 2, type: 'status', terminal: 't1', data: { status: { state: 'blocked' } } })
    coreB.emitEvent({ seq: 3, type: 'status', terminal: 'host-b-bl/t2', data: { status: { state: 'blocked' } } })
    await vi.waitFor(() => expect(alerts).toHaveLength(3))
    expect(alerts).toContainEqual({ machineKey: '', address: 't1', kind: 'needs-you' })
    expect(alerts).toContainEqual({ machineKey: secondaryLocalKey(sockB), address: 't1', kind: 'needs-you' })
    expect(alerts).toContainEqual({ machineKey: secondaryRemoteKey(sockB, 'host-b-bl'), address: 'host-b-bl/t2', kind: 'needs-you' })
  })

  it('never blocks primary polls when a secondary socket hangs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'corepool-hang-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const sockA = join(dir, 'default.sock')
    const sockHang = join(dir, 'hang.sock')
    await fakeSocketCore(sockA, { terminals: [term('t1')] })
    await fakeSocketCore(sockHang, { terminals: [], hang: true })

    const pool = createCorePool({
      primary: sockA,
      extra: [sockHang],
      hostLabel: () => 'host-a',
      callTimeoutMs: 5000,
    })
    cleanups.push(async () => { pool.stop() })
    const start = Date.now()
    await pool.primary()!.poll()
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(1000)
    expect(pool.state().ok).toBe(true)
    expect(pool.state().panes).toHaveLength(1)
  })
})

describe('coreAlerts backlot daemon suppression', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('never alerts for backlot-stage or backlot-server terminals', async () => {
    const held = new Map<string, CoreTerminal>()
    const sent: string[] = []
    const alerts = createCoreAlerts({ settleMs: 100, current: a => held.get(a), send: (a, k) => sent.push(`${a}:${k}`) })
    const pushStatus = (address: string, state: string, extra: Partial<CoreTerminal> = {}) => {
      const before = held.get(address)
      const after = { ...(before ?? term(address)), ...extra, status: { state } }
      held.set(address, after)
      alerts.onEvent({ type: 'status', terminal: address }, before, after)
    }

    pushStatus('t1', 'working', { name: 'backlot-stage' })
    pushStatus('t1', 'blocked')
    pushStatus('t2', 'working', { name: 'backlot-server' })
    pushStatus('t2', 'idle')
    pushStatus('t3', 'working', { labels: { 'backlot.role': 'stage' } })
    pushStatus('t3', 'blocked')
    pushStatus('t4', 'working', { labels: { 'backlot.role': 'server' } })
    pushStatus('t4', 'idle')
    await vi.advanceTimersByTimeAsync(200)
    expect(sent).toEqual([])
  })
})
