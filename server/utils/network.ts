// Who may talk to wherdr: this computer and the tailnet, nothing else unless
// the owner of the machine says so (WHERDR_TRUSTED_NETWORKS).
//
// The decision rests on the TCP peer of the connection (socket.remoteAddress),
// which a client cannot choose: a TCP connection only opens once the client
// has received the server's reply at the source address it claims.
// - Loopback (127.0.0.0/8, ::1): the kernel drops packets that arrive from a
//   network interface with a loopback source ("martian" packets).
// - Tailnet: an address in 100.64.0.0/10 or fd7a:115c:a1e0::/48 counts only
//   when Tailscale itself, running on this machine, lists it as one of its
//   peers or its own. Tailscale routes each peer's address into its encrypted
//   interface, so a reply to a forged peer address never goes back to the
//   Wi-Fi. An interface address in that range proves nothing (a LAN may use
//   it): Tailscale's state is read from Tailscale (CLI or its socket).
//   Only your own devices count: untagged peers of the same Tailscale user
//   as this machine (bin/lib/tailnet.mjs tailnetPeers). Any other peer
//   (another user's device in a team tailnet, a node shared in from another
//   tailnet, a sharee's or tagged node) is refused ('foreign') until the
//   owner sets up a passkey, which then locks it out.
// What a peer on this machine cannot prove: a relay running here (a reverse
// proxy, a TCP forward, `tailscale funnel`) connects from loopback like a
// local browser. wherdr reads Tailscale's serve configuration: once it shows
// that Funnel exposes wherdr's port, in any form (HTTPS proxy, TCP,
// TLS-terminated TCP), every connection from this machine is refused until
// a valid reading shows it gone (a failed or stale reading does not reopen).
// When Funnel was never seen, a failed or missing reading is served and the
// server log says Funnel cannot be checked.
// The passkey is never required by your own devices: it locks the app when
// the owner sets one up, wherever the device is. Any other relay the owner runs
// is indistinguishable from this computer: documented, with the passkey
// recommended as soon as the access is HTTPS.
//
// Proxy headers (X-Forwarded-For, Forwarded, X-Real-IP…) are read only when the
// peer is on this machine, and they can only refuse more: every address they
// name must be trusted too. A client that writes its own headers can only get
// itself refused (unless a relay here passes its headers on unchanged, which
// is the relay case above).
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { tailnetFacts, tailnetPeers, tailscaleBin } from '../../bin/lib/tailnet.mjs'

export type NetZone = 'local' | 'tailnet' | 'trusted' | 'open'
// peer: another network; forwarded: a proxy names a client from one;
// funnel: Tailscale Funnel exposes wherdr; foreign: a tailnet peer that is not
// one of your devices, without a passkey.
export type NetRefusal = 'peer' | 'forwarded' | 'funnel' | 'foreign'
export type NetCheck =
  | { ok: true, zone: NetZone }
  | { ok: false, reason: NetRefusal }

export interface TrustedNetworks {
  // WHERDR_TRUSTED_NETWORKS=any: every network accepted (warned at startup and in the app).
  any: boolean
  // Extra private ranges (ZeroTier, WireGuard…), as CIDRs or single addresses.
  list: net.BlockList
  entries: string[]
  // Entries that are not an address or a CIDR (reported at startup).
  invalid: string[]
}

// Tailscale as Tailscale reports it. funnel: Funnel exposes wherdr's port;
// null: unknown (served, warned at startup). peerIps: your own devices;
// otherIps: the other peers (bin/lib/tailnet.mjs tailnetPeers).
export interface TailscaleState { running: boolean, selfIps: string[], peerIps: string[], otherIps?: string[], funnel: boolean | null }

export interface NetContext {
  trusted: TrustedNetworks
  // null: nothing read yet (Funnel unknown, no tailnet peer known).
  tailscale: TailscaleState | null
  // Funnel was seen exposing wherdr and no valid reading has shown it gone
  // since (kept through failed and stale readings).
  funnelExposed?: boolean
  // Tailnet peers that are not yours, from the last valid reading (kept
  // through failed and stale ones: they only refuse more).
  otherIps?: string[]
  // A passkey is set up: the other peers are let through to the lock.
  passkey?: boolean
}

