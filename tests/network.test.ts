import { afterEach, describe, expect, it } from 'vitest'
import { funnelExposes, tailnetPeers, targetPort } from '../bin/lib/tailnet.mjs'
import {
  checkClient, forwardedClients, gateDecision, isLoopbackIp, isTailnetIp, listenVerdict, netContext,
  ensureFresh, ensureRecent, parseTrustedNetworks, plainIp, refreshTailscale, resetNetworkStateForTests, tailnetKnown, type NetContext, type TailscaleState,
} from '../server/utils/network'

const TS: TailscaleState = { running: true, selfIps: ['100.90.1.2', 'fd7a:115c:a1e0::2'], peerIps: ['100.101.102.103', 'fd7a:115c:a1e0::5'], funnel: false }
const ctx = (over: Partial<NetContext> = {}, trusted = ''): NetContext => ({ trusted: parseTrustedNetworks(trusted), tailscale: TS, ...over })

describe('addresses', () => {
  it('normalizes IPv4-mapped and bracketed addresses', () => {
    expect(plainIp('::ffff:127.0.0.1')).toBe('127.0.0.1')
    expect(plainIp('[::1]')).toBe('::1')
    expect(plainIp('fe80::1%eth0')).toBe('fe80::1')
  })
  it('knows loopback and the tailnet ranges', () => {
    expect(isLoopbackIp('127.8.9.10')).toBe(true)
    expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackIp('192.168.1.20')).toBe(false)
    expect(isTailnetIp('100.127.255.254')).toBe(true)
    expect(isTailnetIp('100.128.0.1')).toBe(false)
    expect(isTailnetIp('fd7a:115c:a1e0::1')).toBe(true)
    expect(isTailnetIp('fd7a:115c:a1e1::1')).toBe(false)
  })
})

describe('trusted networks', () => {
  it('parses CIDRs, single addresses and `any`, and reports the rest', () => {
    const t = parseTrustedNetworks(' 10.147.17.0/24, 192.168.1.5 ,fd00::/8, nope, 10.0.0.0/40 ')
    expect(t.entries).toEqual(['10.147.17.0/24', '192.168.1.5', 'fd00::/8'])
    expect(t.invalid).toEqual(['nope', '10.0.0.0/40'])
    expect(t.list.check('10.147.17.9', 'ipv4')).toBe(true)
    expect(parseTrustedNetworks('any').any).toBe(true)
  })
})

