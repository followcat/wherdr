// The phone address: wherdr published on the tailnet by `tailscale serve`
// (private, only your devices). Reads Tailscale's state, publishes and
// unpublishes wherdr's port, and checks that the address really answers.
// Used by the server (Settings › Phone, server/utils/phone.ts) and by
// `wherdr phone` / `wherdr panel`. No dependency on the rest of bin/lib nor
// on packages: the server bundles this file.
import { execFile } from 'node:child_process'
import dns from 'node:dns'
import { existsSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export const LINKS = {
  download: 'https://tailscale.com/download',
  https: 'https://login.tailscale.com/admin/dns',
  operator: 'https://tailscale.com/kb/1242/tailscale-serve',
}

// The tailscale CLI: the macOS app's binary, Homebrew, system folders, then the PATH.
export function tailscaleBin(env = process.env, exists = existsSync) {
  const dirs = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', '/usr/bin/tailscale']
  for (const dir of (env.PATH || '').split(path.delimiter)) if (dir) dirs.push(path.join(dir, 'tailscale'))
  return dirs.find(p => exists(p)) || null
}

// The local read-only API is useful when the CLI is absent from PATH.
export const TAILSCALED_SOCKET = '/var/run/tailscale/tailscaled.sock'
export function tailscaledSocket(env = process.env, exists = existsSync) {
  const file = env.WHERDR_TAILSCALED_SOCKET || TAILSCALED_SOCKET
  return exists(file) ? file : null
}

// GET on Tailscale's local API → the body, '' on any failure.
function localApi(socketPath, route, timeoutMs = 4000) {
  const { promise, resolve } = Promise.withResolvers()
  const req = http.get({ socketPath, path: `/localapi/v0/${route}`, headers: { host: 'local-tailscaled.sock' }, timeout: timeoutMs }, (res) => {
    let text = ''
    res.setEncoding('utf8')
    res.on('data', (c) => { if (text.length < 1 << 20) text += c })
    res.on('end', () => resolve(res.statusCode === 200 ? text : ''))
    res.on('error', () => resolve(''))
  })
  req.on('timeout', () => req.destroy())
  req.on('error', () => resolve(''))
  return promise
}

// `tailscale status --json` → { name, connected, https }: this machine's
// tailnet name (machine.tailnet.ts.net) or null, whether Tailscale is up,
// and whether the tailnet issues HTTPS certificates.
export function tailnetStatus(statusJson) {
  let s = null
  try { s = JSON.parse(statusJson) } catch {}
  const dns = s?.Self?.DNSName
  return {
    name: typeof dns === 'string' && dns ? dns.replace(/\.$/, '') : null,
    connected: s?.BackendState === 'Running',
    https: Array.isArray(s?.CertDomains) && s.CertDomains.length > 0,
  }
}

// What wherdr's network check needs from `tailscale status --json` (with
// peers): whether the answer could be read at all, Tailscale's state, this
// machine's tailnet addresses and those of its peers. Read from Tailscale
// itself, never guessed from an interface address in 100.64.0.0/10.
// readable: false for an empty or broken answer (a failed command, a socket
// that did not answer): nothing is known then, not "stopped".
export function tailnetPeers(statusJson) {
  let s = null
  try { s = JSON.parse(statusJson) } catch {}
  const ips = node => (Array.isArray(node?.TailscaleIPs) ? node.TailscaleIPs.filter(ip => typeof ip === 'string') : [])
  const readable = Boolean(s && typeof s === 'object' && typeof s.BackendState === 'string')
  return {
    readable,
    state: readable ? s.BackendState : null,
    running: readable && s.BackendState === 'Running',
    selfIps: readable ? ips(s.Self) : [],
    peerIps: readable ? Object.values(s.Peer || {}).flatMap(ips) : [],
  }
}

// States in which tailscaled relays nothing, Funnel included.
const IDLE_STATES = new Set(['Stopped', 'NeedsLogin', 'NoState', 'NeedsMachineAuth'])

// The port a Serve or Funnel target leads to, or null when it cannot be told
// ("127.0.0.1:7683", "0.0.0.0:7683", "[::1]:7683", "http://localhost:7683/x",
// "https+insecure://host", "7683"…). The host is deliberately not compared:
// 0.0.0.0, another spelling of loopback, a LAN address of this machine or a
// name may all reach wherdr, so only the port can rule a target out.
export function targetPort(target) {
  const t = String(target ?? '').trim()
  if (/^\d{1,5}$/.test(t)) return Number(t)
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\[[^\]]*\]|[^/:\s]*)(?::(\d{1,5}))?(?:[/?#].*)?$/i.exec(t)
  if (!m || !m[2]) return null
  if (m[3]) return Number(m[3])
  const scheme = (m[1] || '').toLowerCase().replace(/\+insecure$/, '')
  return scheme === 'http' ? 80 : scheme === 'https' ? 443 : null
}

export function funnelExposes(port, serveJson) {
  let config = null
  try { config = JSON.parse(serveJson) } catch {}
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null
  const reaches = target => targetPort(target) === null || targetPort(target) === Number(port)
  for (const part of [config, ...Object.values(config.Foreground || {})]) {
    for (const [hostPort, on] of Object.entries(part?.AllowFunnel || {})) {
      if (!on) continue
      const tcpPort = hostPort.slice(hostPort.lastIndexOf(':') + 1)
      const tcp = part?.TCP?.[tcpPort]
      if (tcp?.TCPForward !== undefined && reaches(tcp.TCPForward)) return true
      const handlers = Object.values(part?.Web?.[hostPort]?.Handlers || {})
      if (handlers.some(h => h && typeof h === 'object' && h.Proxy !== undefined && reaches(h.Proxy))) return true
      // Funnel on a port with neither a TCP forward nor web handlers we can read.
      if (tcp?.TCPForward === undefined && !part?.Web?.[hostPort] && !tcp?.HTTPS && !tcp?.HTTP) return true
    }
  }
  return false
}

// Only a valid reading may prove the absence of Funnel on this port.
export async function tailnetFacts(port, bin = tailscaleBin(), socket = bin ? null : tailscaledSocket()) {
  if (!bin && !socket) return { installed: false, readable: true, running: false, selfIps: [], peerIps: [], funnel: false }
  // Serial reads at the old 8 s budget could not finish inside the client's
  // 6 s handshake patience: a wedged CLI looked like a refused upgrade. The
  // reads go out together, each bounded under that patience; a timed-out
  // call still reads as "unreadable" below. `serve` fires early and the
  // exits under it may not need it -- a cheap local query either way.
  const run = args => exec(bin, args, { encoding: 'utf8', timeout: 4500 }).then(r => r.stdout, () => '')
  const status = bin ? run(['status', '--json']) : localApi(socket, 'status')
  const serve = bin ? run(['serve', 'status', '--json']) : localApi(socket, 'serve-config').catch(() => '')
  const { state, ...peers } = tailnetPeers(await status)
  if (!peers.readable) return { installed: true, ...peers, funnel: null }
  if (IDLE_STATES.has(state)) return { installed: true, ...peers, funnel: false }
  return { installed: true, ...peers, funnel: funnelExposes(port, await serve) }
}

// The HTTPS entries of a serve configuration that proxy to wherdr's local
// port on this machine's own name: [{ hostPort, httpsPort, funnel }], or null
// when the configuration could not be read (Tailscale stopped, not JSON).
// Background entries (`--bg`) and those of a `tailscale serve` still running
// in a terminal (Foreground) both count. `funnel`: also open to the Internet.
function wherdrEntries(name, port, serveJson) {
  let config = null
  try { config = JSON.parse(serveJson) } catch {}
  if (!name || !config || typeof config !== 'object' || Array.isArray(config)) return null
  const target = new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${port}/?$`)
  const out = []
  for (const part of [config, ...Object.values(config.Foreground || {})]) {
    for (const [hostPort, entry] of Object.entries(part?.Web || {})) {
      const colon = hostPort.lastIndexOf(':')
      if (hostPort.slice(0, colon).toLowerCase() !== name.toLowerCase()) continue
      if (!Object.values(entry?.Handlers || {}).some(h => target.test(h?.Proxy || ''))) continue
      out.push({ hostPort, httpsPort: hostPort.slice(colon + 1), funnel: Boolean(part.AllowFunnel?.[hostPort]) })
    }
  }
  return out
}

const addressOf = (name, httpsPort) => `https://${name}${httpsPort === '443' ? '' : `:${httpsPort}`}/`

// Phone address: the `tailscale serve` entry whose proxy targets wherdr's
// local port (served on any HTTPS port), else the address publishing would
// give (same port) with served: false. Null without a tailnet name.
export function phoneAddress(name, port, serveJson) {
  if (!name) return null
  const entries = wherdrEntries(name, port, serveJson) || []
  const hit = entries.find(e => !e.funnel) || entries[0]
  if (hit) return { url: addressOf(name, hit.httpsPort), served: true, httpsPort: hit.httpsPort, ...(hit.funnel ? { funnel: true } : {}) }
  return { url: `https://${name}:${port}/`, served: false, httpsPort: String(port) }
}

// The addresses wherdr adopts by itself (server/utils/phone.ts): what
// `tailscale serve` publishes for its port on this machine's name, read from
// Tailscale, which only the owner of the machine configures. null: unknown
// (nothing is changed then); []: nothing is published. An address that
// `tailscale funnel` also opens to the Internet is never adopted.
export function servedAddresses(name, port, serveJson) {
  const entries = wherdrEntries(name, port, serveJson)
  return entries && entries.filter(e => !e.funnel).map(e => addressOf(name, e.httpsPort))
}

// HTTPS ports already published by `tailscale serve` (for anything).
export function servedPorts(serveJson) {
  try {
    const web = JSON.parse(serveJson || '{}')?.Web || {}
    return Object.keys(web).map(k => k.slice(k.lastIndexOf(':') + 1))
  } catch { return [] }
}

export const publishCommand = (port, httpsPort = port) => `tailscale serve --bg --https=${httpsPort} http://127.0.0.1:${port}`
export const publishArgs = port => ['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${port}`]
export const unpublishArgs = httpsPort => ['serve', `--https=${httpsPort}`, 'off']

// A failed `tailscale serve` → { code, link } for the known causes, else null.
// code: 'operator' (Linux: the user may not change Tailscale's settings),
// 'https' (no HTTPS certificates on the tailnet), 'offline' (not connected).
export function serveError(output) {
  const text = String(output || '')
  const link = /https:\/\/login\.tailscale\.com\/\S+/.exec(text)?.[0]
  if (/access denied|permission denied|--operator|not permitted/i.test(text)) return { code: 'operator', link: LINKS.operator }
  if (/https?\b.*(not enabled|disabled)|serve.*not enabled|enable https|certificates?.*(not enabled|disabled)|\/f\/serve/i.test(text)) return { code: 'https', link: link || LINKS.https }
  if (/needslogin|not logged in|logged out|tailscale is stopped|is tailscale running|not running|failed to connect to local tailscale/i.test(text)) return { code: 'offline', link: LINKS.download }
  return null
}

export async function inspect(port, bin = tailscaleBin(), socket = bin ? null : tailscaledSocket()) {
  if (!bin && !socket) return { installed: false }
  const run = args => exec(bin, args, { encoding: 'utf8', timeout: 8000 }).then(r => r.stdout, () => '')
  const status = tailnetStatus(bin ? await run(['status', '--json']) : await localApi(socket, 'status?peers=false'))
  const serve = !status.name ? '' : bin ? await run(['serve', 'status', '--json']) : await localApi(socket, 'serve-config')
  const phone = phoneAddress(status.name, port, serve)
  // Publishing on wherdr's port would replace whatever else is served there.
  const taken = Boolean(phone && !phone.served && servedPorts(serve).includes(String(port)))
  return { installed: true, bin, socket, ...status, phone, taken, served: servedAddresses(status.name, port, serve) }
}

const MAGIC_DNS = '100.100.100.100'

// The system's lookup, then MagicDNS for *.ts.net names.
function lookup(host, opts, cb) {
  dns.lookup(host, opts, (err, address, family) => {
    if (!err || !/\.ts\.net$/i.test(host)) return cb(err, address, family)
    const resolver = new dns.Resolver({ timeout: 3000, tries: 1 })
    resolver.setServers([MAGIC_DNS])
    resolver.resolve4(host, (e2, list) => {
      if (e2 || !list?.length) return cb(err)
      if (opts?.all) cb(null, list.map(a => ({ address: a, family: 4 })))
      else cb(null, list[0], 4)
    })
  })
}

// Does the phone address answer like wherdr? 'ok'; 'host' (wherdr answers but
// refuses the address: not in APP_URL yet); 'other' (something else answers:
// wherdr stopped, wrong port) or 'unreachable'.
export async function reachable(url, timeoutMs = 8000) {
  return (await probe(url, timeoutMs)).reach
}

// Why a request failed: 'dns' (name not found), 'refused', 'timeout', 'cert'
// (invalid certificate), 'tls' (no HTTPS on that port), or 'network'.
export function failureCause(err) {
  const code = String(err?.code || '')
  const msg = String(err?.message || '')
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return 'dns'
  if (code === 'ECONNREFUSED') return 'refused'
  if (code === 'ETIMEDOUT' || msg === 'timeout') return 'timeout'
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(code)) return 'cert'
  if (code === 'EPROTO' || /wrong version number|ssl3_get_record|packet length/i.test(msg)) return 'tls'
  return 'network'
}

// GET of `route` on the address → { status, text }, or { cause } when it failed.
function fetchText(url, route, timeoutMs) {
  const { promise, resolve } = Promise.withResolvers()
  let u
  try { u = new URL(route, url) } catch { return Promise.resolve({ cause: 'network' }) }
  // Accept JSON: a refused host then answers { code: 'host' }, not the HTML page.
  const req = https.get(u, { lookup, timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
    let text = ''
    res.setEncoding('utf8')
    res.on('data', (c) => { if (text.length < 65536) text += c })
    res.on('end', () => resolve({ status: res.statusCode || 0, text }))
    res.on('error', e => resolve({ cause: failureCause(e) }))
  })
  req.on('timeout', () => req.destroy(new Error('timeout')))
  req.on('error', e => resolve({ cause: failureCause(e) }))
  return promise
}

// What an answer of /api/health means: 'ok' (wherdr, and it accepts this
// address), 'host' (wherdr's host check refused it), or null: not a wherdr
// that has this route (versions up to 1.3.1, or another program).
export function healthReach(status, text) {
  if (status >= 200 && status < 300 && /"name"\s*:\s*"wherdr"/.test(text)) return 'ok'
  if (status === 403 && /"code"\s*:\s*"host"/.test(text)) return 'host'
  return null
}

// reachable() with the details: { reach, cause?, status? }: `cause` when
// unreachable (failureCause), `status` the HTTP code when something answered.
// /api/health is asked first: it goes through wherdr's host check, which the
// static manifest does not (it answers for any host name). The manifest only
// recognizes an older wherdr without that route.
export async function probe(url, timeoutMs = 8000) {
  const health = await fetchText(url, 'api/health', timeoutMs)
  if (health.cause) return { reach: 'unreachable', cause: health.cause }
  const reach = healthReach(health.status, health.text)
  if (reach) return { reach, status: health.status }
  const manifest = await fetchText(url, 'manifest.webmanifest', timeoutMs)
  if (manifest.cause) return { reach: 'unreachable', cause: manifest.cause }
  const ok = manifest.status >= 200 && manifest.status < 300 && manifest.text.includes('wherdr')
  return { reach: ok ? 'ok' : 'other', status: ok ? manifest.status : health.status }
}

// Runs `tailscale <args>` without a terminal → { code, output }. On a tailnet
// without HTTPS, `tailscale serve` prints a link and waits: the timeout ends it.
export function runTailscale(bin, args, timeoutMs = 30_000) {
  return exec(bin, args, { encoding: 'utf8', timeout: timeoutMs }).then(
    r => ({ code: 0, output: `${r.stdout}${r.stderr}` }),
    e => ({ code: typeof e.code === 'number' ? e.code : -1, output: `${e.stdout || ''}${e.stderr || ''}${e.message || ''}` }),
  )
}