const LOOPBACK = new net.BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')
const TAILNET = new net.BlockList()
TAILNET.addSubnet('100.64.0.0', 10, 'ipv4')
TAILNET.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6')

// "::ffff:1.2.3.4" (IPv4 on a dual-stack socket) → "1.2.3.4"; scope ids dropped.
export function plainIp(value: string | undefined | null): string {
  const v = String(value || '').trim().replace(/^\[|\]$/g, '').replace(/%.+$/, '').toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v)
  return mapped ? mapped[1]! : v
}

function family(ip: string): 'ipv4' | 'ipv6' | null {
  const f = net.isIP(ip)
  return f === 4 ? 'ipv4' : f === 6 ? 'ipv6' : null
}

const inList = (list: net.BlockList, ip: string) => {
  const f = family(ip)
  return Boolean(f && list.check(ip, f))
}
export const isLoopbackIp = (ip: string) => inList(LOOPBACK, plainIp(ip))
export const isTailnetIp = (ip: string) => inList(TAILNET, plainIp(ip))
const sameIp = (a: string, b: string) => {
  const fa = family(a)
  if (!fa || fa !== family(b)) return false
  const one = new net.BlockList()
  one.addAddress(a, fa)
  return one.check(b, fa)
}

export function parseTrustedNetworks(value = process.env.WHERDR_TRUSTED_NETWORKS || ''): TrustedNetworks {
  const out: TrustedNetworks = { any: false, list: new net.BlockList(), entries: [], invalid: [] }
  for (const raw of value.split(',').map(s => s.trim()).filter(Boolean)) {
    if (/^(any|\*)$/i.test(raw)) { out.any = true; continue }
    const [addr, bits, extra] = raw.split('/')
    const ip = plainIp(addr)
    const f = family(ip)
    const max = f === 'ipv4' ? 32 : 128
    const prefix = bits === undefined ? max : /^\d+$/.test(bits) ? Number(bits) : -1
    if (!f || extra !== undefined || prefix < 0 || prefix > max) { out.invalid.push(raw); continue }
    out.list.addSubnet(ip, prefix, f)
    out.entries.push(bits === undefined ? ip : `${ip}/${prefix}`)
  }
  return out
}

// A tailnet address Tailscale itself vouches for: one of its peers or its own.
export function tailnetKnown(ip: string, ts: TailscaleState | null): boolean {
  const a = plainIp(ip)
  if (!ts?.running || !isTailnetIp(a)) return false
  return [...ts.selfIps, ...ts.peerIps].some(x => sameIp(plainIp(x), a))
}

// A tailnet address Tailscale lists as a peer that is not one of your devices.
export function tailnetOther(ip: string, ctx: NetContext): boolean {
  const a = plainIp(ip)
  if (!isTailnetIp(a) || tailnetKnown(a, ctx.tailscale)) return false
  return [...(ctx.tailscale?.otherIps || []), ...(ctx.otherIps || [])].some(x => sameIp(plainIp(x), a))
}

type Headers = Record<string, string | string[] | undefined>
const header = (h: Headers, name: string) => {
  const v = h[name]
  return Array.isArray(v) ? v.join(',') : v || ''
}

// Every client address a proxy put in the request (all hops, not only the
// last one: these headers can only refuse more).
export function forwardedClients(h: Headers): string[] {
  const out: string[] = []
  for (const part of header(h, 'x-forwarded-for').split(',')) if (part.trim()) out.push(part.trim())
  for (const element of header(h, 'forwarded').split(',')) {
    for (const pair of element.split(';')) {
      const m = /^\s*for\s*=\s*"?([^"]*)"?\s*$/i.exec(pair)
      // "[2001:db8::1]:4711" or "192.0.2.43:47011" → the address alone.
      if (m) out.push(m[1]!.replace(/^\[([^\]]+)\](:\d+)?$/, '$1').replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1'))
    }
  }
  for (const name of ['x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'fly-client-ip']) {
    const v = header(h, name).trim()
    if (v) out.push(v)
  }
  return out
}

