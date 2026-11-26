import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PANE_RE } from '../shared/ids'
import { coreState } from '../shared/coreState'
import type { CoreTerminal } from '../shared/coreInventory'
import { createCoreAlerts } from '../server/utils/coreAlerts'
import { createCorePreviews } from '../server/utils/corePreview'
import { createCoreTranscripts } from '../server/utils/coreTranscripts'
import { DEVIN_PROCESS_SCRIPT } from '../server/utils/devinProcesses'
import { createModelCtl, createModelRefresh } from '../server/utils/modelctl'
import {
  createCorePool,
  hostBaseKey,
  parseHcSocketsEnv,
  resolveConfiguredSockets,
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

describe('multi-session real machines, session-scoped IDs and primary ID stability', () => {
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

  it('keeps real machine keys on secondary panes and scopes their IDs by session', () => {
    const S = '/run/user/1000/herdr-core/backlot.sock'
    expect(hostBaseKey('host-c.local')).toBe(sha16('host:host-c.local'))

    const primaryMachines = [{ name: 'host-b', state: 'connected', host: 'host-b.local' }]
    const secondaryMachines = [
      { name: 'host-b-alias', state: 'connected', host: 'host-b.local' },
      { name: 'host-c', state: 'connected', host: 'host-c.local' },
      { name: 'never-connected', state: 'connecting', host: '' },
    ]
    const primaryKeyOf = (name: string) => Array.from(new TextEncoder().encode(name), b => b.toString(16).padStart(2, '0')).join('')
    const scope = sha16(`session:${S}`)
    const canonical = (m: { name: string, host?: string }) => {
      if (!m.host) return primaryKeyOf(m.name)
      const match = primaryMachines.find(pm => pm.host && pm.host === m.host)
      return match ? primaryKeyOf(match.name) : hostBaseKey(m.host)
    }
    const s = coreState(
      [term('t1'), term('host-b-alias/t1'), term('host-c/t1'), term('never-connected/t1')],
      secondaryMachines,
      {},
      'host-a',
      {
        session: 'backlot',
        idScope: scope,
        machineKey: name => canonical(secondaryMachines.find(m => m.name === name)!),
      },
    )

    expect(s.machines).toEqual([
      { key: '', label: 'host-a', local: true, status: 'online', error: null },
      { key: primaryKeyOf('host-b'), label: 'host-b-alias', local: false, status: 'online', error: null },
      { key: sha16('host:host-c.local'), label: 'host-c', local: false, status: 'online', error: null },
      { key: primaryKeyOf('never-connected'), label: 'never-connected', local: false, status: 'connecting', error: null },
    ])
    expect(s.panes.map(p => p.session)).toEqual(['backlot', 'backlot', 'backlot', 'backlot'])
    expect(s.panes[0]!.machine).toBe('')
    expect(s.panes[0]!.id).toBe(`s${scope}~w2f686f6d652f757365722f64656d6f:p7431`)
    expect(s.panes[1]!.machine).toBe(primaryKeyOf('host-b'))
    expect(s.panes[1]!.id).toBe(`s${scope}~${primaryKeyOf('host-b')}~w2f686f6d652f757365722f64656d6f:p686f73742d622d616c6961732f7431`)
    expect(PANE_RE.test(s.panes[0]!.id)).toBe(true)
    expect(PANE_RE.test(s.panes[1]!.id)).toBe(true)
  })
})

describe('config precedence for HC_SOCKET, HC_SOCKETS and discovered sockets', () => {
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
    // Operator-supplied HC_SOCKETS / --hc-sockets may point outside the primary socket directory.
    expect(resolveConfiguredSockets({
      primary: '/run/user/1000/herdr-core/default.sock',
      envSockets: '/tmp/outside-operator.sock',
      settingsSockets: [],
    })).toEqual({
      primary: '/run/user/1000/herdr-core/default.sock',
      extra: ['/tmp/outside-operator.sock'],
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

    const alerts: Array<{ session: string, machineKey: string, address: string, kind: string }> = []
    const pool = createCorePool({
      primary: sockA,
      extra: [sockB, missingSock],
      hostLabel: () => 'host-a',
      settleMs: 10,
      onAlert: (entry, machineKey, address, kind) => { alerts.push({ session: entry.sessionName, machineKey, address, kind }) },
    })
    cleanups.push(async () => { pool.stop() })
    pool.start()
    await pool.poll()

    const state = pool.state()
    expect(state.ok).toBe(true)
    expect(state.ready).toBe(true)
    const pPrimary = state.panes.find(p => p.machine === '' && p.coreAddress === 't1')!
    const pSecLocal = state.panes.find(p => p.session === 'backlot' && !p.machine && p.coreAddress === 't1')!
    const pSecRemote = state.panes.find(p => p.session === 'backlot' && p.machine && p.coreAddress === 'host-b-bl/t2')!
    expect(pPrimary).toBeTruthy()
    expect(pSecLocal).toBeTruthy()
    expect(pSecRemote).toBeTruthy()
    expect(pPrimary.id).not.toBe(pSecLocal.id)

    // Broken/missing third session stays offline without breaking primary.
    expect(state.sessions?.find(x => x.name === 'missing')?.status).toBe('offline')
    expect(state.machines?.filter(m => m.local)).toHaveLength(1)
    expect(state.machines?.find(m => m.local)?.sessions).toMatchObject({ default: { status: 'online' }, backlot: { status: 'online' }, missing: { status: 'offline' } })

    // Routing per pane and per machine.
    expect(pool.forPane(pPrimary.id)?.endpoint).toBe(sockA)
    expect(pool.forPane(pSecLocal.id)?.endpoint).toBe(sockB)
    expect(pool.forPane(pSecRemote.id)?.endpoint).toBe(sockB)
    expect(pool.forMachine('')?.endpoint).toBe(sockA)
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
    expect(alerts).toContainEqual({ session: 'default', machineKey: '', address: 't1', kind: 'needs-you' })
    expect(alerts).toContainEqual({ session: 'backlot', machineKey: '', address: 't1', kind: 'needs-you' })
    expect(alerts).toContainEqual({ session: 'backlot', machineKey: expect.any(String), address: 'host-b-bl/t2', kind: 'needs-you' })
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

  it('keys coreTranscripts ps cache per machine and per core entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'corepool-pscache-'))
    const home = join(dir, 'home')
    await mkdir(join(home, '.gemini/antigravity-cli/conversations'), { recursive: true })
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const sockA = join(dir, 'default.sock')
    const sockB = join(dir, 'secondary.sock')

    const psCounts = () => ({ local: 0, remote: 0 })
    const psA = psCounts()
    const psB = psCounts()
    const session = '11111111-2222-4333-8444-555555555555'
    const makeOnCall = (counts: { local: number, remote: number }) => (method: string, params: Record<string, unknown>) => {
      if (method === 'terminal.get') {
        const idx = String(params.terminal || '').endsWith('t3') ? 102 : String(params.terminal || '').endsWith('t2') ? 101 : 100
        return { pid: idx, argv: ['bash'], foreground: { pid: idx, name: 'bash', argv: ['bash'], cwd: '/work/proj' } }
      }
      if (method === 'machine.exec') {
        const argv = (params.argv as string[] | undefined) ?? []
        const on = String(params.on || '')
        if (argv[0] === 'ps') {
          if (on === 'host-b') counts.remote++
          else counts.local++
          const rows = [
            '100 1 sh', `200 100 agy --conversation ${session}`,
            '101 1 sh', `201 101 agy --conversation ${session}`,
            '102 1 sh', `202 102 agy --conversation ${session}`,
          ].join('\n') + '\n'
          return { code: 0, stdout: Buffer.from(rows).toString('base64') }
        }
        if (argv[2] === DEVIN_PROCESS_SCRIPT) {
          const lines = argv.slice(4).map(pid => `${pid} 100 100 1767225600 100.00 1767225700.001 ${Buffer.from(`agy\0--conversation\0${session}\0`).toString('base64')}`)
          return { code: 0, stdout: Buffer.from(lines.join('\n') + '\n').toString('base64') }
        }
        if (argv[2] === 'printf %s "$HOME"') return { code: 0, stdout: Buffer.from(home).toString('base64') }
        return { code: 1, stdout: '', stderr: '' }
      }
      return undefined
    }

    await fakeSocketCore(sockA, {
      terminals: [
        term('t1', { template: 'agy', agentSession: session }),
        term('host-b/t2', { template: 'agy', agentSession: session }),
        term('host-b/t3', { template: 'agy', agentSession: session }),
      ],
      machines: [{ name: 'host-b', state: 'connected', host: 'host-b.local' }],
      onCall: makeOnCall(psA),
    })
    await fakeSocketCore(sockB, {
      terminals: [
        term('t1', { template: 'agy', agentSession: session }),
        term('host-b/t2', { template: 'agy', agentSession: session }),
      ],
      machines: [{ name: 'host-b', state: 'connected', host: 'host-b.local' }],
      onCall: makeOnCall(psB),
    })

    const pool = createCorePool({ primary: sockA, extra: [sockB], hostLabel: () => 'host-a' })
    cleanups.push(async () => { pool.stop() })
    await pool.poll()

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(1_000)
      const byEp = new Map(pool.entries().map(entry => [
        entry.endpoint,
        createCoreTranscripts({
          call: (method, params, timeout) => entry.call(method, params, timeout),
          pane: id => pool.findPane(id),
          localHome: home,
        }),
      ]))
      const trA = byEp.get(sockA)!
      const trB = byEp.get(sockB)!
      const panes = pool.state().panes
      const pALocal = panes.find(p => p.coreAddress === 't1' && pool.forPane(p.id)?.endpoint === sockA)!
      const pAR2 = panes.find(p => p.coreAddress === 'host-b/t2' && pool.forPane(p.id)?.endpoint === sockA)!
      const pAR3 = panes.find(p => p.coreAddress === 'host-b/t3' && pool.forPane(p.id)?.endpoint === sockA)!
      const pBLocal = panes.find(p => p.coreAddress === 't1' && pool.forPane(p.id)?.endpoint === sockB)!
      const pBR2 = panes.find(p => p.coreAddress === 'host-b/t2' && pool.forPane(p.id)?.endpoint === sockB)!

      // Concurrent locates on the same (entry, machine) share 1 ps call.
      await Promise.all([trA.locate(pAR2), trA.locate(pAR3)])
      expect(psA.remote).toBe(1)
      expect(psB.remote).toBe(0)

      // Identical remote machine name on a second core entry maintains its own ps cache.
      await trB.locate(pBR2)
      expect(psA.remote).toBe(1)
      expect(psB.remote).toBe(1)

      // Local machine ps caches are also isolated per core entry.
      await trA.locate(pALocal)
      await trB.locate(pBLocal)
      expect(psA.local).toBe(1)
      expect(psB.local).toBe(1)

      // Within the 10s TTL (past locCache 8s), entry A reuses its cached ps table.
      vi.setSystemTime(9_500)
      await trA.locate(pAR2)
      expect(psA.remote).toBe(1)
      expect(psB.remote).toBe(1)

      // After 10s TTL expires, only entry A refreshes host-b; entry B keeps its cache.
      vi.setSystemTime(18_500)
      await trA.locate(pAR2)
      expect(psA.remote).toBe(2)
      expect(psB.remote).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies PR #29 viewed-only DB gating to secondary pool entry panes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'corepool-viewed-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const sockA = join(dir, 'default.sock')
    const sockB = join(dir, 'secondary.sock')

    await fakeSocketCore(sockA, {
      terminals: [term('t1', { template: 'claude', status: { state: 'idle' } })],
    })
    await fakeSocketCore(sockB, {
      terminals: [
        term('t1', { template: 'agy', status: { state: 'working' }, statusSeq: 1 }),
        term('t2', { template: 'devin', status: { state: 'idle' }, statusSeq: 1 }),
      ],
      onCall: (method) => {
        if (method === 'terminal.read') return { text: ' ● Secondary screen reply.\n>\nauto · Gemini 3 Pro\n' }
        return undefined
      },
    })

    const pool = createCorePool({ primary: sockA, extra: [sockB], hostLabel: () => 'host-a' })
    cleanups.push(async () => { pool.stop() })
    await pool.poll()

    const secEntry = pool.entries().find(e => e.endpoint === sockB)!
    const secPanes = pool.state().panes.filter(p => p.session === 'secondary')
    const pSecAgy = secPanes.find(p => p.coreAddress === 't1')!
    const pSecDevin = secPanes.find(p => p.coreAddress === 't2')!

    let clock = 1_000
    const viewedIds = new Set<string>()
    const replyDbCalls: string[] = []
    const modelDbCalls: Array<{ id: string, walTailOnly?: boolean }> = []

    const previews = createCorePreviews({
      reply: async (p) => {
        replyDbCalls.push(p.id)
        return { text: 'DB reply' }
      },
      read: async address => (await secEntry.call<{ text?: string }>('terminal.read', { terminal: address }, 2000)).text || '',
      viewed: id => viewedIds.has(id),
      wake: () => { previews.apply(secPanes) },
      now: () => clock,
    })
    const ctl = createModelCtl({
      transcript: async (p, opts) => {
        modelDbCalls.push({ id: p.id, walTailOnly: opts?.walTailOnly })
        return opts?.walTailOnly ? null : { id: 'db-model', label: 'DB Model', at: new Date(clock).toISOString() }
      },
      codexConfig: async () => null,
      machineKey: p => p.machine || '',
      now: () => clock,
    })
    const refresh = createModelRefresh({
      currentModel: (p, opts) => ctl.currentModel(p, undefined, opts),
      viewed: id => viewedIds.has(id),
      now: () => clock,
    })

    // Unviewed poll: secondary agy + devin skip DB preview & DB model reads; screen fallback works.
    ctl.noteScreen(pSecAgy.id, 'agy', ' ● Secondary screen reply.\n>\nauto · Gemini 3 Pro\n')
    previews.apply(secPanes)
    refresh.apply(pSecAgy)
    refresh.apply(pSecDevin)
    await vi.waitFor(() => expect(pSecAgy.preview).toBe('Secondary screen reply.'))
    await vi.waitFor(() => expect(pSecDevin.preview).toBe('Secondary screen reply.'))
    expect(replyDbCalls).toEqual([])
    expect(modelDbCalls).toEqual([])

    // Unviewed status flip: only walTailOnly=true is requested (no full DB load).
    pSecAgy.status = 'idle'
    pSecAgy.stateSeq = 2
    refresh.apply(pSecAgy)
    await vi.waitFor(() => expect(modelDbCalls).toEqual([{ id: pSecAgy.id, walTailOnly: true }]))
    await vi.waitFor(() => {
      refresh.apply(pSecAgy)
      expect(pSecAgy.model?.label).toBe('Gemini 3 Pro')
    })

    // Viewed secondary agy pane unlocks full DB reads; unviewed devin still stays gated out.
    viewedIds.add(pSecAgy.id)
    clock += 6_000
    pSecAgy.stateSeq = 3
    previews.apply(secPanes)
    await vi.waitFor(() => expect(pSecAgy.preview).toBe('DB reply'))
    await vi.waitFor(() => {
      refresh.apply(pSecAgy)
      refresh.apply(pSecDevin)
      expect(modelDbCalls.some(c => c.id === pSecAgy.id && !c.walTailOnly)).toBe(true)
    })
    expect(replyDbCalls).toEqual([pSecAgy.id])
    expect(modelDbCalls.some(c => c.id === pSecDevin.id)).toBe(false)
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