describe('tailnet: what Tailscale itself reports', () => {
  it('reads running state, own and peer addresses from `tailscale status --json`', () => {
    const json = JSON.stringify({ BackendState: 'Running', Self: { UserID: 7, TailscaleIPs: ['100.90.1.2'] }, Peer: { a: { UserID: 7, TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::5'] } } })
    expect(tailnetPeers(json)).toEqual({ readable: true, state: 'Running', running: true, selfIps: ['100.90.1.2'], peerIps: ['100.101.102.103', 'fd7a:115c:a1e0::5'], otherIps: [] })
    expect(tailnetPeers('{"BackendState":"Stopped"}')).toMatchObject({ readable: true, running: false })
    // A failed read is unknown, not "stopped".
    expect(tailnetPeers('')).toMatchObject({ readable: false, running: false })
    expect(tailnetPeers('not json')).toMatchObject({ readable: false })
  })
  it('trusts a tailnet peer only while Tailscale runs and lists it', () => {
    expect(tailnetKnown('100.101.102.103', TS)).toBe(true)
    expect(tailnetKnown('::ffff:100.101.102.103', TS)).toBe(true)
    expect(tailnetKnown('100.70.0.4', TS)).toBe(false)
    expect(tailnetKnown('100.101.102.103', { ...TS, running: false })).toBe(false)
    expect(tailnetKnown('100.101.102.103', null)).toBe(false)
  })
  it('never takes a CGNAT LAN for the tailnet: Tailscale absent, stopped, or not listing it', () => {
    expect(checkClient('100.101.102.103', {}, ctx())).toEqual({ ok: true, zone: 'tailnet' })
    expect(checkClient('fd7a:115c:a1e0::5', {}, ctx())).toEqual({ ok: true, zone: 'tailnet' })
    expect(checkClient('100.70.0.4', {}, ctx())).toEqual({ ok: false, reason: 'peer' })
    expect(checkClient('100.101.102.103', {}, ctx({ tailscale: null }))).toEqual({ ok: false, reason: 'peer' })
    expect(checkClient('100.101.102.103', {}, ctx({ tailscale: { ...TS, running: false } }))).toEqual({ ok: false, reason: 'peer' })
  })
})

describe('tailnet state over time', () => {
  afterEach(() => resetNetworkStateForTests())
  const up = { installed: true, readable: true, running: true, selfIps: [], peerIps: ['100.101.102.103'], funnel: false }
  it('stops trusting peers once Tailscale stops, fails to answer, or its state is stale', async () => {
    const t0 = 1_000_000
    await refreshTailscale(async () => up, t0)
    expect(checkClient('100.101.102.103', {}, netContext(t0 + 1000)).ok).toBe(true)
    await refreshTailscale(async () => ({ ...up, running: false, peerIps: [] }), t0 + 10_000)
    expect(checkClient('100.101.102.103', {}, netContext(t0 + 11_000))).toEqual({ ok: false, reason: 'peer' })
    await refreshTailscale(async () => up, t0 + 20_000)
    await refreshTailscale(async () => { throw new Error('tailscale hangs') }, t0 + 30_000)
    expect(checkClient('100.101.102.103', {}, netContext(t0 + 31_000))).toEqual({ ok: false, reason: 'peer' })
    await refreshTailscale(async () => up, t0 + 40_000)
    expect(checkClient('100.101.102.103', {}, netContext(t0 + 80_000))).toEqual({ ok: false, reason: 'peer' })
  })
  it('serves an unknown state until Funnel is seen, then refuses until a valid reading shows it gone', async () => {
    const t0 = 2_000_000
    const local = { ok: true, zone: 'local' }
    // Nothing read yet (startup), then an unreadable status: unknown, served.
    expect(checkClient('127.0.0.1', {}, netContext(t0))).toEqual(local)
    await refreshTailscale(async () => ({ ...up, readable: false, running: false, peerIps: [], funnel: null }), t0)
    expect(checkClient('127.0.0.1', {}, netContext(t0 + 1000))).toEqual(local)
    // Funnel seen: refused.
    await refreshTailscale(async () => ({ ...up, funnel: true }), t0 + 10_000)
    expect(checkClient('127.0.0.1', {}, netContext(t0 + 11_000))).toEqual({ ok: false, reason: 'funnel' })
    // Failed, unreadable or stale readings do not reopen.
    await refreshTailscale(async () => ({ ...up, readable: false, running: false, peerIps: [], funnel: null }), t0 + 20_000)
    expect(checkClient('127.0.0.1', {}, netContext(t0 + 21_000))).toEqual({ ok: false, reason: 'funnel' })
    await refreshTailscale(async () => { throw new Error('socket gone') }, t0 + 30_000)
    expect(checkClient('127.0.0.1', {}, netContext(t0 + 31_000))).toEqual({ ok: false, reason: 'funnel' })
    expect(checkClient('127.0.0.1', {}, netContext(t0 + 200_000))).toEqual({ ok: false, reason: 'funnel' })
    // A valid reading without Funnel: served again.
    await refreshTailscale(async () => up, t0 + 210_000)
    expect(checkClient('127.0.0.1', {}, netContext(t0 + 211_000))).toEqual(local)
    // Tailscale reporting itself stopped is a valid reading too (it relays nothing).
    await refreshTailscale(async () => ({ ...up, funnel: true }), t0 + 220_000)
    await refreshTailscale(async () => ({ ...up, running: false, peerIps: [], funnel: false }), t0 + 230_000)
    expect(checkClient('127.0.0.1', {}, netContext(t0 + 231_000))).toEqual(local)
  })
  it('keeps a private wherdr open while Funnel publishes another service', async () => {
    const other = { ...up, funnel: false }
    {
      await refreshTailscale(async () => other, 4_000_000)
      expect(checkClient('127.0.0.1', {}, netContext(4_000_001))).toEqual({ ok: true, zone: 'local' })
    }
  })
  it('drops a reading that finishes after a newer one: an old "no Funnel" never clears a newer exposure', async () => {
    const http = () => gateDecision({ check: checkClient('127.0.0.1', {}, netContext()), unlocked: true, hostOk: true, crossSite: false, path: '/api/config' })
    let finishA!: () => void
    // A starts first and is slow; it would say "no Funnel".
    const a = refreshTailscale(() => new Promise(r => { finishA = () => r({ ...up, funnel: false }) }), Date.now())
    // B starts later, finishes first and sees Funnel.
    await refreshTailscale(async () => ({ ...up, funnel: true }), Date.now())
    expect(http()).toBe('network')
    finishA()
    await a
    expect(http()).toBe('network')
    // Then an unreadable reading: still refused.
    await refreshTailscale(async () => ({ ...up, readable: false, running: false, peerIps: [], funnel: null }), Date.now())
    expect(http()).toBe('network')
    // An old failure finishing late does not replace a newer valid reading either.
    let failC!: () => void
    const c = refreshTailscale(() => new Promise((_, reject) => { failC = () => reject(new Error('late')) }), Date.now())
    await refreshTailscale(async () => up, Date.now())
    expect(http()).toBe('ok')
    expect(checkClient('100.101.102.103', {}, netContext()).ok).toBe(true)
    failC()
    await c
    expect(http()).toBe('ok')
    expect(checkClient('100.101.102.103', {}, netContext()).ok).toBe(true)
  })
  it('reads Tailscale again for a WebSocket upgrade, and for HTTP past 2 s', async () => {
    let funnel = false
    let reads = 0
    const reader = async () => { reads++; return { ...up, funnel } }
    const t0 = Date.now()
    await refreshTailscale(reader, t0)
    // Funnel turned on right after that reading.
    funnel = true
    // HTTP within 2 s: the reading is recent enough, no new one.
    await ensureFresh(2000, reader, t0 + 1000)
    expect(reads).toBe(1)
    // A WebSocket upgrade: a reading started after it arrived, which sees Funnel.
    await ensureFresh(0, reader, Date.now() + 1)
    expect(reads).toBe(2)
    expect(checkClient('127.0.0.1', {}, netContext())).toEqual({ ok: false, reason: 'funnel' })
  })
  it('HTTP: serves on a reading up to 10 s old while a new one runs in the background, waits past that', async () => {
    let funnel = false
    let reads = 0
    let finish: (() => void) | null = null
    const slow = () => new Promise<typeof up>((r) => { reads++; finish = () => r({ ...up, funnel }) })
    const t0 = Date.now()
    await refreshTailscale(async () => up, t0 - 5000)
    funnel = true // turned on since that reading
    // 5 s old: answered at once on it, a reading starts for the next requests (shared by them).
    expect(await Promise.race([ensureRecent(2000, 10_000, slow, t0).then(() => 'now'), new Promise(r => setTimeout(r, 50, 'waited'))])).toBe('now')
    await ensureRecent(2000, 10_000, slow, t0)
    expect(reads).toBe(1)
    // Funnel's own traffic is refused on its header meanwhile, whatever the reading says.
    expect(checkClient('127.0.0.1', { 'tailscale-funnel-request': '?1' }, netContext())).toEqual({ ok: false, reason: 'funnel' })
    finish!()
    await new Promise(r => setTimeout(r, 0))
    // The background reading saw Funnel: the next requests are refused.
    expect(checkClient('127.0.0.1', {}, netContext())).toEqual({ ok: false, reason: 'funnel' })
    // Over 10 s old: the request waits for the new reading.
    resetNetworkStateForTests()
    funnel = true
    await refreshTailscale(async () => ({ ...up, funnel: false }), Date.now() - 11_000)
    const waiting = ensureRecent(2000, 10_000, slow, Date.now())
    let done = false
    void waiting.then(() => { done = true })
    await new Promise(r => setTimeout(r, 20))
    expect(done).toBe(false)
    finish!()
    await waiting
    expect(checkClient('127.0.0.1', {}, netContext())).toEqual({ ok: false, reason: 'funnel' })
  })
  it('HTTP: with no reading yet, waits for one; a failed one trusts no tailnet peer', async () => {
    let reads = 0
    await ensureRecent(2000, 10_000, async () => { reads++; throw new Error('tailscale hangs') })
    expect(reads).toBe(1)
    expect(checkClient('100.101.102.103', {}, netContext())).toEqual({ ok: false, reason: 'peer' })
    expect(checkClient('127.0.0.1', { 'x-forwarded-for': '100.101.102.103' }, netContext())).toEqual({ ok: false, reason: 'forwarded' })
    expect(checkClient('127.0.0.1', { 'tailscale-funnel-request': '?1' }, netContext())).toEqual({ ok: false, reason: 'funnel' })
  })
  it('serves this computer without Tailscale: no Funnel when Tailscale is absent', async () => {
    const none = { installed: false, readable: true, running: false, selfIps: [], peerIps: [], funnel: false }
    await refreshTailscale(async () => none, 3_000_000)
    expect(netContext(3_000_001).tailscale?.funnel).toBe(false)
    expect(checkClient('127.0.0.1', {}, netContext(3_000_001))).toEqual({ ok: true, zone: 'local' })
  })
  it('keeps a seen Funnel exposure when Tailscale’s binary or socket can no longer be found', async () => {
    const none = { installed: false, readable: true, running: false, selfIps: [], peerIps: [], funnel: false }
    const t0 = 5_000_000
    {
      resetNetworkStateForTests()
      await refreshTailscale(async () => ({ ...up, funnel: true }), t0)
      expect(checkClient('127.0.0.1', {}, netContext(t0 + 1000))).toEqual({ ok: false, reason: 'funnel' })
      // Discovery lost (tailscale updating, tailscaled restarting): unknown, still refused.
      await refreshTailscale(async () => none, t0 + 10_000)
      expect(netContext(t0 + 11_000).tailscale?.funnel).toBe(null)
      expect(checkClient('127.0.0.1', {}, netContext(t0 + 11_000))).toEqual({ ok: false, reason: 'funnel' })
      expect(checkClient('127.0.0.1', {}, netContext(t0 + 200_000))).toEqual({ ok: false, reason: 'funnel' })
      // Found again, with Funnel off: served.
      await refreshTailscale(async () => up, t0 + 210_000)
      expect(checkClient('127.0.0.1', {}, netContext(t0 + 211_000))).toEqual({ ok: true, zone: 'local' })
    }
  })
})

describe('Funnel configuration', () => {
  const host = 'box.example.ts.net'
  it('sees Funnel on wherdr’s port as HTTPS proxy, TCP forward and TLS-terminated TCP', () => {
    const web = { Web: { [`${host}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7683' } } } }, AllowFunnel: { [`${host}:443`]: true } }
    const tcp = { TCP: { 443: { TCPForward: '127.0.0.1:7683' } }, AllowFunnel: { [`${host}:443`]: true } }
    const tls = { TCP: { 8443: { TCPForward: 'localhost:7683', TerminateTLS: host } }, AllowFunnel: { [`${host}:8443`]: true } }
    const fg = { Foreground: { x: tcp } }
    for (const c of [web, tcp, tls, fg]) expect(funnelExposes(7683, JSON.stringify(c))).toBe(true)
  })
  it('counts any target that may reach wherdr’s port, whatever the host is spelled, and any target it cannot parse', () => {
    const tcpTo = (target: string) => JSON.stringify({ TCP: { 443: { TCPForward: target, TerminateTLS: host } }, AllowFunnel: { [`${host}:443`]: true } })
    for (const t of ['0.0.0.0:7683', '127.1:7683', '[::ffff:127.0.0.1]:7683', '192.168.1.2:7683', 'box:7683', 'tcp://127.0.0.1:7683', '7683', 'unix:/run/wherdr.sock', 'localhost', '']) {
      expect(funnelExposes(7683, tcpTo(t))).toBe(true)
    }
    const webTo = (proxy: string) => JSON.stringify({ Web: { [`${host}:443`]: { Handlers: { '/': { Proxy: proxy } } } }, AllowFunnel: { [`${host}:443`]: true } })
    for (const p of ['http://0.0.0.0:7683', 'https+insecure://[::1]:7683/x', 'http://wherdr.local:7683']) expect(funnelExposes(7683, webTo(p))).toBe(true)
    // Funnel on with nothing readable behind it.
    expect(funnelExposes(7683, JSON.stringify({ AllowFunnel: { [`${host}:443`]: true } }))).toBe(true)
  })
  it('reads the port of every target form', () => {
    expect(targetPort('0.0.0.0:7683')).toBe(7683)
    expect(targetPort('[::1]:7683')).toBe(7683)
    expect(targetPort('http://localhost:7683/path')).toBe(7683)
    expect(targetPort('https+insecure://host')).toBe(443)
    expect(targetPort('http://host')).toBe(80)
    expect(targetPort('7683')).toBe(7683)
    expect(targetPort('unix:/tmp/s')).toBe(null)
    expect(targetPort('localhost')).toBe(null)
  })
  it('does not count Serve without Funnel, nor Funnel on another port', () => {
    const serve = { Web: { [`${host}:7683`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7683' } } } }, TCP: { 7683: { HTTPS: true } } }
    const other = { TCP: { 443: { TCPForward: '127.0.0.1:3000' } }, AllowFunnel: { [`${host}:443`]: true } }
    expect(funnelExposes(7683, JSON.stringify(serve))).toBe(false)
    expect(funnelExposes(7683, JSON.stringify(other))).toBe(false)
    expect(funnelExposes(7683, 'garbage')).toBe(null)
  })
})

describe('client check', () => {
  it('accepts this computer and refuses the open network', () => {
    expect(checkClient('127.0.0.1', {}, ctx())).toEqual({ ok: true, zone: 'local' })
    expect(checkClient('::1', {}, ctx())).toEqual({ ok: true, zone: 'local' })
    for (const ip of ['192.168.1.20', '10.0.0.7', '203.0.113.9', '2001:db8::1', '', undefined]) {
      expect(checkClient(ip, {}, ctx())).toEqual({ ok: false, reason: 'peer' })
    }
  })
  it('cannot be widened by headers a client writes itself', () => {
    for (const h of [{ 'x-forwarded-for': '127.0.0.1' }, { forwarded: 'for=100.64.0.1' }, { 'x-real-ip': '::1' }, { host: 'localhost:7683' }]) {
      expect(checkClient('192.168.1.20', h, ctx())).toEqual({ ok: false, reason: 'peer' })
    }
  })
  it('refuses what a local proxy says comes from elsewhere', () => {
    expect(checkClient('127.0.0.1', { 'x-forwarded-for': '100.101.102.103' }, ctx())).toEqual({ ok: true, zone: 'tailnet' })
    expect(checkClient('127.0.0.1', { 'x-forwarded-for': '100.64.0.2' }, ctx())).toEqual({ ok: false, reason: 'forwarded' })
    expect(checkClient('127.0.0.1', { 'x-forwarded-for': '100.101.102.103, 203.0.113.9' }, ctx())).toEqual({ ok: false, reason: 'forwarded' })
    expect(checkClient('127.0.0.1', { 'x-forwarded-for': '203.0.113.9, 100.101.102.103' }, ctx())).toEqual({ ok: false, reason: 'forwarded' })
    expect(checkClient('127.0.0.1', { forwarded: 'for="[2001:db8::1]:4711";proto=https' }, ctx())).toEqual({ ok: false, reason: 'forwarded' })
    expect(checkClient('127.0.0.1', { forwarded: 'for=unknown' }, ctx())).toEqual({ ok: false, reason: 'forwarded' })
    expect(checkClient('127.0.0.1', { 'tailscale-funnel-request': '?1' }, ctx())).toEqual({ ok: false, reason: 'funnel' })
  })
  it('refuses every connection from this computer while Funnel exposes wherdr', () => {
    const f = ctx({ tailscale: { ...TS, funnel: true } })
    expect(checkClient('127.0.0.1', {}, f)).toEqual({ ok: false, reason: 'funnel' })
    expect(checkClient('127.0.0.1', { 'x-forwarded-for': '100.64.0.2' }, f)).toEqual({ ok: false, reason: 'funnel' })
    // Unknown: served.
    expect(checkClient('127.0.0.1', {}, ctx({ tailscale: { ...TS, funnel: null } }))).toEqual({ ok: true, zone: 'local' })
    // Seen earlier and not cleared by a valid reading: refused even when the latest reading failed.
    expect(checkClient('127.0.0.1', {}, ctx({ tailscale: null, funnelExposed: true }))).toEqual({ ok: false, reason: 'funnel' })
    expect(checkClient('127.0.0.1', {}, ctx({ tailscale: null }))).toEqual({ ok: true, zone: 'local' })
    // A tailnet peer connecting directly is still the tailnet.
    expect(checkClient('100.101.102.103', {}, f)).toEqual({ ok: true, zone: 'tailnet' })
  })
  it('accepts ranges the owner named, and everything with `any`', () => {
    expect(checkClient('10.147.17.9', {}, ctx({}, '10.147.17.0/24'))).toEqual({ ok: true, zone: 'trusted' })
    expect(checkClient('192.168.1.20', {}, ctx({}, 'any'))).toEqual({ ok: true, zone: 'open' })
    expect(checkClient('127.0.0.1', {}, ctx({ tailscale: { ...TS, funnel: true } }, 'any'))).toEqual({ ok: true, zone: 'open' })
  })
  it('collects every forwarded client', () => {
    expect(forwardedClients({ 'x-forwarded-for': 'a, b', 'forwarded': 'for=192.0.2.43:47011, for="[::1]"', 'x-real-ip': 'c' })).toEqual(['a', 'b', '192.0.2.43', '::1', 'c'])
  })
})

// passkey on/off × local/tailnet/trusted/open/refused × HTTP/WS, on the
// routes that matter. auth.disable itself needs an unlocked session (auth.ts).
// No network requires the passkey: it only locks the app once set up.
describe('gate matrix', () => {
  const checks = {
    local: checkClient('127.0.0.1', {}, ctx()),
    tailnet: checkClient('100.101.102.103', {}, ctx()),
    trusted: checkClient('10.147.17.9', {}, ctx({}, '10.147.17.0/24')),
    open: checkClient('192.168.1.20', {}, ctx({}, 'any')),
    lan: checkClient('192.168.1.20', {}, ctx()),
    funnel: checkClient('127.0.0.1', {}, ctx({ tailscale: { ...TS, funnel: true } })),
  } as const
  const served = ['local', 'tailnet', 'trusted', 'open'] as const
  const routes = ['/api/config', '/api/phone', '/api/update', '/api/auth/disable', '/'] as const
  const decide = (zone: keyof typeof checks, path: string, passkey: boolean, unlocked: boolean, ws = false) =>
    gateDecision({ check: checks[zone], unlocked: !passkey || unlocked, hostOk: true, crossSite: false, path, ws })

  it('without a passkey: every accepted network gets everything, Settings › Phone included', () => {
    for (const path of routes) {
      for (const z of served) expect(decide(z, path, false, false)).toBe('ok')
      expect(decide('lan', path, false, false)).toBe('network')
      expect(decide('funnel', path, false, false)).toBe('network')
    }
    for (const z of served) expect(decide(z, '/ws', false, false, true)).toBe('ok')
    expect(decide('lan', '/ws', false, false, true)).toBe('network')
    expect(decide('funnel', '/ws', false, false, true)).toBe('network')
  })
  it('with a passkey: an agent\'s screenshot upload with its task\'s key skips the lock, nothing else does', () => {
    const agent = (zone: keyof typeof checks, path: string, ws = false, crossSite = false) =>
      gateDecision({ check: checks[zone], unlocked: false, hostOk: true, crossSite, path, ws, agentKey: true })
    expect(agent('tailnet', '/api/pm/shot')).toBe('ok') // the route checks the key
    expect(agent('tailnet', '/api/config')).toBe('locked')
    expect(agent('tailnet', '/ws', true)).toBe('locked')
    expect(agent('lan', '/api/pm/shot')).toBe('network')
    expect(agent('tailnet', '/api/pm/shot', false, true)).toBe('origin')
  })
  it('with a passkey: every accepted network needs the unlocked session for the API and WebSockets', () => {
    for (const z of served) {
      for (const path of ['/api/config', '/api/phone', '/api/update']) {
        expect(decide(z, path, true, false)).toBe('locked')
        expect(decide(z, path, true, true)).toBe('ok')
      }
      // Photos and dictation files are behind the lock too.
      for (const path of ['/uploads/a.jpg', '/models/runtime/x.wasm']) expect(decide(z, path, true, false)).toBe('locked')
      // The lock screen's own routes and the app shell stay reachable.
      expect(decide(z, '/api/auth/disable', true, false)).toBe('ok')
      expect(decide(z, '/', true, false)).toBe('ok')
      expect(decide(z, '/ws', true, false, true)).toBe('locked')
      expect(decide(z, '/ws', true, true, true)).toBe('ok')
    }
    // An unlocked passkey never opens a refused network.
    for (const z of ['lan', 'funnel'] as const) {
      expect(decide(z, '/api/update', true, true)).toBe('network')
      expect(decide(z, '/', true, true)).toBe('network')
      expect(decide(z, '/ws', true, true, true)).toBe('network')
    }
  })
  it('keeps the Host, Origin and cross-site checks after the network one', () => {
    const base = { check: checks.local, unlocked: true, path: '/api/config' }
    expect(gateDecision({ ...base, hostOk: false, crossSite: false })).toBe('host')
    expect(gateDecision({ ...base, hostOk: true, crossSite: true })).toBe('origin')
    expect(gateDecision({ ...base, path: '/', hostOk: true, crossSite: true })).toBe('ok')
    expect(gateDecision({ ...base, path: '/ws', ws: true, hostOk: true, crossSite: true })).toBe('origin')
  })
})

describe('listening address', () => {
  const t = parseTrustedNetworks
  const up = () => ({ running: true, selfIps: ['100.90.1.2'] })
  it('accepts loopback, and a tailnet address only when Tailscale reports it as its own', () => {
    for (const h of ['127.0.0.1', '', 'localhost', '::1']) expect(listenVerdict(h, t(''), up)).toEqual({ ok: true })
    expect(listenVerdict('100.90.1.2', t(''), up)).toEqual({ ok: true })
    // eth0 in 100.64.0.0/10 without Tailscale, Tailscale stopped, or not its address.
    expect(listenVerdict('100.90.1.2', t(''), () => null).ok).toBe(false)
    expect(listenVerdict('100.90.1.2', t(''), () => ({ running: false, selfIps: ['100.90.1.2'] })).ok).toBe(false)
    expect(listenVerdict('100.90.1.3', t(''), up).ok).toBe(false)
  })
  it('refuses every interface or a LAN address unless the option says so', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.2']) {
      const v = listenVerdict(host, t(''), up)
      expect(!v.ok && v.message).toContain('WHERDR_TRUSTED_NETWORKS')
    }
    expect(listenVerdict('0.0.0.0', t('10.147.17.0/24'), up)).toMatchObject({ ok: true, warn: expect.stringContaining('10.147.17.0/24') })
    expect(listenVerdict('192.168.1.2', t('10.0.0.0/8'), up).ok).toBe(false)
    expect(listenVerdict('0.0.0.0', t('any'), up)).toMatchObject({ ok: true, warn: expect.stringContaining('ANY network') })
  })
})