// The zone of an address a local proxy names (`tailscale serve` names the
// tailnet client). These only restrict (the connection already comes from
// this machine). Without a passkey, a tailnet address counts only when
// Tailscale lists it as one of your devices, like a direct connection: a peer
// listed as not yours is 'foreign', one it does not list (a device that just
// joined, Tailscale unreadable) is refused. With a passkey, any tailnet
// client goes on to the lock.
function forwardedZone(ip: string, ctx: NetContext): NetZone | 'foreign' | null {
  const a = plainIp(ip)
  if (!family(a)) return ctx.trusted.any ? 'open' : null
  if (isLoopbackIp(a)) return 'local'
  if (isTailnetIp(a)) {
    if (ctx.passkey || tailnetKnown(a, ctx.tailscale)) return 'tailnet'
    return tailnetOther(a, ctx) ? 'foreign' : null
  }
  if (inList(ctx.trusted.list, a)) return 'trusted'
  return ctx.trusted.any ? 'open' : null
}

const RANK: Record<NetZone, number> = { local: 0, tailnet: 1, trusted: 2, open: 3 }

// The verdict for one connection: its TCP peer, then what a local proxy says.
export function checkClient(peer: string | undefined, h: Headers, ctx: NetContext): NetCheck {
  const any = ctx.trusted.any
  const p = plainIp(peer)
  if (!family(p)) return any ? { ok: true, zone: 'open' } : { ok: false, reason: 'peer' }
  let zone: NetZone = 'local'
  if (isLoopbackIp(p)) zone = 'local'
  else if (tailnetKnown(p, ctx.tailscale)) return { ok: true, zone: 'tailnet' }
  else if (tailnetOther(p, ctx)) return ctx.passkey ? { ok: true, zone: 'tailnet' } : { ok: false, reason: 'foreign' }
  else if (inList(ctx.trusted.list, p)) return { ok: true, zone: 'trusted' }
  else return any ? { ok: true, zone: 'open' } : { ok: false, reason: 'peer' }

  // From this machine: a local browser, or a relay running here. While Funnel
  // exposes wherdr's port, it may be the Internet: refused.
  if (header(h, 'tailscale-funnel-request') || ctx.tailscale?.funnel === true || ctx.funnelExposed) {
    if (!any) return { ok: false, reason: 'funnel' }
    zone = 'open'
  }
  for (const client of forwardedClients(h)) {
    const z = forwardedZone(client, ctx)
    if (!z) return { ok: false, reason: 'forwarded' }
    if (z === 'foreign') return { ok: false, reason: 'foreign' }
    if (RANK[z] > RANK[zone]) zone = z
  }
  return { ok: true, zone }
}

// ------------------------------------------------------------------ gate

export type GateVerdict = 'ok' | 'network' | 'host' | 'origin' | 'locked'
const needsUnlock = (p: string) => (p.startsWith('/api/') && !p.startsWith('/api/auth/') && p !== '/api/health') || p.startsWith('/uploads/') || p.startsWith('/models/')

// The whole guard decision for one request (server/middleware/guard.ts) or one
// WebSocket upgrade (server/utils/ws.ts), in order:
// 1. network: the provenance above (the passkey never stands in for it, and
//    no network requires it);
// 2. Host header; 3. cross-site requests (HTTP) or a foreign Origin (WS);
// 4. the passkey lock, once the owner set one up.
export function gateDecision(o: {
  check: NetCheck
  unlocked: boolean
  hostOk: boolean
  path: string
  // HTTP: Sec-Fetch-Site says another site; WS: the Origin differs from the host.
  crossSite: boolean
  ws?: boolean
  // An agent's upload with its task's key (POST /api/pm/shot): the route
  // checks the key, so the passkey session is not asked.
  agentKey?: boolean
}): GateVerdict {
  if (!o.check.ok) return 'network'
  if (!o.hostOk) return 'host'
  if (o.crossSite && (o.ws || o.path.startsWith('/api/'))) return 'origin'
  if ((o.ws || needsUnlock(o.path)) && !o.unlocked && !(o.agentKey && !o.ws && o.path === '/api/pm/shot')) return 'locked'
  return 'ok'
}

// ------------------------------------------------------------------ runtime

const TRUSTED = parseTrustedNetworks()
const PORT = Number(process.env.NITRO_PORT || process.env.PORT || 3000)
const REFRESH_MS = 10_000
// Past this age without a successful read, Tailscale's peers are not trusted.
const STALE_MS = 3 * REFRESH_MS

// The latest reading of Tailscale. A failed one replaces it too: what was true
// before is not known any more.
let ts: (TailscaleState & { at: number }) | null = null
// Funnel seen exposing wherdr; cleared only by a valid reading without it.
let funnelSeen = false
// The peers that are not yours, from the last valid reading.
let othersSeen: string[] = []
export type TailscaleReader = () => Promise<{ installed?: boolean, readable?: boolean, running: boolean, selfIps: string[], peerIps: string[], otherIps?: string[], funnel: boolean | null }>
const defaultReader: TailscaleReader = () => tailnetFacts(PORT)

// Called after every reading (server/utils/ws.ts closes the WebSockets the
// new state no longer allows).
const listeners = new Set<() => void>()
export function onNetworkReading(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn) }
const notify = () => { for (const fn of listeners) { try { fn() } catch { /* a listener's own problem */ } } }

// Readings overlap (the periodic one, HTTP and WebSocket checks): each gets
// a number when it starts, and a result older than the last one published is
// dropped, so a slow old reading never replaces a newer one (nor clears a
// Funnel exposure a newer reading saw).
let started = 0
let published = 0

// `now`: when the reading starts; it is dated from then.
export async function refreshTailscale(read: TailscaleReader = defaultReader, now = Date.now()) {
  const gen = ++started
  let f: Awaited<ReturnType<TailscaleReader>> | null = null
  try { f = await read() } catch { /* unknown: below */ }
  if (gen < published) return
  published = gen
  if (f) {
    // A temporarily missing Tailscale binary cannot clear a known exposure.
    const funnel = f.installed === false && funnelSeen ? null : f.funnel
    ts = { running: f.readable === false ? false : f.running, selfIps: f.selfIps, peerIps: f.peerIps, otherIps: f.otherIps || [], funnel, at: now }
    if (f.readable !== false && f.installed !== false && f.otherIps) othersSeen = f.otherIps
    // Only a valid reading changes what is known about Funnel.
    if (funnel !== null) {
      funnelSeen = funnel
    }
  } else {
    ts = { running: false, selfIps: [], peerIps: [], funnel: null, at: now }
  }
  notify()
}

// A reading started at most `maxAgeMs` ago, read now if needed (concurrent
// callers share one reading started late enough). HTTP requests accept 2 s;
// a WebSocket upgrade asks for a reading started after it arrived.
let inflight: { at: number, done: Promise<void> } | null = null
export async function ensureFresh(maxAgeMs: number, read: TailscaleReader = defaultReader, now = Date.now()) {
  if (ts && ts.at >= now - maxAgeMs) return
  if (inflight && inflight.at >= now - maxAgeMs) return inflight.done
  const at = Date.now()
  const done = refreshTailscale(read, at).finally(() => { if (inflight?.done === done) inflight = null })
  inflight = { at, done }
  return done
}

// HTTP requests (server/middleware/guard.ts): a reading started at most
// `freshMs` ago, else the current one while it is at most `blockMs` old, with
// a new reading started in the background for the next requests. Older, or
// none: the request waits for a new reading. Funnel traffic is still refused
// on each request by its own header (checkClient), whatever the reading's age.
export async function ensureRecent(freshMs: number, blockMs: number, read: TailscaleReader = defaultReader, now = Date.now()) {
  if (ts && ts.at >= now - freshMs) return
  const done = ensureFresh(freshMs, read, now)
  if (ts && ts.at >= now - blockMs) return
  return done
}

// Tests: forget what was read.
export function resetNetworkStateForTests() { ts = null; inflight = null; started = 0; published = 0; funnelSeen = false; othersSeen = [] }

export function netContext(now = Date.now()): NetContext {
  // Stale (no reading finished lately): nothing is known.
  const fresh = ts && now - ts.at < STALE_MS ? ts : null
  return {
    trusted: TRUSTED,
    tailscale: fresh ? { running: fresh.running, selfIps: fresh.selfIps, peerIps: fresh.peerIps, otherIps: fresh.otherIps, funnel: fresh.funnel } : null,
    ...(funnelSeen ? { funnelExposed: true } : {}),
    ...(othersSeen.length ? { otherIps: othersSeen } : {}),
  }
}
export const openNetworkMode = () => TRUSTED.any

let ready: Promise<void> | null = null
let timer: ReturnType<typeof setInterval> | null = null
let warnedFunnel: boolean | null = null
const warn = (text: string) => console.warn(`${new Date().toISOString()} WARNING: ${text}`)
async function refreshAll() {
  await refreshTailscale()
  const unknown = ts?.funnel === null
  if (unknown && warnedFunnel !== true) {
    warn('Tailscale\'s serve configuration cannot be read: wherdr cannot check whether Tailscale Funnel exposes it to the Internet.')
  }
  warnedFunnel = unknown
}
// Started once (server/plugins/network.ts); requests wait for the first read
// so as few as possible are judged on an unknown state.
export function startNetworkWatch() {
  if (ready) return ready
  // A slow Tailscale: requests wait up to 15 s, then are judged on what is
  // known (nothing yet: no tailnet peer, Funnel unknown).
  ready = Promise.race([refreshAll(), new Promise<void>(r => setTimeout(r, 15_000))])
  timer = setInterval(() => { void refreshAll() }, REFRESH_MS)
  timer.unref?.()
  return ready
}
export function stopNetworkWatch() { if (timer) clearInterval(timer); timer = null }
export const networkReady = () => ready ?? Promise.resolve()

// passkey: one is set up (auth.isEnabled()), which lets the tailnet peers
// that are not yours through to the lock.
export function checkRequestClient(socketPeer: string | undefined, h: Headers, passkey = false): NetCheck {
  return checkClient(socketPeer, h, { ...netContext(), passkey })
}

// ------------------------------------------------------------------ listening

export type ListenVerdict = { ok: true, warn?: string } | { ok: false, message: string }

// Tailscale's own addresses, read once at startup when HOST is in a tailnet
// range, with the CLI (null without one: such a HOST is then refused).
export function tailscaleSelfSync(bin = tailscaleBin()): { running: boolean, selfIps: string[] } | null {
  if (!bin) return null
  try {
    const p = tailnetPeers(execFileSync(bin, ['status', '--json'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }))
    return { running: p.running, selfIps: p.selfIps }
  } catch { return null }
}

// The address wherdr listens on (HOST), checked before it starts listening.
export function listenVerdict(host: string, trusted: TrustedNetworks, self: () => { running: boolean, selfIps: string[] } | null = tailscaleSelfSync): ListenVerdict {
  const h = plainIp(host || '127.0.0.1')
  const opt = 'WHERDR_TRUSTED_NETWORKS'
  const openWarn = `${opt}=any: wherdr accepts connections from ANY network, in plain HTTP. Anyone who can reach this machine can control your agents. Remove it unless the network is protected another way.`
  if (trusted.any) return { ok: true, warn: openWarn }
  if (h === 'localhost' || isLoopbackIp(h)) return { ok: true }
  if (isTailnetIp(h)) {
    const s = self()
    if (s?.running && s.selfIps.some(ip => sameIp(plainIp(ip), h))) return { ok: true }
  }
  const named = family(h) && (inList(trusted.list, h) || ((h === '0.0.0.0' || h === '::') && trusted.entries.length))
  if (named) {
    return { ok: true, warn: `Listening on ${h}: only this computer, the tailnet and ${trusted.entries.join(', ')} are accepted (${opt}).` }
  }
  return {
    ok: false,
    message: [
      `Refusing to listen on ${host}: wherdr would be reachable in plain HTTP by anyone on that network (a coffee shop Wi-Fi, an office LAN), and could control your agents.`,
      'Keep HOST=127.0.0.1 and reach it from your devices through Tailscale (`wherdr phone`, or Settings › Phone),',
      'or listen on this machine\'s tailnet address as Tailscale reports it (`tailscale ip`), with Tailscale running.',
      `For another private network (ZeroTier, WireGuard…), name its range: ${opt}=10.147.17.0/24 (comma-separated).`,
      `To accept any network anyway: ${opt}=any (not recommended).`,
    ].join('\n'),
  }
}

export const trustedNetworks = () => TRUSTED
